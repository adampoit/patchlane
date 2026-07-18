import { loadPatchlaneConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { runIntegrationSync } from './integration-sync.js';
import { runPromoteSync } from './promote-sync.js';
import { git, run } from './subprocess.js';

const DEFAULT_CI_TIMEOUT_SECONDS = 10 * 60;
const DEFAULT_CI_POLL_INTERVAL_SECONDS = 5;
const CI_PROGRESS_INTERVAL_MS = 60_000;

type BootstrapOptions = {
	publish?: boolean;
	wait?: boolean;
	ciTimeoutSeconds?: number;
	ciPollIntervalSeconds?: number;
	cwd?: string;
};

type WorkflowRun = {
	id?: unknown;
	name?: unknown;
	event?: unknown;
	head_branch?: unknown;
	head_sha?: unknown;
};

function delay(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveSeconds(value: number | undefined, fallback: number, name: string) {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved <= 0) {
		throw new Error(`${name} must be a positive number of seconds.`);
	}
	return resolved;
}

function publishedSyncSha(originRemoteName: string, syncBranch: string, cwd: string) {
	const ref = `refs/heads/${syncBranch}`;
	const result = git(['ls-remote', '--exit-code', originRemoteName, ref], cwd);
	const [sha, resolvedRef] = result.split(/\s+/);
	if (!sha || resolvedRef !== ref) {
		throw new Error(`Could not resolve published branch '${originRemoteName}/${syncBranch}'.`);
	}
	return sha;
}

function parseWorkflowRuns(stdout: string): WorkflowRun[] {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch {
		throw new Error('GitHub returned invalid JSON while looking for the CI run.');
	}
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!('workflow_runs' in payload) ||
		!Array.isArray(payload.workflow_runs)
	) {
		throw new Error('GitHub returned an invalid Actions runs response while looking for the CI run.');
	}
	return payload.workflow_runs as WorkflowRun[];
}

async function waitForCiRun(
	repository: string,
	ciWorkflow: string,
	syncBranch: string,
	syncSha: string,
	cwd: string,
	timeoutSeconds: number,
	pollIntervalSeconds: number,
) {
	const query = new URLSearchParams({
		head_sha: syncSha,
		branch: syncBranch,
		event: 'push',
		per_page: '100',
		exclude_pull_requests: 'true',
	});
	const endpoint = `repos/${repository}/actions/runs?${query}`;
	const timeoutMs = timeoutSeconds * 1_000;
	const pollIntervalMs = pollIntervalSeconds * 1_000;
	const startedAt = Date.now();
	let nextProgressAt = startedAt + CI_PROGRESS_INTERVAL_MS;
	let lastLookupError = '';

	while (true) {
		const result = run('gh', ['api', endpoint], cwd);
		if (result.status === 0) {
			lastLookupError = '';
			const matchingRun = parseWorkflowRuns(result.stdout).find(
				(workflowRun) =>
					workflowRun.name === ciWorkflow &&
					workflowRun.event === 'push' &&
					workflowRun.head_branch === syncBranch &&
					workflowRun.head_sha === syncSha &&
					(typeof workflowRun.id === 'number' || typeof workflowRun.id === 'string'),
			);
			if (matchingRun) return String(matchingRun.id);
		} else {
			lastLookupError = result.stderr || result.stdout || `gh api exited with status ${result.status}`;
		}

		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= timeoutMs) break;
		if (Date.now() >= nextProgressAt) {
			const elapsedSeconds = Math.floor(elapsedMs / 1_000);
			process.stdout.write(
				`Still waiting for '${ciWorkflow}' on ${syncBranch}@${syncSha} (${elapsedSeconds}s elapsed).\n`,
			);
			nextProgressAt += CI_PROGRESS_INTERVAL_MS;
		}
		await delay(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
	}

	const details = [
		`Timed out after ${timeoutSeconds} seconds waiting for '${ciWorkflow}' to start.`,
		`Repository: ${repository}`,
		`Branch: ${syncBranch}`,
		`Commit: ${syncSha}`,
		'Event: push',
		`Query: gh api '${endpoint}'`,
	];
	if (lastLookupError) details.push(`Last lookup error: ${lastLookupError}`);
	throw new Error(details.join('\n'));
}

export async function bootstrapPatchlane(options: BootstrapOptions = {}) {
	const cwd = options.cwd ?? process.cwd();
	const config = loadPatchlaneConfig(cwd);
	if (!config) throw new Error('Missing .patchlane.yml. Run `npx patchlane init` first.');

	const report = runDoctor({ cwd });
	if (!report.ok) throw new Error('Fix the Patchlane doctor errors before bootstrapping.');

	const originRemoteName = process.env.ORIGIN_REMOTE_NAME ?? 'origin';
	const syncOptions = {
		upstreamOwner: config.upstreamOwner,
		upstreamRepo: config.upstreamRepo,
		patchRefs: config.patchRefs.join(','),
		baseBranch: config.baseBranch,
		source: config.source,
		syncBranch: config.syncBranch,
		originRemoteName,
		upstreamRemoteName: process.env.UPSTREAM_REMOTE_NAME,
		upstreamRemoteUrl: process.env.UPSTREAM_REMOTE_URL,
	};

	process.stdout.write('Validating the initial Patchlane rebuild.\n');
	runIntegrationSync({ ...syncOptions, dryRun: true });
	if (!options.publish && !options.wait) {
		process.stdout.write('Bootstrap validation passed. Re-run with --publish to create the sync branch.\n');
		return { status: 'validated' as const };
	}

	process.stdout.write(`Publishing ${config.syncBranch} for CI.\n`);
	runIntegrationSync(syncOptions);
	const syncSha = publishedSyncSha(originRemoteName, config.syncBranch, cwd);
	if (!options.wait) {
		process.stdout.write(
			[
				`Published ${config.syncBranch}@${syncSha}.`,
				`After '${config.ciWorkflow ?? 'Fork CI'}' succeeds, run:`,
				`npx patchlane promote --expected-sync-sha=${syncSha}`,
			].join('\n') + '\n',
		);
		return { status: 'published' as const, syncSha };
	}

	const ciWorkflow = config.ciWorkflow;
	if (!ciWorkflow) throw new Error("Set 'ciWorkflow' in .patchlane.yml before using bootstrap --wait.");
	const timeoutSeconds = positiveSeconds(options.ciTimeoutSeconds, DEFAULT_CI_TIMEOUT_SECONDS, 'CI timeout');
	const pollIntervalSeconds = positiveSeconds(
		options.ciPollIntervalSeconds,
		DEFAULT_CI_POLL_INTERVAL_SECONDS,
		'CI poll interval',
	);
	const repositoryResult = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd);
	if (repositoryResult.status !== 0 || !repositoryResult.stdout) {
		throw new Error(
			`Could not determine the GitHub repository: ${repositoryResult.stderr || repositoryResult.stdout || 'unknown error'}`,
		);
	}
	const repository = repositoryResult.stdout;

	process.stdout.write(`Waiting for '${ciWorkflow}' to test ${syncSha}.\n`);
	const runId = await waitForCiRun(
		repository,
		ciWorkflow,
		config.syncBranch,
		syncSha,
		cwd,
		timeoutSeconds,
		pollIntervalSeconds,
	);
	const watch = run('gh', ['run', 'watch', runId, '--exit-status'], cwd);
	if (watch.stdout) process.stdout.write(`${watch.stdout}\n`);
	if (watch.stderr) process.stderr.write(`${watch.stderr}\n`);
	if (watch.status !== 0) throw new Error(`CI run ${runId} did not succeed; refusing to promote.`);

	runPromoteSync({
		expectedSyncSha: syncSha,
		baseBranch: config.baseBranch,
		syncBranch: config.syncBranch,
		originRemoteName,
	});
	return { status: 'promoted' as const, syncSha, runId };
}
