import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { createWorkspace } from '../src/workspace-create.js';
import { landWorkspace, WorkspaceLandError } from '../src/workspace-land.js';
import { removeWorkspace } from '../src/workspace-remove.js';
import { inspectWorkspaceStatus } from '../src/workspace-status.js';
import { formatWorkspaceList, formatWorkspaceListJson, listWorkspaces } from '../src/workspace-list.js';
import { readWorkspaceState, workspaceStatePath } from '../src/workspace-state.js';

type FixtureKind = 'basic' | 'conflict' | 'overlap';

type Fixture = {
	tempRoot: string;
	repository: string;
	upstreamBare: string;
	forkBare: string;
	workspace: string;
	laneRefs: string[];
};

function runGit(args: string[], cwd: string) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error([result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n'));
	}
	return result.stdout.trim();
}

function gitStatus(args: string[], cwd: string) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	return result.status ?? 1;
}

function configureUser(repository: string) {
	runGit(['config', 'user.name', 'Patchlane Test'], repository);
	runGit(['config', 'user.email', 'patchlane@example.test'], repository);
}

function commitFile(repository: string, relativePath: string, contents: string, message: string) {
	const file = path.join(repository, relativePath);
	writeFileSync(file, contents);
	runGit(['add', relativePath], repository);
	runGit(['commit', '-m', message], repository);
}

function writeConfig(repository: string, laneRefs: string[]) {
	writeFileSync(
		path.join(repository, '.patchlane.yml'),
		[
			'version: 1',
			'upstream: example/upstream',
			'source: branch:main',
			'baseBranch: main',
			'syncBranch: sync/integration',
			'patchRefs:',
			...laneRefs.map((ref) => `  - ${ref}`),
			'allowedWorkflows: []',
			'',
		].join('\n'),
	);
}

function createFixture(kind: FixtureKind): Fixture {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-workspace-'));
	const upstreamBare = path.join(tempRoot, 'upstream.git');
	const upstreamWork = path.join(tempRoot, 'upstream-work');
	const forkBare = path.join(tempRoot, 'fork.git');
	const repository = path.join(tempRoot, 'repository');
	const workspace = path.join(tempRoot, 'workspace');

	runGit(['init', '--bare', '--initial-branch=main', upstreamBare], tempRoot);
	runGit(['clone', upstreamBare, upstreamWork], tempRoot);
	configureUser(upstreamWork);
	if (kind === 'basic') commitFile(upstreamWork, 'README.md', 'upstream\n', 'Initial upstream commit');
	else commitFile(upstreamWork, 'shared.txt', 'header\nbase\nend\n', 'Initial upstream commit');
	const workflowDirectory = path.join(upstreamWork, '.github', 'workflows');
	mkdirSync(workflowDirectory, { recursive: true });
	writeFileSync(path.join(workflowDirectory, 'promote-tested-sync.yml'), 'name: Promote\n');
	writeFileSync(path.join(workflowDirectory, 'sync-upstream.yml'), 'name: Sync\n');
	runGit(['add', '.github/workflows'], upstreamWork);
	runGit(['commit', '-m', 'Add workflow fixtures'], upstreamWork);
	runGit(['push', 'origin', 'main'], upstreamWork);

	runGit(['init', '--bare', '--initial-branch=main', forkBare], tempRoot);
	runGit(['clone', upstreamBare, repository], tempRoot);
	configureUser(repository);
	runGit(['remote', 'rename', 'origin', 'upstream'], repository);
	runGit(['remote', 'add', 'origin', forkBare], repository);
	runGit(['push', 'origin', 'main'], repository);

	let laneRefs: string[];
	if (kind === 'basic') {
		laneRefs = ['patch/product'];
		runGit(['switch', '-c', 'patch/product', 'upstream/main'], repository);
		commitFile(repository, 'PRODUCT.md', 'product patch\n', 'Add product patch');
		runGit(['push', 'origin', 'patch/product'], repository);
	} else if (kind === 'overlap') {
		laneRefs = ['patch/first', 'patch/later'];
		runGit(['switch', '-c', 'patch/first', 'upstream/main'], repository);
		commitFile(repository, 'shared.txt', 'first\nbase\nend\n', 'Add first lane change');
		runGit(['push', 'origin', 'patch/first'], repository);
		runGit(['switch', '-c', 'patch/later', 'patch/first'], repository);
		commitFile(repository, 'shared.txt', 'first\nlater\nend\n', 'Add later lane change');
		runGit(['push', 'origin', 'patch/later'], repository);
	} else {
		laneRefs = ['patch/first', 'patch/conflict'];
		runGit(['switch', '-c', 'patch/first', 'upstream/main'], repository);
		commitFile(repository, 'shared.txt', 'header\nfirst\nend\n', 'Add first lane change');
		runGit(['push', 'origin', 'patch/first'], repository);
		runGit(['switch', '-c', 'patch/conflict', 'upstream/main'], repository);
		commitFile(repository, 'shared.txt', 'header\nconflict\nend\n', 'Add conflicting lane change');
		runGit(['push', 'origin', 'patch/conflict'], repository);
	}

	runGit(['switch', 'main'], repository);
	writeConfig(repository, laneRefs);
	runGit(['add', '.patchlane.yml'], repository);
	runGit(['commit', '-m', 'Configure Patchlane'], repository);
	runGit(['push', 'origin', 'main'], repository);

	return { tempRoot, repository, upstreamBare, forkBare, workspace, laneRefs };
}

function cleanup(fixture: Fixture) {
	rmSync(fixture.tempRoot, { force: true, recursive: true });
}

function commitWorkspaceChange(fixture: Fixture, contents: string, message: string) {
	writeFileSync(path.join(fixture.workspace, fixture.laneRefs.length === 1 ? 'PRODUCT.md' : 'shared.txt'), contents);
	runGit(['add', '.'], fixture.workspace);
	runGit(['commit', '-m', message], fixture.workspace);
}

test('creates, round-trips, lands, persists state, and removes a workspace', () => {
	const fixture = createFixture('basic');
	try {
		const created = createWorkspace({
			cwd: fixture.repository,
			lane: 'patch/product',
			path: fixture.workspace,
			name: 'product',
			upstreamRemoteUrl: fixture.upstreamBare,
		});
		expect(created.state).toMatchObject({
			id: 'product',
			branch: 'patchlane/work/product',
			targetLane: 'patch/product',
			laneOrder: ['patch/product'],
			landedLaneSha: null,
		});
		expect(existsSync(workspaceStatePath(fixture.repository, 'product'))).toBe(true);
		expect(readWorkspaceState(fixture.repository, 'product')).toMatchObject(created.state);
		const listed = listWorkspaces({ cwd: fixture.repository });
		expect(listed).toEqual([
			{
				id: 'product',
				path: created.state.path,
				branch: 'patchlane/work/product',
				targetLane: 'patch/product',
				createdAt: created.state.createdAt,
			},
		]);
		expect(formatWorkspaceList(listed)).toContain(`Path:        ${created.state.path}`);
		expect(JSON.parse(formatWorkspaceListJson(listed))).toEqual(listed);

		expect(inspectWorkspaceStatus({ cwd: fixture.workspace }).landingStatus).toBe('nothing_to_land');
		commitWorkspaceChange(fixture, 'product patch\nworkspace change\n', 'Change product patch');
		expect(inspectWorkspaceStatus({ cwd: fixture.workspace })).toMatchObject({
			commitsToLand: 1,
			workingTree: 'clean',
			landingStatus: 'ready',
		});

		const originalLaneSha = runGit(['rev-parse', 'refs/heads/patch/product'], fixture.repository);
		const dryRun = landWorkspace({ cwd: fixture.workspace, dryRun: true, upstreamRemoteUrl: fixture.upstreamBare });
		expect(dryRun).toMatchObject({
			status: 'dry_run',
			workspaceTree: dryRun.compositionTree,
			pushed: false,
		});
		expect(runGit(['rev-parse', 'refs/heads/patch/product'], fixture.repository)).toBe(originalLaneSha);
		expect(readWorkspaceState(fixture.repository, 'product').landedLaneSha).toBeNull();

		const landed = landWorkspace({ cwd: fixture.workspace, upstreamRemoteUrl: fixture.upstreamBare });
		expect(landed).toMatchObject({ status: 'landed', targetLane: 'patch/product', pushed: false });
		expect(runGit(['rev-parse', 'refs/heads/patch/product'], fixture.repository)).toBe(landed.candidateLaneSha);
		expect(readWorkspaceState(fixture.repository, 'product')).toMatchObject({
			landedLaneSha: landed.candidateLaneSha,
			landedWorkspaceHead: landed.workspaceHead,
			landedLane: 'patch/product',
			pushed: false,
		});

		const removed = removeWorkspace({ cwd: fixture.workspace });
		expect(removed).toMatchObject({ id: 'product', path: created.state.path, branch: 'patchlane/work/product' });
		expect(existsSync(fixture.workspace)).toBe(false);
		expect(existsSync(workspaceStatePath(fixture.repository, 'product'))).toBe(false);
		expect(
			gitStatus(['show-ref', '--verify', '--quiet', 'refs/heads/patchlane/work/product'], fixture.repository),
		).not.toBe(0);
	} finally {
		cleanup(fixture);
	}
});

test('rejects a workspace change that cannot be projected without moving lane refs', () => {
	const fixture = createFixture('overlap');
	try {
		createWorkspace({
			cwd: fixture.repository,
			lane: 'patch/first',
			path: fixture.workspace,
			name: 'overlap',
			upstreamRemoteUrl: fixture.upstreamBare,
		});
		commitWorkspaceChange(fixture, 'first\nworkspace\nend\n', 'Change the later lane output');
		const originalLaneSha = runGit(['rev-parse', 'refs/heads/patch/first'], fixture.repository);

		let caught: unknown;
		try {
			landWorkspace({ cwd: fixture.workspace, upstreamRemoteUrl: fixture.upstreamBare });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WorkspaceLandError);
		expect(caught).toMatchObject({ code: 'workspace_conflict' });
		expect(String(caught)).toContain('could not be projected');
		expect(runGit(['rev-parse', 'refs/heads/patch/first'], fixture.repository)).toBe(originalLaneSha);
		expect(readWorkspaceState(fixture.repository, 'overlap').landedLaneSha).toBeNull();
		expect(runGit(['for-each-ref', '--format=%(refname)', 'refs/patchlane/land/overlap'], fixture.repository)).toBe(
			'',
		);

		removeWorkspace({ cwd: fixture.workspace, force: true });
	} finally {
		cleanup(fixture);
	}
});

test('does not move a local lane when a pushed landing is rejected', () => {
	const fixture = createFixture('basic');
	try {
		createWorkspace({
			cwd: fixture.repository,
			lane: 'patch/product',
			path: fixture.workspace,
			name: 'push-failure',
			upstreamRemoteUrl: fixture.upstreamBare,
		});
		commitWorkspaceChange(fixture, 'product patch\nrejected push\n', 'Prepare rejected landing');
		const originalLaneSha = runGit(['rev-parse', 'refs/heads/patch/product'], fixture.repository);
		const receiveHook = path.join(fixture.forkBare, 'hooks', 'pre-receive');
		writeFileSync(receiveHook, '#!/bin/sh\nexit 1\n');
		chmodSync(receiveHook, 0o755);

		let caught: unknown;
		try {
			landWorkspace({
				cwd: fixture.workspace,
				push: true,
				upstreamRemoteUrl: fixture.upstreamBare,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WorkspaceLandError);
		expect(caught).toMatchObject({ code: 'push_failed' });
		expect(runGit(['rev-parse', 'refs/heads/patch/product'], fixture.repository)).toBe(originalLaneSha);
		expect(readWorkspaceState(fixture.repository, 'push-failure').landedLaneSha).toBeNull();
		expect(
			runGit(['for-each-ref', '--format=%(refname)', 'refs/patchlane/land/push-failure'], fixture.repository),
		).toBe('');

		removeWorkspace({ cwd: fixture.workspace, force: true });
	} finally {
		cleanup(fixture);
	}
});

test('cleans up a worktree when composition fails during creation', () => {
	const fixture = createFixture('conflict');
	try {
		expect(() =>
			createWorkspace({
				cwd: fixture.repository,
				lane: 'patch/first',
				path: fixture.workspace,
				name: 'conflict',
				upstreamRemoteUrl: fixture.upstreamBare,
			}),
		).toThrow(/Failed to replay commit|conflict/i);
		expect(existsSync(fixture.workspace)).toBe(false);
		expect(
			gitStatus(['show-ref', '--verify', '--quiet', 'refs/heads/patchlane/work/conflict'], fixture.repository),
		).not.toBe(0);
		expect(existsSync(workspaceStatePath(fixture.repository, 'conflict'))).toBe(false);
	} finally {
		cleanup(fixture);
	}
});
