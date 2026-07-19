import { randomUUID } from 'node:crypto';
import { loadPatchlaneConfig } from './config.js';
import { resolveForkRepository } from './github-repository.js';
import { run } from './subprocess.js';

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 2;

type VerifyAuthOptions = {
	cwd?: string;
	repository?: string;
	originRemoteName?: string;
	timeoutSeconds?: number;
	pollIntervalSeconds?: number;
	verificationId?: string;
};

type WorkflowRun = {
	databaseId?: unknown;
	displayTitle?: unknown;
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

function parseRuns(stdout: string) {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch {
		throw new Error('GitHub returned invalid JSON while looking for the authentication check run.');
	}
	if (!Array.isArray(payload)) {
		throw new Error('GitHub returned an invalid workflow run list while checking authentication.');
	}
	return payload.flatMap((item) => {
		if (typeof item !== 'object' || item === null) return [];
		const { databaseId, displayTitle } = item as WorkflowRun;
		if ((typeof databaseId !== 'number' && typeof databaseId !== 'string') || typeof displayTitle !== 'string') {
			return [];
		}
		return [{ id: String(databaseId), displayTitle }];
	});
}

function listWorkflowRuns(repository: string, baseBranch: string, cwd: string) {
	const result = run(
		'gh',
		[
			'run',
			'list',
			'--repo',
			repository,
			'--workflow',
			'sync-upstream.yml',
			'--event',
			'workflow_dispatch',
			'--branch',
			baseBranch,
			'--limit',
			'20',
			'--json',
			'databaseId,displayTitle',
		],
		cwd,
	);
	if (result.status !== 0) {
		throw new Error(
			`Could not list Patchlane authentication check runs: ${result.stderr || result.stdout || 'unknown error'}`,
		);
	}
	return parseRuns(result.stdout);
}

export async function verifyGitHubAuth(options: VerifyAuthOptions = {}) {
	const cwd = options.cwd ?? process.cwd();
	const config = loadPatchlaneConfig(cwd);
	if (!config) throw new Error('Missing .patchlane.yml. Run `npx patchlane init` first.');

	const repository = resolveForkRepository({
		cwd,
		repository: options.repository,
		originRemoteName: options.originRemoteName ?? process.env.ORIGIN_REMOTE_NAME,
	});
	const timeoutSeconds = positiveSeconds(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 'Auth timeout');
	const pollIntervalSeconds = positiveSeconds(
		options.pollIntervalSeconds,
		DEFAULT_POLL_INTERVAL_SECONDS,
		'Auth poll interval',
	);
	const verificationId = options.verificationId ?? randomUUID();
	const expectedTitle = `Verify Patchlane authentication (${verificationId})`;
	process.stdout.write(`Dispatching the Patchlane authentication check in ${repository}.\n`);
	const dispatch = run(
		'gh',
		[
			'workflow',
			'run',
			'sync-upstream.yml',
			'--repo',
			repository,
			'--ref',
			config.baseBranch,
			'--field',
			'no_push=true',
			'--field',
			`verification_id=${verificationId}`,
		],
		cwd,
	);
	if (dispatch.status !== 0) {
		throw new Error(
			`Could not dispatch the Patchlane authentication check: ${dispatch.stderr || dispatch.stdout || 'unknown error'}`,
		);
	}

	const timeoutAt = Date.now() + timeoutSeconds * 1_000;
	let runId: string | undefined;
	while (!runId) {
		runId = listWorkflowRuns(repository, config.baseBranch, cwd).find(
			(workflowRun) => workflowRun.displayTitle === expectedTitle,
		)?.id;
		if (runId) break;
		const remaining = timeoutAt - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Timed out after ${timeoutSeconds} seconds waiting for the Patchlane authentication check run to appear.`,
			);
		}
		await delay(Math.min(pollIntervalSeconds * 1_000, remaining));
	}

	process.stdout.write(`Watching Patchlane authentication check run ${runId}.\n`);
	const watch = run('gh', ['run', 'watch', runId, '--repo', repository, '--exit-status'], cwd);
	if (watch.stdout) process.stdout.write(`${watch.stdout}\n`);
	if (watch.stderr) process.stderr.write(`${watch.stderr}\n`);
	if (watch.status !== 0) {
		throw new Error(`Patchlane authentication check run ${runId} failed.`);
	}
	process.stdout.write('Patchlane GitHub App authentication is ready.\n');
	return { status: 'verified' as const, repository, runId };
}
