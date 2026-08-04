import { findWorkspaceState, worktreeForBranch, type WorkspaceState } from './workspace-state.js';
import { git, gitResult, headSha } from './git.js';

export type WorkspaceStatus = {
	id: string;
	path: string;
	branch: string;
	targetLane: string;
	baselineCommit: string;
	workspaceHead: string;
	commitsToLand: number;
	workingTree: 'clean' | 'dirty';
	sourceSha: string;
	laneRefs: 'unchanged' | 'changed' | 'unknown';
	changedLanes: Array<{ ref: string; expected: string; actual?: string }>;
	mergeCommits: string[];
	baselineIsAncestor: boolean;
	targetLaneCheckedOut: boolean;
	landingStatus:
		| 'ready'
		| 'landed'
		| 'dirty'
		| 'workspace_stale'
		| 'invalid_baseline'
		| 'non_linear'
		| 'nothing_to_land'
		| 'target_lane_checked_out';
	state: WorkspaceState;
};

function laneTip(cwd: string, state: WorkspaceState, ref: string) {
	const remoteRef = `refs/remotes/${state.originRemoteName}/${ref}`;
	const fetched = gitResult(
		['fetch', '--prune', '--no-tags', state.originRemoteName, `+refs/heads/${ref}:${remoteRef}`],
		cwd,
		{
			allowFailure: true,
		},
	);
	const remote =
		fetched.status === 0
			? gitResult(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`], cwd).stdout.trim() || undefined
			: undefined;
	const localResult = gitResult(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`], cwd);
	const local = localResult.status === 0 ? localResult.stdout.trim() : undefined;
	if (local && local !== state.laneTips[ref]) return local;
	return remote ?? local;
}

export function inspectWorkspaceStatus(options: { cwd?: string; state?: WorkspaceState } = {}): WorkspaceStatus {
	const cwd = options.cwd ?? process.cwd();
	const state = options.state ?? findWorkspaceState(cwd);
	const workspaceHead = headSha(cwd);
	const dirty = git(['status', '--porcelain', '--untracked-files=all'], cwd).length > 0;
	const baselineIsAncestor =
		gitResult(['merge-base', '--is-ancestor', state.baselineCommit, workspaceHead], cwd).status === 0;
	const commitRange = baselineIsAncestor
		? git(['rev-list', '--reverse', `${state.baselineCommit}..${workspaceHead}`], cwd)
				.split(/\r?\n/)
				.filter(Boolean)
		: [];
	const mergeCommits = baselineIsAncestor
		? git(['rev-list', '--merges', `${state.baselineCommit}..${workspaceHead}`], cwd)
				.split(/\r?\n/)
				.filter(Boolean)
		: [];

	const changedLanes = state.laneOrder.flatMap((ref) => {
		const actual = laneTip(cwd, state, ref);
		return actual === state.laneTips[ref] ? [] : [{ ref, expected: state.laneTips[ref]!, actual }];
	});
	const laneRefs: WorkspaceStatus['laneRefs'] = changedLanes.length ? 'changed' : 'unchanged';
	const targetWorktree = worktreeForBranch(cwd, state.targetLane);
	const targetLaneCheckedOut = Boolean(targetWorktree && targetWorktree.path !== state.path);

	let landingStatus: WorkspaceStatus['landingStatus'];
	if (state.landedWorkspaceHead === workspaceHead && state.landedLaneSha) landingStatus = 'landed';
	else if (dirty) landingStatus = 'dirty';
	else if (!baselineIsAncestor) landingStatus = 'invalid_baseline';
	else if (mergeCommits.length) landingStatus = 'non_linear';
	else if (changedLanes.length) landingStatus = 'workspace_stale';
	else if (targetLaneCheckedOut) landingStatus = 'target_lane_checked_out';
	else if (!commitRange.length) landingStatus = 'nothing_to_land';
	else landingStatus = 'ready';

	return {
		id: state.id,
		path: state.path,
		branch: state.branch,
		targetLane: state.targetLane,
		baselineCommit: state.baselineCommit,
		workspaceHead,
		commitsToLand: commitRange.length,
		workingTree: dirty ? 'dirty' : 'clean',
		sourceSha: state.source.sha,
		laneRefs,
		changedLanes,
		mergeCommits,
		baselineIsAncestor,
		targetLaneCheckedOut,
		landingStatus,
		state,
	};
}

export const runWorkspaceStatus = inspectWorkspaceStatus;

export function formatWorkspaceStatus(status: WorkspaceStatus) {
	return [
		`Patchlane workspace: ${status.id}`,
		'',
		`Target lane:       ${status.targetLane}`,
		`Baseline commit:   ${status.baselineCommit.slice(0, 7)}`,
		`Workspace HEAD:    ${status.workspaceHead.slice(0, 7)}`,
		`Commits to land:   ${status.commitsToLand}`,
		`Working tree:      ${status.workingTree}`,
		`Source SHA:        ${status.sourceSha.slice(0, 7)}`,
		`Lane refs:         ${status.laneRefs}`,
		`Landing status:    ${status.landingStatus}`,
		...(status.changedLanes.length
			? [
					'',
					'Changed lanes:',
					...status.changedLanes.map(
						(lane) =>
							`  ${lane.ref}: expected ${lane.expected.slice(0, 7)}, actual ${lane.actual?.slice(0, 7) ?? 'missing'}`,
					),
				]
			: []),
	].join('\n');
}

export function formatWorkspaceStatusJson(status: WorkspaceStatus) {
	return JSON.stringify(
		{
			id: status.id,
			path: status.path,
			branch: status.branch,
			targetLane: status.targetLane,
			baselineCommit: status.baselineCommit,
			workspaceHead: status.workspaceHead,
			commitsToLand: status.commitsToLand,
			workingTree: status.workingTree,
			sourceSha: status.sourceSha,
			laneRefs: status.laneRefs,
			changedLanes: status.changedLanes,
			mergeCommits: status.mergeCommits,
			landingStatus: status.landingStatus,
		},
		null,
		2,
	);
}
