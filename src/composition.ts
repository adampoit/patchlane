import type { PatchlaneConfig } from './config.js';
import { CompositionError } from './composition-errors.js';
import { ensureGitIdentity, git, gitResult, isValidRefName, objectExists, runProcess } from './git.js';
import { parseUpstreamSource } from './upstream-source.js';
import { validateWorkflowPolicy, workflowFilesAtRef } from './workflow-policy.js';

export type ResolvedSource = {
	configuredSource: string;
	label: string;
	sha: string;
};

export type LanePlan = {
	ref: string;
	resolvedRef: string;
	tipSha: string;
	mergeBaseSha: string;
	diffBaseSha: string;
	commits: Array<{
		sha: string;
		subject: string;
	}>;
	changedPaths: string[];
	warnings: string[];
};

export type CompositionPlan = {
	source: ResolvedSource;
	lanes: LanePlan[];
	baseBranch: string;
	syncBranch: string;
	/** The policy is kept on the plan so every consumer validates the same tree. */
	allowedWorkflows?: string[];
};

export type CompositionResult = {
	headSha: string;
	treeSha: string;
	appliedLanes: string[];
	generatedCommits: Array<{
		lane: string;
		originalSha: string;
		generatedSha: string;
	}>;
};

export type ResolveCompositionOptions = {
	cwd?: string;
	originRemoteName?: string;
	upstreamRemoteName?: string;
	upstreamRemoteUrl?: string;
	source?: string;
	allowDependentPatches?: boolean;
	/** Use exact previously recorded lane tips instead of resolving moving refs. */
	laneTips?: Record<string, string>;
	/** Use an already resolved source, as required by workspace landing. */
	resolvedSource?: ResolvedSource;
	fetch?: boolean;
};

function sourceRemoteUrl(config: PatchlaneConfig) {
	return `https://github.com/${config.upstreamOwner}/${config.upstreamRepo}.git`;
}

function ensureRemote(cwd: string, name: string, url: string | undefined, fallbackUrl: string) {
	const existing = gitResult(['remote', 'get-url', name], cwd);
	if (existing.status === 0) {
		if (url && existing.stdout.trim() !== url) git(['remote', 'set-url', name, url], cwd);
		return;
	}
	git(['remote', 'add', name, url ?? fallbackUrl], cwd);
}

function fetchRemoteBranches(cwd: string, remote: string) {
	const fetched = gitResult(['fetch', '--prune', '--no-tags', remote, `+refs/heads/*:refs/remotes/${remote}/*`], cwd);
	if (fetched.status !== 0) {
		throw new Error(
			`Could not fetch remote '${remote}': ${[fetched.stderr.trim(), fetched.stdout.trim()].filter(Boolean).join('\n')}`,
		);
	}
}

function fetchLane(cwd: string, remote: string, ref: string) {
	if (!isValidRefName(cwd, ref)) {
		throw new CompositionError('invalid_lane', `Configured lane '${ref}' is not a valid Git ref.`, { ref });
	}
	const fetched = gitResult(
		['fetch', '--prune', '--no-tags', remote, `+refs/heads/${ref}:refs/remotes/${remote}/${ref}`],
		cwd,
	);
	return fetched.status === 0;
}

function parseGhJson<T>(stdout: string): T | undefined {
	try {
		return JSON.parse(stdout) as T;
	} catch {
		return undefined;
	}
}

function resolveReleaseTag(cwd: string, config: PatchlaneConfig, selector: string) {
	const repo = `${config.upstreamOwner}/${config.upstreamRepo}`;
	const endpoint = `repos/${repo}/releases`;
	const result =
		selector === 'latest'
			? runProcess('gh', ['api', `${endpoint}/latest`], cwd, { allowFailure: true })
			: runProcess('gh', ['api', '--paginate', `${endpoint}?per_page=100`], cwd, { allowFailure: true });

	if (result.status === 0) {
		if (selector === 'latest') {
			const release = parseGhJson<{ tag_name?: unknown }>(result.stdout);
			if (typeof release?.tag_name === 'string' && release.tag_name) return release.tag_name;
		} else {
			const releases = parseGhJson<Array<{ tag_name?: unknown; prerelease?: unknown; draft?: unknown }>>(
				result.stdout,
			);
			if (Array.isArray(releases)) {
				if (selector === 'prerelease') {
					const match = releases.find(
						(release) =>
							release.draft !== true &&
							release.prerelease === true &&
							typeof release.tag_name === 'string',
					);
					if (match && typeof match.tag_name === 'string') return match.tag_name;
				} else {
					let expression: RegExp;
					try {
						expression = new RegExp(selector);
					} catch {
						throw new CompositionError('invalid_lane_base', `Invalid release selector '${selector}'.`, {
							selector,
						});
					}
					const match = releases.find(
						(release) =>
							release.draft !== true &&
							typeof release.tag_name === 'string' &&
							expression.test(release.tag_name),
					);
					if (match && typeof match.tag_name === 'string') return match.tag_name;
				}
			}
		}
	}

	// A local tag fallback keeps branch-only/offline repositories useful and is also
	// helpful for tests using a local upstream without a GitHub API fixture.
	const tags = git(['tag', '--list'], cwd)
		.split(/\r?\n/)
		.filter(Boolean)
		.filter((tag) => !tag.includes('-rc') && !tag.includes('-beta') && !tag.includes('-alpha'));
	if (selector === 'latest') return tags.sort().at(-1);
	if (selector === 'prerelease') {
		return git(['tag', '--list'], cwd)
			.split(/\r?\n/)
			.filter((tag) => tag.includes('-rc') || tag.includes('-beta') || tag.includes('-alpha'))
			.sort()
			.at(-1);
	}
	let expression: RegExp;
	try {
		expression = new RegExp(selector);
	} catch {
		throw new CompositionError('invalid_lane_base', `Invalid release selector '${selector}'.`, { selector });
	}
	return tags.find((tag) => expression.test(tag));
}

function resolveSource(
	cwd: string,
	config: PatchlaneConfig,
	options: ResolveCompositionOptions,
	upstreamRemoteName: string,
): ResolvedSource {
	if (options.resolvedSource) {
		if (!objectExists(cwd, `${options.resolvedSource.sha}^{commit}`)) {
			throw new CompositionError(
				'invalid_lane_base',
				`Resolved source commit '${options.resolvedSource.sha}' is not available locally.`,
				{ sha: options.resolvedSource.sha },
			);
		}
		return options.resolvedSource;
	}

	const configuredSource = options.source ?? config.source;
	const source = parseUpstreamSource(configuredSource);
	if (source.kind === 'branch') {
		const remoteRef = `refs/remotes/${upstreamRemoteName}/${source.ref}`;
		const sha = gitResult(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`], cwd);
		if (sha.status !== 0) {
			throw new CompositionError(
				'invalid_lane_base',
				`Upstream branch '${source.ref}' was not fetched from ${upstreamRemoteName}.`,
				{ source: configuredSource, ref: source.ref },
			);
		}
		return { configuredSource, label: `branch ${source.ref}`, sha: sha.stdout.trim() };
	}

	const tag = resolveReleaseTag(cwd, config, source.selector);
	if (!tag) {
		throw new CompositionError('invalid_lane_base', `No upstream release matched selector '${source.selector}'.`, {
			source: configuredSource,
			selector: source.selector,
		});
	}
	const tagSha = gitResult(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], cwd);
	if (tagSha.status !== 0) {
		throw new CompositionError(
			'invalid_lane_base',
			`Upstream release tag '${tag}' was not fetched from ${upstreamRemoteName}.`,
			{ source: configuredSource, tag },
		);
	}
	return { configuredSource, label: `release ${tag}`, sha: tagSha.stdout.trim() };
}

function hasGeneratedAncestry(cwd: string, resolved: string, diffBase: string) {
	const result = gitResult(['log', '--format=%B', `${diffBase}..${resolved}`], cwd);
	if (result.status !== 0) return false;
	return (
		result.stdout.includes('\nPatch-Ref:') ||
		result.stdout.includes('\nOriginal-Commit:') ||
		result.stdout.includes('apply patch/')
	);
}

function isBasedOnSyncBranch(cwd: string, resolved: string, syncRef: string) {
	if (gitResult(['rev-parse', '--verify', '--quiet', `${syncRef}^{commit}`], cwd).status !== 0) return false;
	return gitResult(['merge-base', '--is-ancestor', syncRef, resolved], cwd).status === 0;
}

function resolveLanePlan(
	cwd: string,
	source: ResolvedSource,
	ref: string,
	resolvedRef: string,
	upstreamRemoteName: string,
	syncRef: string,
	allowDependentPatches: boolean,
): LanePlan {
	const tipResult = gitResult(['rev-parse', '--verify', '--quiet', `${resolvedRef}^{commit}`], cwd);
	if (tipResult.status !== 0) {
		throw new CompositionError('missing_lane', `Patch lane '${ref}' could not be resolved.`, { ref });
	}
	const tipSha = tipResult.stdout.trim();
	const basedOnSource = gitResult(['merge-base', '--is-ancestor', source.sha, tipSha], cwd).status === 0;
	let mergeBaseSha = source.sha;
	let diffBaseSha = source.sha;
	if (!basedOnSource) {
		const mergeBase = gitResult(['merge-base', source.sha, tipSha], cwd);
		if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
			throw new CompositionError(
				'invalid_lane_base',
				`Patch lane '${ref}' has no merge base with ${source.label}.`,
				{ ref, source: source.sha },
			);
		}
		mergeBaseSha = mergeBase.stdout.trim();
		const unique = git(['rev-list', '--ancestry-path', `${mergeBaseSha}..${tipSha}`], cwd)
			.split(/\r?\n/)
			.filter(Boolean);
		if (unique.length) {
			const oldest = unique.at(-1)!;
			const tags = gitResult(['tag', '--points-at', oldest], cwd).stdout.trim();
			if (tags) diffBaseSha = oldest;
			else {
				const parent = gitResult(['rev-parse', `${oldest}^`], cwd).stdout.trim();
				diffBaseSha = parent || mergeBaseSha;
			}
		}
	}

	const commitShas = git(['rev-list', '--no-merges', '--reverse', `${diffBaseSha}..${tipSha}`], cwd)
		.split(/\r?\n/)
		.filter(Boolean);
	const commits = commitShas.map((sha) => ({
		sha,
		subject: git(['log', '-1', '--format=%s', sha], cwd),
	}));
	const changedPaths = gitResult(['diff', '--name-only', `${diffBaseSha}...${tipSha}`], cwd)
		.stdout.split(/\r?\n/)
		.map((file) => file.trim())
		.filter(Boolean);
	const warnings: string[] = [];
	if (hasGeneratedAncestry(cwd, tipSha, diffBaseSha))
		warnings.push('Contains generated patchlane commits in ancestry');
	if (isBasedOnSyncBranch(cwd, tipSha, syncRef)) warnings.push('Appears to be based on sync branch output');

	const upstreamCommits = commitShas.filter(
		(sha) =>
			gitResult(
				['for-each-ref', `--contains=${sha}`, '--format=%(refname)', `refs/remotes/${upstreamRemoteName}`],
				cwd,
			).stdout.trim().length > 0,
	);
	if (upstreamCommits.length) {
		throw new CompositionError(
			'invalid_lane_base',
			`Patch lane '${ref}' includes ${upstreamCommits.length} upstream commit(s) that are not part of ${source.label}.`,
			{
				ref,
				source: source.label,
				upstreamCommits,
				firstUnexpectedCommit: upstreamCommits[0],
				diffBaseSha,
			},
		);
	}
	if (!allowDependentPatches && warnings.length) {
		throw new CompositionError(
			'invalid_lane',
			`Patch lane '${ref}' contains generated patchlane history or is based on sync output.`,
			{ ref, warnings, diffBaseSha },
		);
	}

	return {
		ref,
		resolvedRef,
		tipSha,
		mergeBaseSha,
		diffBaseSha,
		commits,
		changedPaths,
		warnings,
	};
}

export function resolveCompositionPlan(
	config: PatchlaneConfig,
	options: ResolveCompositionOptions = {},
): CompositionPlan {
	const cwd = options.cwd ?? process.cwd();
	if (!config.patchRefs.length || new Set(config.patchRefs).size !== config.patchRefs.length) {
		throw new CompositionError('invalid_lane', 'Configured patchRefs must contain unique lane refs.', {
			patchRefs: config.patchRefs,
		});
	}
	for (const ref of config.patchRefs) {
		if (!isValidRefName(cwd, ref)) {
			throw new CompositionError('invalid_lane', `Configured lane '${ref}' is not a valid Git ref.`, { ref });
		}
	}
	const originRemoteName = options.originRemoteName ?? 'origin';
	const upstreamRemoteName = options.upstreamRemoteName ?? 'upstream';
	const upstreamRemoteUrl = options.upstreamRemoteUrl;
	ensureRemote(cwd, upstreamRemoteName, upstreamRemoteUrl, sourceRemoteUrl(config));
	if (options.fetch !== false) {
		fetchRemoteBranches(cwd, upstreamRemoteName);
		for (const ref of config.patchRefs) fetchLane(cwd, originRemoteName, ref);
		const source = parseUpstreamSource(options.source ?? config.source);
		if (source.kind === 'release') {
			const fetched = gitResult(
				['fetch', '--force', '--tags', upstreamRemoteName, '+refs/tags/*:refs/tags/*'],
				cwd,
			);
			if (fetched.status !== 0) {
				throw new Error(
					`Could not fetch tags from '${upstreamRemoteName}': ${[fetched.stderr.trim(), fetched.stdout.trim()].filter(Boolean).join('\n')}`,
				);
			}
		}
	}

	const source = resolveSource(cwd, config, options, upstreamRemoteName);
	const remoteSyncRef = `refs/remotes/${originRemoteName}/${config.syncBranch}`;
	const lanes = config.patchRefs.map((ref) => {
		let resolvedRef: string | undefined;
		if (options.laneTips?.[ref]) {
			resolvedRef = options.laneTips[ref];
			if (!objectExists(cwd, `${resolvedRef}^{commit}`)) {
				throw new CompositionError('missing_lane', `Recorded patch lane '${ref}' is unavailable locally.`, {
					ref,
					sha: resolvedRef,
				});
			}
		} else {
			const remoteRef = `refs/remotes/${originRemoteName}/${ref}`;
			const localRef = `refs/heads/${ref}`;
			resolvedRef =
				gitResult(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`], cwd).status === 0
					? remoteRef
					: gitResult(['rev-parse', '--verify', '--quiet', `${localRef}^{commit}`], cwd).status === 0
						? localRef
						: undefined;
		}
		if (!resolvedRef)
			throw new CompositionError('missing_lane', `Patch lane '${ref}' could not be resolved.`, { ref });
		return resolveLanePlan(
			cwd,
			source,
			ref,
			resolvedRef,
			upstreamRemoteName,
			remoteSyncRef,
			options.allowDependentPatches ?? false,
		);
	});

	return {
		source,
		lanes,
		baseBranch: config.baseBranch,
		syncBranch: config.syncBranch,
		allowedWorkflows: config.allowedWorkflows,
	};
}

function conflictPaths(cwd: string, output: string) {
	const unmerged = gitResult(['diff', '--name-only', '--diff-filter=U'], cwd).stdout.split(/\r?\n/).filter(Boolean);
	if (unmerged.length) return [...new Set(unmerged)];
	return [
		...new Set(
			output.split(/\r?\n/).flatMap((line) => {
				const conflict = line.match(/^CONFLICT \(.+\): Merge conflict in (.+)$/);
				return conflict ? [conflict[1]!] : [];
			}),
		),
	];
}

function commitMessage(cwd: string, lane: LanePlan, originalSha: string) {
	const subject = git(['log', '-1', '--format=%s', 'HEAD'], cwd);
	const body = git(['log', '-1', '--format=%b', 'HEAD'], cwd).trim();
	const patchBase = lane.diffBaseSha;
	const trailers = `Patch-Ref: ${lane.ref}\nPatch-Base: ${patchBase}\nOriginal-Commit: ${originalSha}`;
	return body ? `${subject}\n\n${body}\n\n${trailers}` : `${subject}\n\n${trailers}`;
}

function replayCommit(
	cwd: string,
	lane: LanePlan,
	commitSha: string,
	recordProvenanceTrailers: boolean,
): { generatedSha?: string; empty: boolean } {
	const cherryPick = gitResult(['cherry-pick', commitSha], cwd);
	if (cherryPick.status !== 0) {
		const output = `${cherryPick.stdout}\n${cherryPick.stderr}`;
		if (output.includes('previous cherry-pick is now empty') || output.includes('nothing to commit')) {
			gitResult(['cherry-pick', '--skip'], cwd, { allowFailure: true });
			return { empty: true };
		}
		const paths = conflictPaths(cwd, output);
		gitResult(['cherry-pick', '--abort'], cwd, { allowFailure: true });
		throw new CompositionError('conflict', `Failed to replay commit ${commitSha.slice(0, 7)} from ${lane.ref}.`, {
			lane: lane.ref,
			commit: commitSha,
			conflictedPaths: paths,
			output: output.trim(),
		});
	}

	if (recordProvenanceTrailers) git(['commit', '--amend', '-m', commitMessage(cwd, lane, commitSha)], cwd);
	return { generatedSha: git(['rev-parse', 'HEAD^{commit}'], cwd), empty: false };
}

export function composeIntoWorktree(
	plan: CompositionPlan,
	options: {
		cwd: string;
		laneOverrides?: Record<string, string>;
		recordProvenanceTrailers?: boolean;
	},
): CompositionResult {
	const cwd = options.cwd;
	ensureGitIdentity(cwd);
	const recordProvenanceTrailers = options.recordProvenanceTrailers ?? true;
	const generatedCommits: CompositionResult['generatedCommits'] = [];
	const appliedLanes: string[] = [];

	for (const lane of plan.lanes) {
		const override = options.laneOverrides?.[lane.ref];
		let commitShas: string[];
		if (override) {
			if (!objectExists(cwd, `${override}^{commit}`)) {
				throw new CompositionError('missing_lane', `Lane override for '${lane.ref}' is unavailable.`, {
					lane: lane.ref,
					sha: override,
				});
			}
			commitShas = git(['rev-list', '--no-merges', '--reverse', `${lane.diffBaseSha}..${override}`], cwd)
				.split(/\r?\n/)
				.filter(Boolean);
		} else {
			commitShas = lane.commits.map(({ sha }) => sha);
		}

		let applied = false;
		for (const commitSha of commitShas) {
			const replayed = replayCommit(cwd, lane, commitSha, recordProvenanceTrailers);
			if (replayed.empty || !replayed.generatedSha) continue;
			applied = true;
			generatedCommits.push({ lane: lane.ref, originalSha: commitSha, generatedSha: replayed.generatedSha });
		}
		if (applied) appliedLanes.push(lane.ref);
	}

	const headSha = git(['rev-parse', 'HEAD^{commit}'], cwd);
	const treeSha = git(['rev-parse', 'HEAD^{tree}'], cwd);
	if (plan.allowedWorkflows !== undefined) {
		let files;
		try {
			files = workflowFilesAtRef(cwd, headSha);
		} catch (error) {
			throw new CompositionError(
				'workflow_policy',
				`Could not inspect workflows at composed commit ${headSha}.`,
				{
					cause: error instanceof Error ? error.message : String(error),
				},
			);
		}
		const violations = validateWorkflowPolicy(plan.allowedWorkflows, files);
		if (violations.length) {
			throw new CompositionError('workflow_policy', violations[0]!.message, {
				violations: violations.map(({ message }) => message),
				headSha,
			});
		}
	}

	return { headSha, treeSha, appliedLanes, generatedCommits };
}

export function compositionWorkflowViolations(cwd: string, plan: CompositionPlan, commit: string) {
	if (plan.allowedWorkflows === undefined) return [];
	return validateWorkflowPolicy(plan.allowedWorkflows, workflowFilesAtRef(cwd, commit));
}
