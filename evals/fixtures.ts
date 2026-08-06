import {
	chmodSync,
	cpSync,
	existsSync,
	realpathSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cliPath, repoRoot } from './config.ts';
import type { CommandResult, EvalContext, MutationSnapshot, WorktreeSnapshot } from './types.ts';

export function command(
	commandName: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): CommandResult {
	const result = spawnSync(commandName, args, { cwd, env, encoding: 'utf8' });
	if (result.error) throw result.error;
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

export function checked(commandName: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
	const result = command(commandName, args, cwd, env);
	if (result.status !== 0) {
		throw new Error(
			[result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n') ||
				`${commandName} ${args.join(' ')} exited with ${result.status}`,
		);
	}
	return result.stdout.trim();
}

export function withValidationWorktree<T>(
	context: EvalContext,
	ref: string,
	callback: (cwd: string) => T,
): T | undefined {
	const worktreePath = mkdtempSync(path.join(context.root, 'eval-validation-'));
	const worktreeBranch = path.basename(worktreePath);
	rmSync(worktreePath, { recursive: true, force: true });
	const commit = command('git', ['rev-parse', ref], context.forkWork);
	if (commit.status !== 0) {
		return undefined;
	}
	const added = command(
		'git',
		['worktree', 'add', '-b', worktreeBranch, worktreePath, commit.stdout.trim()],
		context.forkWork,
	);
	if (added.status !== 0) {
		rmSync(worktreePath, { recursive: true, force: true });
		return undefined;
	}
	const originalUpstream = command('git', ['remote', 'get-url', 'upstream'], context.forkWork);
	if (originalUpstream.status === 0) {
		command('git', ['remote', 'set-url', 'upstream', context.upstreamRemoteUrl], context.forkWork);
	}
	try {
		return callback(worktreePath);
	} finally {
		if (originalUpstream.status === 0) {
			command('git', ['remote', 'set-url', 'upstream', originalUpstream.stdout.trim()], context.forkWork);
		}
		command('git', ['worktree', 'remove', '--force', worktreePath], context.forkWork);
		command('git', ['branch', '-D', worktreeBranch], context.forkWork);
		rmSync(worktreePath, { recursive: true, force: true });
	}
}

export function git(args: string[], cwd: string) {
	return checked('git', args, cwd);
}

export function writeText(filePath: string, contents: string) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
}

function configureUser(cwd: string) {
	git(['config', 'user.name', 'Patchlane Eval'], cwd);
	git(['config', 'user.email', 'patchlane-eval@example.test'], cwd);
}

function commit(cwd: string, message: string, ...files: string[]) {
	git(['add', ...files], cwd);
	git(['commit', '-m', message], cwd);
}

export function targetTip(forkBare: string, root: string, lane: string) {
	return checked('git', ['--git-dir', forkBare, 'rev-parse', `refs/heads/${lane}`], root);
}

export function optionalRef(cwd: string, ref: string) {
	const result = command('git', ['rev-parse', '--verify', '--quiet', ref], cwd);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function sortedRecord(values: Record<string, string>) {
	return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}

function refSnapshot(cwd: string, args: string[]) {
	const result = command('git', ['for-each-ref', '--format=%(refname) %(objectname)', ...args], cwd);
	if (result.status !== 0) return {};
	const refs: Record<string, string> = {};
	for (const line of result.stdout.split('\n')) {
		const separator = line.lastIndexOf(' ');
		if (separator <= 0) continue;
		refs[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return sortedRecord(refs);
}

function bareRefSnapshot(forkBare: string) {
	const result = command(
		'git',
		['--git-dir', forkBare, 'for-each-ref', '--format=%(refname) %(objectname)'],
		forkBare,
	);
	if (result.status !== 0) return {};
	const refs: Record<string, string> = {};
	for (const line of result.stdout.split('\n')) {
		const separator = line.lastIndexOf(' ');
		if (separator <= 0) continue;
		refs[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return sortedRecord(refs);
}

function remoteSnapshot(cwd: string) {
	const remotes: Record<string, string[]> = {};
	const listed = command('git', ['remote'], cwd);
	if (listed.status !== 0) return remotes;
	for (const name of listed.stdout
		.split('\n')
		.map((value) => value.trim())
		.filter(Boolean)) {
		const urls = command('git', ['remote', 'get-url', '--all', name], cwd);
		remotes[name] =
			urls.status === 0
				? urls.stdout
						.split('\n')
						.map((value) => value.trim())
						.filter(Boolean)
				: [];
	}
	return Object.fromEntries(
		Object.entries(remotes)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, urls]) => [name, [...urls].sort()]),
	);
}

function fileSnapshot(cwd: string) {
	const result = command('git', ['ls-files', '--cached', '--others', '-z'], cwd);
	if (result.status !== 0) return {};
	const files: Record<string, string> = {};
	for (const file of result.stdout.split('\0').filter(Boolean).sort()) {
		const filePath = path.join(cwd, file);
		try {
			files[file] = createHash('sha256').update(readFileSync(filePath)).digest('hex');
		} catch {
			files[file] = '<missing>';
		}
	}
	return sortedRecord(files);
}

function gitConfigSnapshot(cwd: string) {
	const result = command('git', ['config', '--local', '--null', '--list'], cwd);
	if (result.status !== 0) return {};
	const config: Record<string, string[]> = {};
	for (const entry of result.stdout.split('\0').filter(Boolean)) {
		const separator = entry.indexOf('\n');
		const key = separator === -1 ? entry : entry.slice(0, separator);
		const value = separator === -1 ? '' : entry.slice(separator + 1);
		(config[key] ??= []).push(value);
	}
	return Object.fromEntries(
		Object.entries(config)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, values]) => [key, [...values].sort()]),
	);
}

function worktreeSnapshot(cwd: string) {
	const result = command('git', ['worktree', 'list', '--porcelain'], cwd);
	if (result.status !== 0) return { worktrees: [] as WorktreeSnapshot[], statuses: {} as Record<string, string> };
	const worktrees: WorktreeSnapshot[] = [];
	const statuses: Record<string, string> = {};
	for (const block of result.stdout.split(/\n\s*\n/)) {
		const worktree = block.match(/^worktree (.+)$/m)?.[1];
		if (!worktree) continue;
		const head = block.match(/^HEAD ([0-9a-f]+)$/m)?.[1];
		const branchRef = block.match(/^branch (.+)$/m)?.[1];
		const status = command('git', ['status', '--porcelain'], worktree);
		const porcelain = status.status === 0 ? status.stdout : `<status:${status.status}>`;
		worktrees.push({ path: worktree, head, branch: branchRef?.replace(/^refs\/heads\//, ''), status: porcelain });
		statuses[worktree] = porcelain;
	}
	worktrees.sort((left, right) => left.path.localeCompare(right.path));
	return { worktrees, statuses: sortedRecord(statuses) };
}

function workspaceStateSnapshot(cwd: string) {
	const commonDirResult = command('git', ['rev-parse', '--git-common-dir'], cwd);
	if (commonDirResult.status !== 0) return {};
	const commonDir = path.resolve(cwd, commonDirResult.stdout.trim());
	const directory = path.join(commonDir, 'patchlane', 'workspaces');
	if (!existsSync(directory)) return {};
	const states: Record<string, string> = {};
	for (const file of readdirSync(directory).sort()) {
		const filePath = path.join(directory, file);
		try {
			states[file] = createHash('sha256').update(readFileSync(filePath)).digest('hex');
		} catch {
			states[file] = '<missing>';
		}
	}
	return sortedRecord(states);
}

export function snapshotFixture(
	context: EvalContext,
	metadata: Pick<MutationSnapshot, 'phase' | 'turn'> = {},
): MutationSnapshot {
	const worktrees = worktreeSnapshot(context.forkWork);
	const sourceFiles = fileSnapshot(context.forkWork);
	const files = { ...sourceFiles };
	let normalizedForkWork = context.forkWork;
	try {
		normalizedForkWork = realpathSync(context.forkWork);
	} catch {
		// Keep the lexical path if the worktree disappeared during cleanup.
	}
	for (const worktree of worktrees.worktrees) {
		let normalizedWorktree = worktree.path;
		try {
			normalizedWorktree = realpathSync(worktree.path);
		} catch {
			// Status snapshots still retain the worktree path for diagnosis.
		}
		if (normalizedWorktree === normalizedForkWork) continue;
		for (const [file, hash] of Object.entries(fileSnapshot(worktree.path))) {
			files[`${worktree.path}:${file}`] = hash;
		}
	}
	return {
		capturedAt: new Date().toISOString(),
		...metadata,
		refs: refSnapshot(context.forkWork, []),
		remoteRefs: bareRefSnapshot(context.forkBare),
		remotes: remoteSnapshot(context.forkWork),
		gitConfig: gitConfigSnapshot(context.forkWork),
		sourceFiles,
		files: sortedRecord(files),
		worktrees: worktrees.worktrees,
		worktreeStatus: worktrees.statuses,
		workspaceState: workspaceStateSnapshot(context.forkWork),
	};
}

function stateWithoutMetadata(snapshot: MutationSnapshot) {
	return {
		refs: snapshot.refs,
		remoteRefs: snapshot.remoteRefs,
		remotes: snapshot.remotes,
		gitConfig: snapshot.gitConfig,
		sourceFiles: snapshot.sourceFiles,
		files: snapshot.files,
		worktrees: snapshot.worktrees,
		worktreeStatus: snapshot.worktreeStatus,
		workspaceState: snapshot.workspaceState,
	};
}

export function sameMutationState(left: MutationSnapshot, right: MutationSnapshot) {
	return JSON.stringify(stateWithoutMetadata(left)) === JSON.stringify(stateWithoutMetadata(right));
}

function createNpxShim(directory: string) {
	const realNpx = checked('sh', ['-c', 'command -v npx'], directory);
	const shim = path.join(directory, 'npx');
	writeText(
		shim,
		`#!/bin/sh
case "$1" in
  patchlane|patchlane@*)
    shift
    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"
    ;;
  *)
    exec ${JSON.stringify(realNpx)} "$@"
    ;;
esac
`,
	);
	chmodSync(shim, 0o755);

	const patchlane = path.join(directory, 'patchlane');
	writeText(
		patchlane,
		`#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"
`,
	);
	chmodSync(patchlane, 0o755);
}

export function createFixture(options: { existingProductPatch?: boolean } = {}): EvalContext {
	const root = mkdtempSync(path.join(tmpdir(), 'patchlane-skill-eval-'));
	const upstreamBare = path.join(root, 'upstream.git');
	const upstreamWork = path.join(root, 'upstream-work');
	const forkBare = path.join(root, 'fork.git');
	const forkWork = path.join(root, 'fork-work');
	const bin = path.join(root, 'bin');

	try {
		checked('git', ['init', '--bare', '--initial-branch=main', upstreamBare], root);
		checked('git', ['clone', upstreamBare, upstreamWork], root);
		configureUser(upstreamWork);
		writeText(path.join(upstreamWork, 'README.md'), '# Evaluation upstream\n');
		writeText(path.join(upstreamWork, 'app.js'), "export function feature() {\n\treturn 'base feature';\n}\n");
		commit(upstreamWork, 'Initial upstream', 'README.md', 'app.js');
		git(['push', 'origin', 'main'], upstreamWork);

		checked('git', ['init', '--bare', '--initial-branch=main', forkBare], root);
		checked('git', ['clone', upstreamBare, forkWork], root);
		configureUser(forkWork);
		git(['remote', 'rename', 'origin', 'upstream'], forkWork);
		git(['remote', 'add', 'origin', forkBare], forkWork);
		git(['push', 'origin', 'main'], forkWork);

		git(['switch', '-c', 'patch/sync', 'upstream/main'], forkWork);
		const config = [
			'version: 1',
			'upstream: example/upstream',
			'source: branch:main',
			'baseBranch: main',
			'syncBranch: sync/integration',
			'patchRefs:',
			'  - patch/sync',
			'  - patch/product',
			'ciWorkflow: Fork CI',
			'allowedWorkflows:',
			'  - fork-ci.yml',
			'',
		].join('\n');
		writeText(path.join(forkWork, '.patchlane.yml'), config);
		writeText(
			path.join(forkWork, '.github/workflows/fork-ci.yml'),
			'name: Fork CI\non:\n  push:\n    branches: [main, sync/integration]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps: []\n',
		);
		writeText(
			path.join(forkWork, '.github/workflows/sync-upstream.yml'),
			'name: Sync Upstream\non: workflow_dispatch\n',
		);
		writeText(
			path.join(forkWork, '.github/workflows/promote-tested-sync.yml'),
			'name: Promote Tested Sync\non: workflow_dispatch\n',
		);
		cpSync(path.join(repoRoot, 'skills'), path.join(forkWork, '.agents/skills'), { recursive: true });
		commit(
			forkWork,
			'Configure Patchlane and install skills',
			'.patchlane.yml',
			'.github/workflows',
			'.agents/skills',
		);
		git(['push', 'origin', 'patch/sync'], forkWork);

		git(['switch', '-c', 'patch/product', 'upstream/main'], forkWork);
		if (options.existingProductPatch !== false) {
			writeText(path.join(forkWork, 'PRODUCT.md'), 'Existing product patch\n');
			commit(forkWork, 'Add existing product patch', 'PRODUCT.md');
		}
		git(['push', 'origin', 'patch/product'], forkWork);
		git(['switch', 'patch/sync'], forkWork);
		git(['fetch', '--prune', 'origin'], forkWork);

		mkdirSync(bin, { recursive: true });
		createNpxShim(bin);
		const targetLane = 'patch/product';
		const targetLaneBefore = targetTip(forkBare, root, targetLane);
		return {
			root,
			forkWork,
			forkBare,
			upstreamRemoteUrl: upstreamBare,
			cwd: forkWork,
			targetLane,
			targetLaneBefore,
			targetLaneLocalBefore: optionalRef(forkWork, `refs/heads/${targetLane}`),
			sourceLaneBefore: optionalRef(forkWork, 'refs/heads/patch/sync'),
			cleanup: () => rmSync(root, { force: true, recursive: true }),
		};
	} catch (error) {
		rmSync(root, { force: true, recursive: true });
		throw error;
	}
}

export function createSetupFixture(): EvalContext {
	const root = mkdtempSync(path.join(tmpdir(), 'patchlane-setup-eval-'));
	const upstreamBare = path.join(root, 'upstream.git');
	const upstreamWork = path.join(root, 'upstream-work');
	const forkBare = path.join(root, 'fork.git');
	const forkWork = path.join(root, 'fork-work');
	const bin = path.join(root, 'bin');

	try {
		checked('git', ['init', '--bare', '--initial-branch=main', upstreamBare], root);
		checked('git', ['clone', upstreamBare, upstreamWork], root);
		configureUser(upstreamWork);
		writeText(path.join(upstreamWork, 'README.md'), '# Evaluation upstream\n');
		commit(upstreamWork, 'Initial upstream', 'README.md');
		git(['push', 'origin', 'main'], upstreamWork);

		checked('git', ['init', '--bare', '--initial-branch=main', forkBare], root);
		checked('git', ['clone', upstreamBare, forkWork], root);
		configureUser(forkWork);
		git(['remote', 'rename', 'origin', 'upstream'], forkWork);
		git(['remote', 'add', 'origin', forkBare], forkWork);
		writeText(
			path.join(forkWork, '.github/workflows/ci.yml'),
			'name: CI\non:\n  push:\n    branches: [main]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps: []\n',
		);
		writeText(path.join(forkWork, 'FORK.md'), 'Existing fork customization\n');
		commit(forkWork, 'Add existing fork customization', '.github/workflows/ci.yml', 'FORK.md');
		git(['push', 'origin', 'main'], forkWork);

		mkdirSync(bin, { recursive: true });
		createNpxShim(bin);
		const targetLane = 'main';
		const targetLaneBefore = targetTip(forkBare, root, targetLane);
		return {
			root,
			forkWork,
			forkBare,
			upstreamRemoteUrl: upstreamBare,
			cwd: forkWork,
			targetLane,
			targetLaneBefore,
			targetLaneLocalBefore: optionalRef(forkWork, `refs/heads/${targetLane}`),
			sourceLaneBefore: optionalRef(forkWork, `refs/heads/${targetLane}`),
			cleanup: () => rmSync(root, { force: true, recursive: true }),
		};
	} catch (error) {
		rmSync(root, { force: true, recursive: true });
		throw error;
	}
}

export function createSyncConflictFixture(): EvalContext {
	const root = mkdtempSync(path.join(tmpdir(), 'patchlane-sync-eval-'));
	const upstreamBare = path.join(root, 'upstream.git');
	const upstreamWork = path.join(root, 'upstream-work');
	const forkBare = path.join(root, 'fork.git');
	const forkWork = path.join(root, 'fork-work');
	const bin = path.join(root, 'bin');

	try {
		checked('git', ['init', '--bare', '--initial-branch=main', upstreamBare], root);
		checked('git', ['clone', upstreamBare, upstreamWork], root);
		configureUser(upstreamWork);
		writeText(path.join(upstreamWork, 'README.md'), '# Evaluation upstream\n');
		writeText(path.join(upstreamWork, '.github/workflows/gen.yml'), 'name: Upstream workflow v1\n');
		commit(upstreamWork, 'Initial upstream with workflow', 'README.md', '.github/workflows/gen.yml');
		git(['push', 'origin', 'main'], upstreamWork);

		checked('git', ['init', '--bare', '--initial-branch=main', forkBare], root);
		checked('git', ['clone', upstreamBare, forkWork], root);
		configureUser(forkWork);
		git(['remote', 'rename', 'origin', 'upstream'], forkWork);
		git(['remote', 'add', 'origin', forkBare], forkWork);
		git(['push', 'origin', 'main'], forkWork);

		git(['switch', '-c', 'patch/sync', 'upstream/main'], forkWork);
		writeText(
			path.join(forkWork, '.patchlane.yml'),
			[
				'version: 1',
				'upstream: example/upstream',
				'source: branch:main',
				'baseBranch: main',
				'syncBranch: sync/integration',
				'patchRefs:',
				'  - patch/sync',
				'  - patch/fork-ci',
				'ciWorkflow: Fork CI',
				'allowedWorkflows:',
				'  - fork-ci.yml',
				'',
			].join('\n'),
		);
		writeText(
			path.join(forkWork, '.github/workflows/sync-upstream.yml'),
			[
				'name: Sync Upstream Integration',
				'on:',
				'  workflow_dispatch:',
				'',
				'jobs:',
				'  fork-sync:',
				'    runs-on: ubuntu-latest',
				'    steps:',
				'      - id: patchlane-token',
				'        uses: actions/create-github-app-token@v3',
				'        with:',
				'          client-id: ${{ vars.PATCHLANE_APP_CLIENT_ID }}',
				'          private-key: ${{ secrets.PATCHLANE_APP_PRIVATE_KEY }}',
				'          permission-contents: write',
				'          permission-workflows: write',
				'      - uses: actions/checkout@v4',
				'        with:',
				'          token: ${{ steps.patchlane-token.outputs.token }}',
				'      - run: npx patchlane sync',
				'        env:',
				'          GH_TOKEN: ${{ steps.patchlane-token.outputs.token }}',
				'',
			].join('\n'),
		);
		writeText(
			path.join(forkWork, '.github/workflows/promote-tested-sync.yml'),
			[
				'name: Promote Tested Sync Branch',
				'on:',
				'  workflow_run:',
				'    workflows: ["Fork CI"]',
				'    types: [completed]',
				'',
				'jobs:',
				'  promote:',
				'    runs-on: ubuntu-latest',
				'    steps:',
				'      - id: patchlane-token',
				'        uses: actions/create-github-app-token@v3',
				'        with:',
				'          client-id: ${{ vars.PATCHLANE_APP_CLIENT_ID }}',
				'          private-key: ${{ secrets.PATCHLANE_APP_PRIVATE_KEY }}',
				'          permission-contents: write',
				'          permission-workflows: write',
				'      - uses: actions/checkout@v4',
				'        with:',
				'          token: ${{ steps.patchlane-token.outputs.token }}',
				'      - run: npx patchlane promote',
				'        env:',
				'          GH_TOKEN: ${{ steps.patchlane-token.outputs.token }}',
				'',
			].join('\n'),
		);
		cpSync(path.join(repoRoot, 'skills'), path.join(forkWork, '.agents/skills'), { recursive: true });
		commit(
			forkWork,
			'Configure Patchlane and install skills',
			'.patchlane.yml',
			'.github/workflows',
			'.agents/skills',
		);
		git(['push', 'origin', 'patch/sync'], forkWork);

		git(['switch', '-c', 'patch/fork-ci', 'upstream/main'], forkWork);
		git(['rm', '.github/workflows/gen.yml'], forkWork);
		writeText(
			path.join(forkWork, '.github/workflows/fork-ci.yml'),
			'name: Fork CI\non:\n  push:\n    branches: [main, sync/integration]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps: []\n',
		);
		commit(forkWork, 'Maintain fork-specific CI', '.github/workflows');
		git(['push', 'origin', 'patch/fork-ci'], forkWork);

		// Advance upstream after the deletion patch was created. Replaying that patch
		// now produces the modify/delete conflict this scenario is meant to exercise.
		writeText(path.join(upstreamWork, '.github/workflows/gen.yml'), 'name: Upstream workflow v2\n');
		commit(upstreamWork, 'Update upstream workflow', '.github/workflows/gen.yml');
		git(['push', 'origin', 'main'], upstreamWork);
		git(['switch', 'patch/sync'], forkWork);
		git(['fetch', '--prune', 'origin'], forkWork);

		mkdirSync(bin, { recursive: true });
		createNpxShim(bin);
		const targetLane = 'patch/fork-ci';
		const targetLaneBefore = targetTip(forkBare, root, targetLane);
		return {
			root,
			forkWork,
			forkBare,
			upstreamRemoteUrl: upstreamBare,
			cwd: forkWork,
			targetLane,
			targetLaneBefore,
			targetLaneLocalBefore: optionalRef(forkWork, `refs/heads/${targetLane}`),
			sourceLaneBefore: optionalRef(forkWork, 'refs/heads/patch/sync'),
			cleanup: () => rmSync(root, { force: true, recursive: true }),
		};
	} catch (error) {
		rmSync(root, { force: true, recursive: true });
		throw error;
	}
}

export function stateFiles(context: EvalContext) {
	const commonDir = path.resolve(context.forkWork, git(['rev-parse', '--git-common-dir'], context.forkWork));
	const directory = path.join(commonDir, 'patchlane', 'workspaces');
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((file) => file.endsWith('.json'))
		.map(
			(file) =>
				JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as {
					path: string;
					baselineCommit: string;
				},
		);
}
