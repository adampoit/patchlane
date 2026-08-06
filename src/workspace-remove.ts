import { rmSync } from 'node:fs';
import { findWorkspaceState, workspaceStatePath } from './workspace-state.js';
import { gitResult, listWorktrees } from './git.js';
import { inspectWorkspaceStatus } from './workspace-status.js';

export type WorkspaceRemoveOptions = {
	cwd?: string;
	force?: boolean;
};

export type WorkspaceRemoveResult = {
	id: string;
	path: string;
	branch: string;
};

export function removeWorkspace(options: WorkspaceRemoveOptions = {}): WorkspaceRemoveResult {
	const cwd = options.cwd ?? process.cwd();
	const state = findWorkspaceState(cwd);
	const stateFile = workspaceStatePath(cwd, state.id);
	const repositoryCwd =
		listWorktrees(cwd).find((worktree) => worktree.path !== state.path && !worktree.bare)?.path ?? cwd;
	const status = inspectWorkspaceStatus({ cwd, state });
	const unlanded =
		status.commitsToLand > 0 && (!state.landedWorkspaceHead || state.landedWorkspaceHead !== status.workspaceHead);
	if (!options.force && (status.workingTree === 'dirty' || unlanded)) {
		const reasons = [
			status.workingTree === 'dirty' ? 'uncommitted changes' : '',
			unlanded ? 'unlanded workspace commits' : '',
		].filter(Boolean);
		throw new Error(
			`Refusing to remove workspace '${state.id}' with ${reasons.join(' and ')}; pass --force to remove it.`,
		);
	}

	const removed = gitResult(
		['worktree', 'remove', options.force ? '--force' : '', state.path].filter(Boolean),
		repositoryCwd,
	);
	if (removed.status !== 0) {
		throw new Error(
			[removed.stderr.trim(), removed.stdout.trim()].filter(Boolean).join('\n') ||
				`Could not remove worktree '${state.path}'.`,
		);
	}
	rmSync(state.path, { force: true, recursive: true });
	gitResult(['branch', '-D', state.branch], repositoryCwd, { allowFailure: true });
	gitResult(['config', '--unset', `branch.${state.branch}.patchlane-workspace`], repositoryCwd, {
		allowFailure: true,
	});
	const refs = gitResult(['for-each-ref', '--format=%(refname)', `refs/patchlane/land/${state.id}`], repositoryCwd, {
		allowFailure: true,
	})
		.stdout.split(/\r?\n/)
		.filter(Boolean);
	for (const ref of refs) gitResult(['update-ref', '-d', ref], repositoryCwd, { allowFailure: true });
	rmSync(stateFile, { force: true });
	return { id: state.id, path: state.path, branch: state.branch };
}

export const runWorkspaceRemove = removeWorkspace;

export function formatWorkspaceRemove(result: WorkspaceRemoveResult) {
	return `Removed Patchlane workspace '${result.id}' (${result.path}).`;
}

export function formatWorkspaceRemoveJson(result: WorkspaceRemoveResult) {
	return JSON.stringify(result, null, 2);
}
