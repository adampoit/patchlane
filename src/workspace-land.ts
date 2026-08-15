import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPatchlaneConfig, loadPatchlaneConfigAtRef } from './config.js';
import { composeIntoWorktree, resolveCompositionPlan, type CompositionPlan } from './composition.js';
import { PATCHLANE_GIT_CONFIGURATION_DIAGNOSTIC, withIsolatedGitConfig } from './git-environment.js';
import { ensureGitIdentity, git, gitResult } from './git.js';
import { inspectWorkspaceStatus, type WorkspaceStatus } from './workspace-status.js';
import { findWorkspaceState, worktreeForBranch, writeWorkspaceState, type WorkspaceState } from './workspace-state.js';

export type WorkspaceLandOptions = {
	cwd?: string;
	lane?: string;
	dryRun?: boolean;
	push?: boolean;
	originRemoteName?: string;
	upstreamRemoteName?: string;
	upstreamRemoteUrl?: string;
};

export type WorkspaceLandResult = {
	status: 'dry_run' | 'landed';
	workspaceId: string;
	targetLane: string;
	workspaceHead: string;
	candidateLaneSha: string;
	candidateCompositionSha: string;
	workspaceTree: string;
	compositionTree: string;
	pushed: boolean;
};

export type WorkspaceLandErrorCode =
	'workspace_stale' | 'workspace_invalid' | 'workspace_conflict' | 'round_trip_mismatch' | 'push_failed';

export class WorkspaceLandError extends Error {
	readonly name = 'WorkspaceLandError';

	constructor(
		readonly code: WorkspaceLandErrorCode,
		message: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
	}
}

function candidateRef(id: string, name: 'target' | 'composition') {
	return `refs/patchlane/land/${id}/${name}`;
}

function parseConflictPaths(cwd: string, output: string) {
	const unmerged = gitResult(['diff', '--name-only', '--diff-filter=U'], cwd).stdout.split(/\r?\n/).filter(Boolean);
	if (unmerged.length) return [...new Set(unmerged)];
	return [
		...new Set(
			output.split(/\r?\n/).flatMap((line) => {
				const match = line.match(/^CONFLICT \(.+\): Merge conflict in (.+)$/);
				return match ? [match[1]!] : [];
			}),
		),
	];
}

function replayWorkspaceCommits(cwd: string, status: WorkspaceStatus, targetLane: string, plan: CompositionPlan) {
	const commits = git(['rev-list', '--reverse', `${status.baselineCommit}..${status.workspaceHead}`], cwd)
		.split(/\r?\n/)
		.filter(Boolean);
	let applied = false;
	for (const commit of commits) {
		const result = gitResult(['cherry-pick', commit], cwd);
		if (result.status === 0) {
			applied = true;
			continue;
		}
		const output = `${result.stdout}\n${result.stderr}`;
		if (output.includes('previous cherry-pick is now empty') || output.includes('nothing to commit')) {
			gitResult(['cherry-pick', '--skip'], cwd, { allowFailure: true });
			continue;
		}
		const conflictedPaths = parseConflictPaths(cwd, output);
		gitResult(['cherry-pick', '--abort'], cwd, { allowFailure: true });
		const likelyOriginatingLanes = plan.lanes
			.filter((lane) => lane.changedPaths.some((path) => conflictedPaths.includes(path)))
			.map((lane) => lane.ref);
		const diagnostic = [
			conflictedPaths.length ? `Conflicted paths: ${conflictedPaths.join(', ')}` : '',
			likelyOriginatingLanes.length ? `Likely originating lanes: ${likelyOriginatingLanes.join(', ')}` : '',
			`Reproduction: git cherry-pick ${commit}`,
		]
			.filter(Boolean)
			.join('. ');
		throw new WorkspaceLandError(
			'workspace_conflict',
			`Workspace commit ${commit.slice(0, 7)} could not be projected onto ${targetLane}.${diagnostic ? ` ${diagnostic}.` : ''} ${PATCHLANE_GIT_CONFIGURATION_DIAGNOSTIC}`,
			{
				workspaceCommit: commit,
				targetLane,
				conflictedPaths,
				likelyOriginatingLanes,
				reproduction: `git cherry-pick ${commit}`,
				gitConfiguration: PATCHLANE_GIT_CONFIGURATION_DIAGNOSTIC,
			},
		);
	}
	return { head: git(['rev-parse', 'HEAD^{commit}'], cwd), applied };
}

function removeCandidate(cwd: string, ref: string) {
	gitResult(['update-ref', '-d', ref], cwd, { allowFailure: true });
}

function createCandidateWorktree(cwd: string, ref: string, sha: string) {
	const parent = mkdtempSync(path.join(tmpdir(), 'patchlane-land-'));
	const worktreePath = path.join(parent, 'candidate');
	git(['update-ref', ref, sha, ''], cwd);
	try {
		git(['worktree', 'add', '--detach', worktreePath, ref], cwd);
	} catch (error) {
		removeCandidate(cwd, ref);
		rmSync(parent, { force: true, recursive: true });
		throw error;
	}
	return { parent, worktreePath };
}

function removeCandidateWorktree(cwd: string, parent: string, worktreePath: string, ref: string) {
	gitResult(['worktree', 'remove', '--force', worktreePath], cwd, { allowFailure: true });
	rmSync(parent, { force: true, recursive: true });
	removeCandidate(cwd, ref);
}

function configForWorkspace(cwd: string, state: WorkspaceState) {
	try {
		return loadPatchlaneConfigAtRef(cwd, state.configRef);
	} catch (error) {
		const local = loadPatchlaneConfig(cwd);
		if (local) return local;
		throw error;
	}
}

function laneRemoteTip(cwd: string, remote: string, lane: string) {
	const fetched = gitResult(
		['fetch', '--prune', '--no-tags', remote, `+refs/heads/${lane}:refs/remotes/${remote}/${lane}`],
		cwd,
		{ allowFailure: true },
	);
	if (fetched.status !== 0) return undefined;
	const result = gitResult(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${lane}^{commit}`], cwd);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function validateLaneFreshness(cwd: string, state: WorkspaceState) {
	const changedLanes: Array<{ ref: string; expected: string; actual?: string }> = [];
	for (const ref of state.laneOrder) {
		const remote = laneRemoteTip(cwd, state.originRemoteName, ref);
		const localResult = gitResult(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`], cwd);
		const local = localResult.status === 0 ? localResult.stdout.trim() : undefined;
		const actual =
			(remote && remote !== state.laneTips[ref] ? remote : undefined) ??
			(local && local !== state.laneTips[ref] ? local : undefined) ??
			remote ??
			local;
		if (actual !== state.laneTips[ref]) changedLanes.push({ ref, expected: state.laneTips[ref]!, actual });
	}
	return changedLanes;
}

function laneOverridePlan(
	config: ReturnType<typeof configForWorkspace>,
	state: WorkspaceState,
	cwd: string,
	originRemoteName: string,
	upstreamRemoteName: string,
	upstreamRemoteUrl: string | undefined,
) {
	if (
		config.patchRefs.length !== state.laneOrder.length ||
		config.patchRefs.some((ref, index) => ref !== state.laneOrder[index])
	) {
		throw new WorkspaceLandError(
			'workspace_stale',
			'The Patchlane configuration no longer has the same ordered lane set as this workspace.',
			{ expectedLaneOrder: state.laneOrder, actualLaneOrder: config.patchRefs },
		);
	}
	return resolveCompositionPlan(config, {
		cwd,
		originRemoteName,
		upstreamRemoteName,
		upstreamRemoteUrl,
		resolvedSource: state.source,
		laneTips: state.laneTips,
		fetch: false,
	});
}

function mismatchDetails(cwd: string, candidateComposition: string, workspaceHead: string, plan: CompositionPlan) {
	const raw = gitResult(
		['diff', '--name-status', '--no-renames', '-z', candidateComposition, workspaceHead],
		cwd,
	).stdout;
	const entries: Array<{ status: string; path: string; owner?: string; laterLane?: string }> = [];
	const parts = raw.split('\0');
	for (let index = 0; index + 1 < parts.length; index += 2) {
		const status = parts[index];
		const relativePath = parts[index + 1];
		if (!status || !relativePath) continue;
		const log = gitResult(['log', '--format=%B', candidateComposition, '--', relativePath], cwd).stdout;
		const owner = log.match(/(?:^|\n)Patch-Ref:\s*([^\n]+)/)?.[1]?.trim();
		const ownerIndex = owner ? plan.lanes.findIndex((lane) => lane.ref === owner) : -1;
		const laterLane = plan.lanes
			.slice(ownerIndex + 1)
			.find((lane) => lane.changedPaths.includes(relativePath))?.ref;
		entries.push({ status, path: relativePath, ...(owner ? { owner } : {}), ...(laterLane ? { laterLane } : {}) });
	}
	return entries;
}

function formatMismatch(
	targetLane: string,
	differences: Array<{ status: string; path: string; owner?: string; laterLane?: string }>,
) {
	const lines = [
		'Round-trip validation failed.',
		'',
		`Workspace target: ${targetLane}`,
		'',
		'The projected lane does not reproduce the tested workspace tree:',
	];
	for (const difference of differences) {
		lines.push(`  ${difference.status} ${difference.path}`);
		if (difference.owner) lines.push(`      Last composed owner: ${difference.owner}`);
		if (difference.laterLane) lines.push(`      Later modifying lane: ${difference.laterLane}`);
	}
	lines.push(
		'',
		'No lane refs were changed.',
		'',
		'Possible causes:',
		'  - the selected target lane is incorrect;',
		'  - the change depends on another lane;',
		'  - a later lane overwrites part of the projected change;',
		'  - the workspace contains changes belonging to multiple lanes.',
	);
	return lines.join('\n');
}

function localLaneLease(cwd: string, lane: string, expected: string) {
	const result = gitResult(['rev-parse', '--verify', '--quiet', `refs/heads/${lane}^{commit}`], cwd);
	const actual = result.status === 0 ? result.stdout.trim() : undefined;
	if (actual && actual !== expected) {
		throw new WorkspaceLandError('workspace_stale', `Local lane '${lane}' moved since workspace creation.`, {
			changedLanes: [{ ref: lane, expected, actual }],
		});
	}
	return actual ?? '';
}

function landWorkspaceInternal(options: WorkspaceLandOptions = {}): WorkspaceLandResult {
	const cwd = options.cwd ?? process.cwd();
	const state = findWorkspaceState(cwd);
	const status = inspectWorkspaceStatus({ cwd, state });
	if (status.workingTree === 'dirty') {
		throw new WorkspaceLandError('workspace_invalid', 'The workspace has uncommitted changes.', {
			workingTree: 'dirty',
		});
	}
	if (!status.baselineIsAncestor) {
		throw new WorkspaceLandError(
			'workspace_invalid',
			'Workspace HEAD is not descended from the recorded baseline commit.',
			{
				baselineCommit: state.baselineCommit,
				workspaceHead: status.workspaceHead,
			},
		);
	}
	if (status.mergeCommits.length) {
		throw new WorkspaceLandError(
			'workspace_invalid',
			'Workspace history must be linear; merge commits are not supported.',
			{
				mergeCommits: status.mergeCommits,
			},
		);
	}
	if (!status.commitsToLand)
		throw new WorkspaceLandError('workspace_invalid', 'There are no workspace commits to land.');

	const targetLane = options.lane?.trim() || state.targetLane;
	if (!state.laneOrder.includes(targetLane)) {
		throw new WorkspaceLandError(
			'workspace_invalid',
			`Target lane '${targetLane}' is not part of this workspace.`,
			{
				targetLane,
				laneOrder: state.laneOrder,
			},
		);
	}
	const config = configForWorkspace(cwd, state);
	if (!config.patchRefs.includes(targetLane)) {
		throw new WorkspaceLandError(
			'workspace_invalid',
			`Target lane '${targetLane}' is not configured in patchRefs.`,
		);
	}
	const otherWorktree = worktreeForBranch(cwd, targetLane);
	if (otherWorktree && otherWorktree.path !== state.path) {
		throw new WorkspaceLandError(
			'workspace_invalid',
			`Target lane '${targetLane}' is checked out in another worktree.`,
			{
				targetLane,
				worktree: otherWorktree.path,
			},
		);
	}

	const changedLanes = validateLaneFreshness(cwd, state);
	if (changedLanes.length) {
		throw new WorkspaceLandError(
			'workspace_stale',
			`One or more configured lane refs moved since workspace creation: ${changedLanes.map((lane) => lane.ref).join(', ')}.`,
			{ changedLanes },
		);
	}

	const originRemoteName = options.originRemoteName ?? state.originRemoteName;
	const upstreamRemoteName = options.upstreamRemoteName ?? state.upstreamRemoteName;
	const plan = laneOverridePlan(
		config,
		state,
		cwd,
		originRemoteName,
		upstreamRemoteName,
		options.upstreamRemoteUrl ?? process.env.UPSTREAM_REMOTE_URL,
	);
	const targetExpected = state.laneTips[targetLane]!;
	const targetRef = candidateRef(state.id, 'target');
	const compositionRef = candidateRef(state.id, 'composition');
	let targetCandidate: { parent: string; worktreePath: string } | undefined;
	let compositionCandidate: { parent: string; worktreePath: string } | undefined;
	let candidateLaneSha = targetExpected;
	let candidateCompositionSha = '';
	let workspaceTree = git(['rev-parse', `${status.workspaceHead}^{tree}`], cwd);
	let compositionTree = '';
	let pushed = false;

	try {
		targetCandidate = createCandidateWorktree(cwd, targetRef, targetExpected);
		ensureGitIdentity(targetCandidate.worktreePath);
		const projected = replayWorkspaceCommits(targetCandidate.worktreePath, status, targetLane, plan);
		candidateLaneSha = projected.head;
		git(['update-ref', targetRef, candidateLaneSha, targetExpected], cwd);

		compositionCandidate = createCandidateWorktree(cwd, compositionRef, state.source.sha);
		const composed = composeIntoWorktree(plan, {
			cwd: compositionCandidate.worktreePath,
			laneOverrides: { [targetLane]: candidateLaneSha },
		});
		candidateCompositionSha = composed.headSha;
		compositionTree = composed.treeSha;
		git(['update-ref', compositionRef, candidateCompositionSha, state.source.sha], cwd);

		if (workspaceTree !== compositionTree) {
			const differences = mismatchDetails(cwd, candidateCompositionSha, status.workspaceHead, plan);
			throw new WorkspaceLandError('round_trip_mismatch', formatMismatch(targetLane, differences), {
				targetLane,
				differences,
				workspaceTree,
				compositionTree,
			});
		}

		if (options.dryRun) {
			return {
				status: 'dry_run',
				workspaceId: state.id,
				targetLane,
				workspaceHead: status.workspaceHead,
				candidateLaneSha,
				candidateCompositionSha,
				workspaceTree,
				compositionTree,
				pushed: false,
			};
		}

		const finalChangedLanes = validateLaneFreshness(cwd, state);
		if (finalChangedLanes.length) {
			throw new WorkspaceLandError(
				'workspace_stale',
				`One or more configured lane refs moved while the landing candidate was being built: ${finalChangedLanes.map((lane) => lane.ref).join(', ')}.`,
				{ changedLanes: finalChangedLanes },
			);
		}
		const localExpected = localLaneLease(cwd, targetLane, targetExpected);

		if (options.push) {
			const remoteExpected = laneRemoteTip(cwd, state.originRemoteName, targetLane);
			if (remoteExpected !== targetExpected) {
				throw new WorkspaceLandError(
					'workspace_stale',
					`Remote lane '${targetLane}' moved before push; refusing to push.`,
					{
						changedLanes: [{ ref: targetLane, expected: targetExpected, actual: remoteExpected }],
					},
				);
			}
			const push = gitResult(
				[
					'push',
					`--force-with-lease=refs/heads/${targetLane}:${targetExpected}`,
					state.originRemoteName,
					`${candidateLaneSha}:refs/heads/${targetLane}`,
				],
				cwd,
			);
			if (push.status !== 0) {
				throw new WorkspaceLandError(
					'push_failed',
					`Failed to push lane '${targetLane}' with force-with-lease: ${push.stderr.trim() || push.stdout.trim() || 'remote rejected the update'}.`,
					{
						targetLane,
						localLaneSha: candidateLaneSha,
						expectedRemoteSha: targetExpected,
						stderr: push.stderr.trim(),
					},
				);
			}
			pushed = true;
		}

		git(['update-ref', `refs/heads/${targetLane}`, candidateLaneSha, localExpected], cwd);

		state.landedLaneSha = candidateLaneSha;
		state.landedAt = new Date().toISOString();
		state.pushed = pushed;
		state.landedWorkspaceHead = status.workspaceHead;
		state.landedLane = targetLane;
		writeWorkspaceState(state, cwd);
		return {
			status: 'landed',
			workspaceId: state.id,
			targetLane,
			workspaceHead: status.workspaceHead,
			candidateLaneSha,
			candidateCompositionSha,
			workspaceTree,
			compositionTree,
			pushed,
		};
	} finally {
		if (compositionCandidate)
			removeCandidateWorktree(
				cwd,
				compositionCandidate.parent,
				compositionCandidate.worktreePath,
				compositionRef,
			);
		else removeCandidate(cwd, compositionRef);
		if (targetCandidate)
			removeCandidateWorktree(cwd, targetCandidate.parent, targetCandidate.worktreePath, targetRef);
		else removeCandidate(cwd, targetRef);
	}
}

export function landWorkspace(options: WorkspaceLandOptions = {}): WorkspaceLandResult {
	return withIsolatedGitConfig(() => landWorkspaceInternal(options));
}

export const runWorkspaceLand = landWorkspace;

export function formatWorkspaceLand(result: WorkspaceLandResult) {
	return [
		result.status === 'dry_run' ? 'Workspace landing validated.' : 'Workspace landed successfully.',
		'',
		`Target lane:       ${result.targetLane}`,
		`Workspace HEAD:    ${result.workspaceHead.slice(0, 7)}`,
		`Projected lane:    ${result.candidateLaneSha.slice(0, 7)}`,
		`Composed tree:     ${result.compositionTree.slice(0, 7)}`,
		`Remote push:       ${result.pushed ? 'yes' : 'no'}`,
		...(result.status === 'dry_run' ? ['No lane refs were changed.'] : []),
	].join('\n');
}

export function formatWorkspaceLandJson(result: WorkspaceLandResult) {
	return `${JSON.stringify(result, null, 2)}`;
}
