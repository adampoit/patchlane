import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedSource } from './composition.js';
import { parseUpstreamSource } from './upstream-source.js';
import {
	currentBranch,
	gitCommonDir,
	isValidRefName,
	isWorktreePathRegistered,
	listWorktrees,
	gitTopLevel,
	objectExists,
} from './git.js';

export const WORKSPACE_STATE_VERSION = 1;
export const WORKSPACE_STATE_DIRECTORY = path.join('patchlane', 'workspaces');

export type WorkspaceState = {
	version: 1;
	id: string;
	path: string;
	branch: string;
	createdAt: string;
	configRef: string;
	originRemoteName: string;
	upstreamRemoteName: string;
	source: ResolvedSource;
	targetLane: string;
	baselineCommit: string;
	baselineTree: string;
	laneOrder: string[];
	laneTips: Record<string, string>;
	laneDiffBases: Record<string, string>;
	landedLaneSha: string | null;
	landedAt?: string;
	pushed?: boolean;
	landedWorkspaceHead?: string;
	landedLane?: string;
};

type StateValidationOptions = {
	cwd?: string;
	requireRegisteredWorktree?: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, field: string) {
	if (typeof value[field] !== 'string' || !value[field].trim()) {
		throw new Error(`Workspace state field '${field}' must be a non-empty string.`);
	}
	return value[field].trim();
}

function validSha(value: unknown, field: string) {
	if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/i.test(value)) {
		throw new Error(`Workspace state field '${field}' must contain a Git object ID.`);
	}
	return value;
}

function validRef(value: string, field: string, cwd?: string) {
	const staticallyInvalid =
		!value ||
		value.startsWith('-') ||
		value.startsWith('/') ||
		value.endsWith('/') ||
		value.startsWith('.') ||
		value.endsWith('.') ||
		value.includes('..') ||
		value.includes('//') ||
		value.includes('@{') ||
		/[~^:?*\\[\\]\\\\\u0000-\\u001f]/.test(value);
	if (staticallyInvalid || (cwd ? !isValidRefName(cwd, value) : false)) {
		throw new Error(`Workspace state field '${field}' contains invalid ref '${value}'.`);
	}
	return value;
}

function parseLaneMap(value: unknown, field: string, lanes: string[]) {
	if (!isPlainObject(value)) throw new Error(`Workspace state field '${field}' must be an object.`);
	const keys = Object.keys(value);
	if (keys.length !== lanes.length || keys.some((lane) => !lanes.includes(lane))) {
		throw new Error(`Workspace state field '${field}' must contain exactly one value for every lane.`);
	}
	return Object.fromEntries(lanes.map((lane) => [lane, validSha(value[lane], `${field}.${lane}`)]));
}

export function parseWorkspaceState(value: unknown, options: StateValidationOptions = {}): WorkspaceState {
	if (!isPlainObject(value)) throw new Error('Workspace state must be a JSON object.');
	if (value.version !== WORKSPACE_STATE_VERSION) {
		throw new Error(`Unsupported Patchlane workspace state version '${String(value.version)}'.`);
	}

	const cwd = options.cwd;
	const id = requiredString(value, 'id');
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Workspace state field 'id' is invalid: '${id}'.`);
	const workspacePath = requiredString(value, 'path');
	if (!path.isAbsolute(workspacePath)) throw new Error("Workspace state field 'path' must be absolute.");
	if (options.requireRegisteredWorktree && cwd && !isWorktreePathRegistered(cwd, workspacePath)) {
		throw new Error(`Workspace state path '${workspacePath}' is not a registered Git worktree.`);
	}

	const branch = requiredString(value, 'branch');
	if (!branch.startsWith('patchlane/work/')) {
		throw new Error(`Workspace state field 'branch' must be a disposable Patchlane workspace branch.`);
	}
	validRef(branch, 'branch', cwd);
	const createdAt = requiredString(value, 'createdAt');
	if (Number.isNaN(Date.parse(createdAt))) throw new Error("Workspace state field 'createdAt' must be an ISO date.");
	const configRef = requiredString(value, 'configRef');
	const originRemoteName = requiredString(value, 'originRemoteName');
	const upstreamRemoteName = requiredString(value, 'upstreamRemoteName');
	const targetLane = requiredString(value, 'targetLane');
	const baselineCommit = validSha(value.baselineCommit, 'baselineCommit');
	const baselineTree = validSha(value.baselineTree, 'baselineTree');

	if (!Array.isArray(value.laneOrder) || value.laneOrder.length === 0) {
		throw new Error("Workspace state field 'laneOrder' must contain at least one lane.");
	}
	const laneOrder = value.laneOrder.map((lane, index) => {
		if (typeof lane !== 'string' || !lane.trim()) {
			throw new Error(`Workspace state field 'laneOrder[${index}]' must be a non-empty string.`);
		}
		return validRef(lane.trim(), `laneOrder[${index}]`, cwd);
	});
	if (new Set(laneOrder).size !== laneOrder.length)
		throw new Error('Workspace state laneOrder must not contain duplicates.');
	if (!laneOrder.includes(targetLane)) throw new Error(`Workspace target lane '${targetLane}' is not in laneOrder.`);

	const sourceValue = value.source;
	if (!isPlainObject(sourceValue)) throw new Error("Workspace state field 'source' must be an object.");
	const source: ResolvedSource = {
		configuredSource: requiredString(sourceValue, 'configuredSource'),
		label: requiredString(sourceValue, 'label'),
		sha: validSha(sourceValue.sha, 'source.sha'),
	};
	try {
		parseUpstreamSource(source.configuredSource);
	} catch (error) {
		throw new Error(`Workspace state source is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}

	const laneTips = parseLaneMap(value.laneTips, 'laneTips', laneOrder);
	const laneDiffBases = parseLaneMap(value.laneDiffBases, 'laneDiffBases', laneOrder);
	if (cwd) {
		const commitObjects = [
			['baselineCommit', baselineCommit],
			['source.sha', source.sha],
			...laneOrder.flatMap((lane) => [
				[`laneTips.${lane}`, laneTips[lane]!],
				[`laneDiffBases.${lane}`, laneDiffBases[lane]!],
			]),
		];
		for (const [field, sha] of commitObjects) {
			if (!objectExists(cwd, `${sha}^{commit}`))
				throw new Error(`Workspace state ${field} '${sha}' is missing from the repository.`);
		}
		if (!objectExists(cwd, `${baselineTree}^{tree}`)) {
			throw new Error(`Workspace state baselineTree '${baselineTree}' is missing from the repository.`);
		}
	}
	if (value.landedLaneSha !== null && value.landedLaneSha !== undefined)
		validSha(value.landedLaneSha, 'landedLaneSha');
	if (
		value.landedAt !== undefined &&
		(typeof value.landedAt !== 'string' || Number.isNaN(Date.parse(value.landedAt)))
	) {
		throw new Error("Workspace state field 'landedAt' must be an ISO date when provided.");
	}
	if (value.pushed !== undefined && typeof value.pushed !== 'boolean') {
		throw new Error("Workspace state field 'pushed' must be a boolean when provided.");
	}
	if (
		value.landedLaneSha !== null &&
		value.landedLaneSha !== undefined &&
		cwd &&
		!objectExists(cwd, `${value.landedLaneSha}^{commit}`)
	) {
		throw new Error(`Workspace state landedLaneSha '${value.landedLaneSha}' is missing from the repository.`);
	}
	if (value.landedWorkspaceHead !== undefined) validSha(value.landedWorkspaceHead, 'landedWorkspaceHead');
	if (value.landedWorkspaceHead !== undefined && cwd && !objectExists(cwd, `${value.landedWorkspaceHead}^{commit}`)) {
		throw new Error(
			`Workspace state landedWorkspaceHead '${value.landedWorkspaceHead}' is missing from the repository.`,
		);
	}
	if (value.landedLane !== undefined) validRef(requiredString(value, 'landedLane'), 'landedLane', cwd);

	return {
		version: 1,
		id,
		path: path.resolve(workspacePath),
		branch,
		createdAt,
		configRef,
		originRemoteName,
		upstreamRemoteName,
		source,
		targetLane,
		baselineCommit,
		baselineTree,
		laneOrder,
		laneTips,
		laneDiffBases,
		landedLaneSha: value.landedLaneSha === undefined ? null : (value.landedLaneSha as string | null),
		...(value.landedAt === undefined ? {} : { landedAt: value.landedAt as string }),
		...(value.pushed === undefined ? {} : { pushed: value.pushed as boolean }),
		...(value.landedWorkspaceHead === undefined
			? {}
			: { landedWorkspaceHead: value.landedWorkspaceHead as string }),
		...(value.landedLane === undefined ? {} : { landedLane: value.landedLane as string }),
	};
}

export function workspaceRegistryDirectory(cwd = process.cwd()) {
	return path.join(gitCommonDir(cwd), WORKSPACE_STATE_DIRECTORY);
}

export function workspaceStatePath(cwd: string, id: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid workspace id '${id}'.`);
	return path.join(workspaceRegistryDirectory(cwd), `${id}.json`);
}

export function writeWorkspaceState(state: WorkspaceState, cwd = process.cwd()) {
	const directory = workspaceRegistryDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	const target = workspaceStatePath(cwd, state.id);
	const parsed = parseWorkspaceState(state, { cwd, requireRegisteredWorktree: true });
	const temporary = path.join(directory, `.${state.id}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
	try {
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
	return target;
}

function readStateFile(filePath: string, cwd: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
	} catch (error) {
		throw new Error(
			`Failed to read workspace state '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseWorkspaceState(parsed, { cwd, requireRegisteredWorktree: true });
}

export function listWorkspaceStates(cwd = process.cwd()) {
	const directory = workspaceRegistryDirectory(cwd);
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((file) => file.endsWith('.json'))
		.sort()
		.map((file) => readStateFile(path.join(directory, file), cwd));
}

export function readWorkspaceState(cwd = process.cwd(), id: string) {
	const filePath = workspaceStatePath(cwd, id);
	if (!existsSync(filePath)) throw new Error(`Patchlane workspace '${id}' is not registered.`);
	return readStateFile(filePath, cwd);
}

export function findWorkspaceState(cwd = process.cwd()) {
	const topLevel = gitTopLevel(cwd);
	const branch = currentBranch(cwd);
	const states = listWorkspaceStates(cwd);
	const state = states.find((candidate) => candidate.path === topLevel || candidate.branch === branch);
	if (!state) {
		throw new Error('The current directory is not a registered Patchlane workspace. Run workspace create first.');
	}
	if (state.path !== topLevel && state.branch !== branch) {
		throw new Error('The current worktree does not match its registered Patchlane workspace.');
	}
	return state;
}

export function removeWorkspaceState(cwd: string, id: string) {
	rmSync(workspaceStatePath(cwd, id), { force: true });
}

export function workspaceStateIsRegistered(cwd: string, state: WorkspaceState) {
	return isWorktreePathRegistered(cwd, state.path);
}

export function worktreeForBranch(cwd: string, branch: string) {
	return listWorktrees(cwd).find((worktree) => worktree.branch === branch);
}
