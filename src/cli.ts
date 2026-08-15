#!/usr/bin/env node
import cac from 'cac';
import { installPatchlaneAgents } from './agents-install.js';
import { bootstrapPatchlane } from './bootstrap.js';
import { CompositionError } from './composition-errors.js';
import { loadPatchlaneConfig, NOTIFICATION_EVENTS, type NotificationEvent } from './config.js';
import { runDoctor } from './doctor.js';
import { initializePatchlane } from './init.js';
import { runIntegrationSync } from './integration-sync.js';
import { getPackageVersion } from './package-version.js';
import { runNotification } from './notify.js';
import { runPromoteSync } from './promote-sync.js';
import { parseUpstreamSource } from './upstream-source.js';
import { createWorkspace, formatWorkspaceCreateJson, formatWorkspaceCreateResult } from './workspace-create.js';
import { formatWorkspaceStatus, formatWorkspaceStatusJson, inspectWorkspaceStatus } from './workspace-status.js';
import { formatWorkspaceLand, formatWorkspaceLandJson, landWorkspace, WorkspaceLandError } from './workspace-land.js';
import { formatWorkspaceList, formatWorkspaceListJson, listWorkspaces } from './workspace-list.js';
import { formatWorkspaceRemove, formatWorkspaceRemoveJson, removeWorkspace } from './workspace-remove.js';

const cli = cac('patchlane');
cli.version(getPackageVersion());

let config: ReturnType<typeof loadPatchlaneConfig>;
if (['sync', 'promote', 'notify'].includes(process.argv[2] ?? '')) {
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

function workspaceError(error: unknown, json: boolean) {
	const message = error instanceof Error ? error.message : String(error);
	if (json) {
		const structured = error instanceof WorkspaceLandError || error instanceof CompositionError ? error : undefined;
		const details = structured?.details;
		process.stdout.write(
			`${JSON.stringify({ status: structured?.code ?? 'error', message, ...(details ? { ...details } : {}) }, null, 2)}\n`,
		);
	} else {
		process.stderr.write(`${message}\n`);
	}
	process.exitCode = 1;
}

cli.command('agents', 'Install or update Patchlane agent skills')
	.option('--dir <path>', 'Destination directory for installed skills', {
		default: env('PATCHLANE_AGENTS_DIR', '.agents/skills'),
	})
	.option('--ref <git-ref>', 'Patchlane git ref to pull skills from', {
		default: env('PATCHLANE_SKILLS_REF'),
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
	.option('--allowed-workflows <files>', 'Comma-separated repository workflow filenames')
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
				allowedWorkflows: args.allowedWorkflows,
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
	.option('--repository <owner/repo>', 'Fork GitHub repository; inferred from the origin push target')
	.option('--origin-remote-name <name>', 'Name of the origin remote', {
		default: env('ORIGIN_REMOTE_NAME', 'origin'),
	})
	.option('--ci-timeout <seconds>', 'Maximum time to wait for the CI run to appear', {
		default: env('PATCHLANE_CI_TIMEOUT_SECONDS'),
	})
	.option('--ci-poll-interval <seconds>', 'Interval between CI run lookups', {
		default: env('PATCHLANE_CI_POLL_INTERVAL_SECONDS'),
	})
	.action((args) => {
		void bootstrapPatchlane({
			publish: args.publish === true,
			wait: args.wait === true,
			repository: args.repository,
			originRemoteName: args.originRemoteName,
			ciTimeoutSeconds: args.ciTimeout === undefined ? undefined : Number(args.ciTimeout),
			ciPollIntervalSeconds: args.ciPollInterval === undefined ? undefined : Number(args.ciPollInterval),
		}).catch((error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		});
	});

cli.command('doctor', 'Check Patchlane configuration without changing repository state')
	.option('--json', 'Print a machine-readable report')
	.action((args) => {
		const report = runDoctor({ json: args.json === true });
		if (!report.ok) process.exitCode = 1;
	});

cli.command('workspace <action>', 'Create, list, inspect, land, or remove a composed Patchlane workspace')
	.option('--lane <ref>', 'Configured target lane or landing override')
	.option('--path <directory>', 'Destination worktree path')
	.option('--name <name>', 'Workspace identifier')
	.option('--source <source>', 'Override the configured upstream source')
	.option('--config-ref <ref>', 'Read .patchlane.yml from a Git ref')
	.option('--origin-remote-name <name>', 'Name of the origin remote', {
		default: env('ORIGIN_REMOTE_NAME', 'origin'),
	})
	.option('--upstream-remote-name <name>', 'Name of the upstream remote', {
		default: env('UPSTREAM_REMOTE_NAME', 'upstream'),
	})
	.option('--dry-run', 'Validate landing without updating lane refs')
	.option('--push', 'Push the updated lane with force-with-lease')
	.option('--force', 'Remove even when the workspace is dirty or has unlanded commits')
	.option('--json', 'Emit a machine-readable result')
	.action((action, args) => {
		try {
			if (action === 'create') {
				if (!args.lane) throw new Error('Error: --lane is required.');
				const result = createWorkspace({
					lane: args.lane,
					path: args.path,
					name: args.name,
					source: args.source,
					configRef: args.configRef,
					originRemoteName: args.originRemoteName,
					upstreamRemoteName: args.upstreamRemoteName,
					upstreamRemoteUrl: env('UPSTREAM_REMOTE_URL'),
				});
				process.stdout.write(
					`${args.json ? formatWorkspaceCreateJson(result) : formatWorkspaceCreateResult(result)}\n`,
				);
				return;
			}
			if (action === 'list') {
				const result = listWorkspaces();
				process.stdout.write(`${args.json ? formatWorkspaceListJson(result) : formatWorkspaceList(result)}\n`);
				return;
			}
			if (action === 'status') {
				const result = inspectWorkspaceStatus();
				process.stdout.write(
					`${args.json ? formatWorkspaceStatusJson(result) : formatWorkspaceStatus(result)}\n`,
				);
				return;
			}
			if (action === 'land') {
				const result = landWorkspace({
					lane: args.lane,
					dryRun: args.dryRun === true,
					push: args.push === true,
					originRemoteName: args.originRemoteName,
					upstreamRemoteName: args.upstreamRemoteName,
					upstreamRemoteUrl: env('UPSTREAM_REMOTE_URL'),
				});
				process.stdout.write(`${args.json ? formatWorkspaceLandJson(result) : formatWorkspaceLand(result)}\n`);
				return;
			}
			if (action === 'remove') {
				const result = removeWorkspace({ force: args.force === true });
				process.stdout.write(
					`${args.json ? formatWorkspaceRemoveJson(result) : formatWorkspaceRemove(result)}\n`,
				);
				return;
			}
			throw new Error(`Unknown workspace action '${action}'. Use create, list, status, land, or remove.`);
		} catch (error) {
			workspaceError(error, args.json === true);
		}
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
	.option('--skip-push', 'Build the sync branch locally but do not publish it')
	.option('--no-push', 'Legacy alias for --skip-push')
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
			allowedWorkflows: config?.allowedWorkflows,
			baseBranch: args.baseBranch,
			source: args.source,
			upstreamRef: args.upstreamRef,
			releaseSelector: args.releaseSelector,
			syncBranch: args.syncBranch,
			dryRun: args.dryRun === true || env('DRY_RUN') === 'true',
			noPush: args.skipPush === true || args.push === false || env('NO_PUSH') === 'true',
			forcePush: args.forcePush === true || env('FORCE_PUSH') === 'true',
			allowDependentPatches: args.allowDependentPatches === true,
			originRemoteName: args.originRemoteName,
			upstreamRemoteName: args.upstreamRemoteName,
			upstreamRemoteUrl: args.upstreamRemoteUrl,
		});
	});

cli.command('notify', 'Create, update, or close an automation failure issue')
	.option('--event <event>', 'Notification event: sync-failed, ci-failed, or promotion-failed')
	.option('--recovered', 'Close the open notification after recovery')
	.option('--repository <owner/repo>', 'Fork GitHub repository; inferred from the origin push target')
	.option('--origin-remote-name <name>', 'Name of the origin remote', {
		default: env('ORIGIN_REMOTE_NAME', 'origin'),
	})
	.option('--status <status>', 'Failure status', { default: env('PATCHLANE_STATUS') })
	.option('--run-url <url>', 'Workflow run URL', {
		default: env(
			'PATCHLANE_RUN_URL',
			process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
				? `${env('GITHUB_SERVER_URL', 'https://github.com')}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
				: undefined,
		),
	})
	.option('--upstream-source <source>', 'Configured upstream source', {
		default: env('UPSTREAM_SOURCE', config?.source),
	})
	.option('--upstream-sha <sha>', 'Resolved upstream SHA', { default: env('UPSTREAM_SHA') })
	.option('--sync-sha <sha>', 'Generated or tested sync SHA', { default: env('SYNC_SHA') })
	.option('--base-branch <branch>', 'Fork base branch', {
		default: env('BASE_BRANCH', config?.baseBranch),
	})
	.option('--sync-branch <branch>', 'Generated sync branch', {
		default: env('SYNC_BRANCH', config?.syncBranch),
	})
	.option('--failed-patch-ref <ref>', 'Failing patch ref', { default: env('FAILED_PATCH_REF') })
	.option('--failed-commit <sha>', 'Failing patch commit', { default: env('FAILED_COMMIT') })
	.option('--conflict-paths <paths>', 'Newline- or comma-delimited conflict paths', {
		default: env('CONFLICT_PATHS'),
	})
	.option('--applied-patch-refs <refs>', 'Newline- or comma-delimited applied patch refs', {
		default: env('APPLIED_PATCH_REFS'),
	})
	.action((args) => {
		if (!config) {
			process.stderr.write('Missing .patchlane.yml. Run `npx patchlane init` first.\n');
			process.exitCode = 1;
			return;
		}
		if (!NOTIFICATION_EVENTS.includes(args.event as NotificationEvent)) {
			process.stderr.write(`Invalid notification event '${String(args.event ?? '')}'.\n`);
			process.exitCode = 1;
			return;
		}
		const result = runNotification({
			config,
			event: args.event as NotificationEvent,
			recovered: args.recovered === true,
			repository: args.repository,
			originRemoteName: args.originRemoteName,
			status: args.status,
			runUrl: args.runUrl,
			upstreamSource: args.upstreamSource,
			upstreamSha: args.upstreamSha,
			syncSha: args.syncSha,
			baseBranch: args.baseBranch,
			syncBranch: args.syncBranch,
			failedPatchRef: args.failedPatchRef,
			failedCommit: args.failedCommit,
			conflictPaths: args.conflictPaths,
			appliedPatchRefs: args.appliedPatchRefs,
		});
		if (result.status !== 'failed') process.stdout.write(`Notification status: ${result.status}\n`);
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
			allowedWorkflows: config?.allowedWorkflows,
			baseBranch: args.baseBranch,
			syncBranch: args.syncBranch,
			originRemoteName: args.originRemoteName,
		});
	});

cli.help();
cli.parse(process.argv, { run: false });
await Promise.resolve(cli.runMatchedCommand());
