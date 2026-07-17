#!/usr/bin/env node
import cac from 'cac';
import { installPatchlaneAgents } from './agents-install.js';
import { bootstrapPatchlane } from './bootstrap.js';
import { loadPatchlaneConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { initializePatchlane } from './init.js';
import { runIntegrationSync } from './integration-sync.js';
import { runPromoteSync } from './promote-sync.js';
import { parseUpstreamSource } from './upstream-source.js';

const cli = cac('patchlane');

let config: ReturnType<typeof loadPatchlaneConfig>;
if (['sync', 'promote'].includes(process.argv[2] ?? '')) {
	try {
		config = loadPatchlaneConfig();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}

function env(name: string, fallback?: string) {
	return process.env[name] || fallback;
}

cli.command('agents', 'Install or update Patchlane agent skills')
	.option('--dir <path>', 'Destination directory for installed skills', {
		default: env('PATCHLANE_AGENTS_DIR', '.agents/skills'),
	})
	.option('--ref <git-ref>', 'Patchlane git ref to pull skills from', {
		default: env('PATCHLANE_SKILLS_REF', 'main'),
	})
	.action((args) => {
		void installPatchlaneAgents({
			installDir: args.dir,
			ref: args.ref,
		}).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${message}\n`);
			process.exit(1);
		});
	});

cli.command('init', 'Create Patchlane config and workflow files')
	.option('--upstream <owner/repo>', 'Upstream GitHub repository; inferred from the upstream remote')
	.option('--source <source>', 'Upstream source', { default: 'release:latest' })
	.option('--patch-refs <refs>', 'Comma-separated patch branches', { default: 'patch/sync,patch/ci' })
	.option('--base-branch <branch>', 'Fork branch promoted later', { default: 'main' })
	.option('--sync-branch <branch>', 'Published generated branch name', { default: 'sync/integration' })
	.option('--ci-workflow <name>', 'Existing CI workflow name used by workflow_run')
	.option('--force', 'Replace existing Patchlane config and workflow files')
	.action((args) => {
		try {
			initializePatchlane({
				upstream: args.upstream,
				source: args.source,
				patchRefs: args.patchRefs,
				baseBranch: args.baseBranch,
				syncBranch: args.syncBranch,
				ciWorkflow: args.ciWorkflow,
				force: args.force === true,
			});
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		}
	});

cli.command('bootstrap', 'Validate and publish the first generated sync branch')
	.option('--publish', 'Publish the generated sync branch after validation')
	.option('--wait', 'Publish, wait for CI, and perform the initial promotion')
	.action((args) => {
		void bootstrapPatchlane({ publish: args.publish === true, wait: args.wait === true }).catch(
			(error: unknown) => {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exit(1);
			},
		);
	});

cli.command('doctor', 'Check Patchlane configuration without changing repository state')
	.option('--json', 'Print a machine-readable report')
	.action((args) => {
		const report = runDoctor({ json: args.json === true });
		if (!report.ok) process.exitCode = 1;
	});

cli.command('sync', 'Rebuild integration branch from upstream and patches')
	.option('--upstream-owner <owner>', 'GitHub owner/org of the upstream repository', {
		default: env('UPSTREAM_OWNER', config?.upstreamOwner),
	})
	.option('--upstream-repo <repo>', 'Upstream repository name', {
		default: env('UPSTREAM_REPO', config?.upstreamRepo),
	})
	.option('--patch-refs <refs>', 'Comma- or newline-delimited patch branches', {
		default: env('PATCH_REFS', config?.patchRefs.join(',')),
	})
	.option('--base-branch <branch>', 'Fork branch promoted later', {
		default: env('BASE_BRANCH', config?.baseBranch ?? 'main'),
	})
	.option('--source <source>', 'Upstream source: release:latest, release:<regex>, or branch:<ref>', {
		default: env('UPSTREAM_SOURCE', config?.source),
	})
	.option('--upstream-ref <ref>', 'Legacy branch source; prefer --source=branch:<ref>', {
		default: env('UPSTREAM_REF'),
	})
	.option('--release-selector <selector>', 'Legacy release selector; prefer --source=release:<selector>', {
		default: env('RELEASE_SELECTOR'),
	})
	.option('--sync-branch <branch>', 'Published generated branch name', {
		default: env('SYNC_BRANCH', config?.syncBranch ?? 'sync/integration'),
	})
	.option('--dry-run', 'Validate patches without creating the sync branch')
	.option('--no-push', 'Build the sync branch locally but do not push')
	.option('--force-push', 'Push the sync branch even if it appears unchanged')
	.option('--allow-dependent-patches', 'Allow patch refs that depend on generated sync output')
	.option('--origin-remote-name <name>', 'Name of the origin remote', {
		default: env('ORIGIN_REMOTE_NAME', 'origin'),
	})
	.option('--upstream-remote-name <name>', 'Name of the upstream remote', {
		default: env('UPSTREAM_REMOTE_NAME', 'upstream'),
	})
	.option('--upstream-remote-url <url>', 'URL of the upstream remote', {
		default: env('UPSTREAM_REMOTE_URL'),
	})
	.action((args) => {
		if (!args.upstreamOwner) {
			cli.outputHelp();
			process.stderr.write('Error: --upstream-owner is required\n');
			process.exit(1);
		}
		if (!args.upstreamRepo) {
			cli.outputHelp();
			process.stderr.write('Error: --upstream-repo is required\n');
			process.exit(1);
		}
		if (!args.patchRefs) {
			cli.outputHelp();
			process.stderr.write('Error: --patch-refs is required\n');
			process.exit(1);
		}
		if (!args.source && !args.upstreamRef && !args.releaseSelector) {
			cli.outputHelp();
			process.stderr.write(
				'Error: --source is required (for example, --source=release:latest or --source=branch:main)\n',
			);
			process.exit(1);
		}
		if (args.source) {
			try {
				parseUpstreamSource(args.source);
			} catch (error) {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exit(1);
			}
		}

		runIntegrationSync({
			upstreamOwner: args.upstreamOwner,
			upstreamRepo: args.upstreamRepo,
			patchRefs: args.patchRefs,
			baseBranch: args.baseBranch,
			source: args.source,
			upstreamRef: args.upstreamRef,
			releaseSelector: args.releaseSelector,
			syncBranch: args.syncBranch,
			dryRun: args.dryRun === true || env('DRY_RUN') === 'true',
			noPush: args.push === false || env('NO_PUSH') === 'true',
			forcePush: args.forcePush === true || env('FORCE_PUSH') === 'true',
			allowDependentPatches: args.allowDependentPatches === true,
			originRemoteName: args.originRemoteName,
			upstreamRemoteName: args.upstreamRemoteName,
			upstreamRemoteUrl: args.upstreamRemoteUrl,
		});
	});

cli.command('promote', 'Promote tested sync branch onto base branch')
	.option('--expected-sync-sha <sha>', 'Tested commit SHA', {
		default: env('EXPECTED_SYNC_SHA'),
	})
	.option('--base-branch <branch>', 'Fork branch to promote to', {
		default: env('BASE_BRANCH', config?.baseBranch ?? 'main'),
	})
	.option('--sync-branch <branch>', 'Generated sync branch that passed CI', {
		default: env('SYNC_BRANCH', config?.syncBranch ?? 'sync/integration'),
	})
	.option('--origin-remote-name <name>', 'Name of the origin remote', {
		default: env('ORIGIN_REMOTE_NAME', 'origin'),
	})
	.action((args) => {
		if (!args.expectedSyncSha) {
			cli.outputHelp();
			process.stderr.write('Error: --expected-sync-sha is required\n');
			process.exit(1);
		}

		runPromoteSync({
			expectedSyncSha: args.expectedSyncSha,
			baseBranch: args.baseBranch,
			syncBranch: args.syncBranch,
			originRemoteName: args.originRemoteName,
		});
	});

cli.help();
cli.parse(process.argv, { run: false });
await Promise.resolve(cli.runMatchedCommand());
