import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { withIsolatedGitConfig } from './git-environment.js';
import { loadPatchlaneConfig, loadPatchlaneConfigAtRef, type PatchlaneConfig } from './config.js';
import { resolveCompositionPlan, composeIntoWorktree, type CompositionPlan } from './composition.js';
import { git, gitResult, currentBranch, gitTopLevel } from './git.js';
import {
	parseWorkspaceState,
	writeWorkspaceState,
	type WorkspaceState,
	workspaceStatePath,
} from './workspace-state.js';

export type WorkspaceCreateOptions = {
	cwd?: string;
	lane: string;
	path?: string;
	name?: string;
	source?: string;
	configRef?: string;
	originRemoteName?: string;
	upstreamRemoteName?: string;
	upstreamRemoteUrl?: string;
};

export type WorkspaceCreateResult = {
	state: WorkspaceState;
	plan: CompositionPlan;
};

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

function configuredRef(cwd: string) {
	const branch = currentBranch(cwd);
	if (branch && gitResult(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], cwd).status === 0) {
		return branch;
	}
	return 'HEAD';
}

function defaultWorkspacePath(cwd: string, lane: string) {
	const root = gitTopLevel(cwd);
	const repositoryName = path.basename(root);
	const laneName = slug(lane.split('/').at(-1) ?? lane) || 'workspace';
	return path.resolve(path.dirname(root), `${repositoryName}-patch-${laneName}`);
}

function generatedWorkspaceId(lane: string, sourceSha: string) {
	return `${slug(lane.split('/').at(-1) ?? lane) || 'workspace'}-${sourceSha.slice(0, 6)}`;
}

function resolveDestination(cwd: string, requestedPath: string) {
	const requested = path.resolve(cwd, requestedPath);
	mkdirSync(path.dirname(requested), { recursive: true });
	return path.join(realpathSync(path.dirname(requested)), path.basename(requested));
}

function ensureDestinationAvailable(destination: string) {
	if (existsSync(destination)) throw new Error(`Workspace destination '${destination}' already exists.`);
}

function cleanUpWorkspace(cwd: string, destination: string, branch: string, id: string) {
	gitResult(['worktree', 'remove', '--force', destination], cwd, { allowFailure: true });
	rmSync(destination, { force: true, recursive: true });
	gitResult(['branch', '-D', branch], cwd, { allowFailure: true });
	gitResult(['config', '--unset', `branch.${branch}.patchlane-workspace`], cwd, { allowFailure: true });
	const statePath = workspaceStatePath(cwd, id);
	rmSync(statePath, { force: true });
}

function loadConfig(cwd: string, configRef: string | undefined): { config: PatchlaneConfig; ref: string } {
	if (configRef) return { config: loadPatchlaneConfigAtRef(cwd, configRef), ref: configRef };
	const config = loadPatchlaneConfig(cwd);
	if (!config) throw new Error('Missing .patchlane.yml. Run from a configured branch or pass --config-ref.');
	return { config, ref: configuredRef(cwd) };
}

function createWorkspaceInternal(options: WorkspaceCreateOptions): WorkspaceCreateResult {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	if (!options.lane || !options.lane.trim()) throw new Error('workspace create requires --lane <ref>.');
	const targetLane = options.lane.trim();
	const { config, ref: configRef } = loadConfig(cwd, options.configRef);
	const occurrences = config.patchRefs.filter((ref) => ref === targetLane).length;
	if (occurrences !== 1) {
		throw new Error(`Target lane '${targetLane}' must appear exactly once in .patchlane.yml patchRefs.`);
	}

	const originRemoteName = options.originRemoteName ?? process.env.ORIGIN_REMOTE_NAME ?? 'origin';
	const upstreamRemoteName = options.upstreamRemoteName ?? process.env.UPSTREAM_REMOTE_NAME ?? 'upstream';
	const plan = resolveCompositionPlan(config, {
		cwd,
		originRemoteName,
		upstreamRemoteName,
		upstreamRemoteUrl: options.upstreamRemoteUrl ?? process.env.UPSTREAM_REMOTE_URL,
		source: options.source,
	});
	const id = options.name?.trim() || generatedWorkspaceId(targetLane, plan.source.sha);
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		throw new Error(`Workspace name '${id}' must contain only lowercase letters, numbers, and hyphens.`);
	}
	const statePath = workspaceStatePath(cwd, id);
	if (existsSync(statePath)) throw new Error(`Patchlane workspace '${id}' is already registered.`);

	const destination = resolveDestination(cwd, options.path ?? defaultWorkspacePath(cwd, targetLane));
	ensureDestinationAvailable(destination);
	const branch = `patchlane/work/${id}`;
	if (gitResult(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd).status === 0) {
		throw new Error(`Workspace branch '${branch}' already exists.`);
	}

	let worktreeCreated = false;
	let branchCreated = false;
	try {
		git(['worktree', 'add', '--detach', destination, plan.source.sha], cwd);
		worktreeCreated = true;
		const composition = composeIntoWorktree(plan, { cwd: destination });
		git(['branch', branch, composition.headSha], cwd);
		branchCreated = true;
		git(['switch', branch], destination);
		git(['config', '--local', `branch.${branch}.patchlane-workspace`, id], cwd);

		const state: WorkspaceState = {
			version: 1,
			id,
			path: destination,
			branch,
			createdAt: new Date().toISOString(),
			configRef,
			originRemoteName,
			upstreamRemoteName,
			source: plan.source,
			targetLane,
			baselineCommit: composition.headSha,
			baselineTree: composition.treeSha,
			laneOrder: plan.lanes.map((lane) => lane.ref),
			laneTips: Object.fromEntries(plan.lanes.map((lane) => [lane.ref, lane.tipSha])),
			laneDiffBases: Object.fromEntries(plan.lanes.map((lane) => [lane.ref, lane.diffBaseSha])),
			landedLaneSha: null,
		};
		// Validate against the registered worktree before atomically publishing state.
		parseWorkspaceState(state, { cwd, requireRegisteredWorktree: true });
		writeWorkspaceState(state, cwd);
		return { state, plan };
	} catch (error) {
		if (worktreeCreated || branchCreated) cleanUpWorkspace(cwd, destination, branch, id);
		throw error;
	}
}

export function createWorkspace(options: WorkspaceCreateOptions): WorkspaceCreateResult {
	return withIsolatedGitConfig(() => createWorkspaceInternal(options));
}

export const runWorkspaceCreate = createWorkspace;

export function formatWorkspaceCreateResult(result: WorkspaceCreateResult) {
	const { state, plan } = result;
	return [
		'Created Patchlane workspace.',
		'',
		`Path:          ${state.path}`,
		`Branch:        ${state.branch}`,
		`Target lane:   ${state.targetLane}`,
		`Source:        ${plan.source.label} @ ${plan.source.sha.slice(0, 7)}`,
		`Baseline:      ${state.baselineCommit.slice(0, 7)}`,
		'Lane order:',
		...plan.lanes.map((lane, index) => `  ${index + 1}. ${lane.ref}`),
		'',
		'Work in the new directory and commit normally.',
		'Run `patchlane workspace land --dry-run` before landing.',
	].join('\n');
}

export function formatWorkspaceCreateJson(result: WorkspaceCreateResult) {
	return JSON.stringify(
		{
			...result.state,
			path: result.state.path,
			source: result.plan.source,
			lanes: result.plan.lanes,
		},
		null,
		2,
	);
}
