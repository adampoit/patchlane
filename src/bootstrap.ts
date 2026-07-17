import { spawnSync } from 'node:child_process';
import { loadPatchlaneConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { runIntegrationSync } from './integration-sync.js';
import { runPromoteSync } from './promote-sync.js';

type BootstrapOptions = {
	publish?: boolean;
	wait?: boolean;
	cwd?: string;
};

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function git(args: string[], cwd: string) {
	const result = run('git', args, cwd);
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
	return result.stdout;
}

function delay(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCiRun(ciWorkflow: string, syncBranch: string, syncSha: string, cwd: string) {
	for (let attempt = 0; attempt < 24; attempt++) {
		const result = run(
			'gh',
			[
				'run',
				'list',
				'--workflow',
				ciWorkflow,
				'--branch',
				syncBranch,
				'--commit',
				syncSha,
				'--limit',
				'1',
				'--json',
				'databaseId',
				'--jq',
				'.[0].databaseId',
			],
			cwd,
		);
		if (result.status === 0 && result.stdout) return result.stdout;
		await delay(5_000);
	}
	throw new Error(`Timed out waiting for '${ciWorkflow}' to start for ${syncSha}.`);
}

export async function bootstrapPatchlane(options: BootstrapOptions = {}) {
	const cwd = options.cwd ?? process.cwd();
	const config = loadPatchlaneConfig(cwd);
	if (!config) throw new Error('Missing .patchlane.yml. Run `npx patchlane init` first.');

	const report = runDoctor({ cwd });
	if (!report.ok) throw new Error('Fix the Patchlane doctor errors before bootstrapping.');

	const syncOptions = {
		upstreamOwner: config.upstreamOwner,
		upstreamRepo: config.upstreamRepo,
		patchRefs: config.patchRefs.join(','),
		baseBranch: config.baseBranch,
		source: config.source,
		syncBranch: config.syncBranch,
		originRemoteName: process.env.ORIGIN_REMOTE_NAME,
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
	const syncSha = git(['rev-parse', config.syncBranch], cwd);
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
	process.stdout.write(`Waiting for '${ciWorkflow}' to test ${syncSha}.\n`);
	const runId = await waitForCiRun(ciWorkflow, config.syncBranch, syncSha, cwd);
	const watch = run('gh', ['run', 'watch', runId, '--exit-status'], cwd);
	if (watch.stdout) process.stdout.write(`${watch.stdout}\n`);
	if (watch.stderr) process.stderr.write(`${watch.stderr}\n`);
	if (watch.status !== 0) throw new Error(`CI run ${runId} did not succeed; refusing to promote.`);

	runPromoteSync({
		expectedSyncSha: syncSha,
		baseBranch: config.baseBranch,
		syncBranch: config.syncBranch,
	});
	return { status: 'promoted' as const, syncSha, runId };
}
