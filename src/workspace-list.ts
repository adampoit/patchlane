import { withIsolatedGitConfig } from './git-environment.js';
import { listWorkspaceStates, type WorkspaceState } from './workspace-state.js';

export type WorkspaceListEntry = Pick<WorkspaceState, 'id' | 'path' | 'branch' | 'createdAt' | 'targetLane'>;

export type WorkspaceListOptions = {
	cwd?: string;
};

export function listWorkspaces(options: WorkspaceListOptions = {}): WorkspaceListEntry[] {
	return withIsolatedGitConfig(() =>
		listWorkspaceStates(options.cwd).map(({ id, path, branch, createdAt, targetLane }) => ({
			id,
			path,
			branch,
			createdAt,
			targetLane,
		})),
	);
}

export function formatWorkspaceList(workspaces: WorkspaceListEntry[]) {
	if (!workspaces.length) return 'No Patchlane workspaces registered.';
	return [
		'Patchlane workspaces:',
		'',
		...workspaces.flatMap((workspace, index) => [
			`${index + 1}. ${workspace.id}`,
			`   Path:        ${workspace.path}`,
			`   Branch:      ${workspace.branch}`,
			`   Target lane: ${workspace.targetLane}`,
			`   Created:     ${workspace.createdAt}`,
			...(index < workspaces.length - 1 ? [''] : []),
		]),
	].join('\n');
}

export function formatWorkspaceListJson(workspaces: WorkspaceListEntry[]) {
	return JSON.stringify(workspaces, null, 2);
}
