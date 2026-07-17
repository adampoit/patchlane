import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveUpstreamSource } from './upstream-source.js';

type RunOptions = {
	cwd?: string;
	allowFailure?: boolean;
	encoding?: BufferEncoding | 'buffer';
	env?: NodeJS.ProcessEnv;
};

const cwd = process.cwd();

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function log(message: string) {
	process.stdout.write(`${message}\n`);
}

function getEnv(name: string, fallback = '') {
	return process.env[name] ?? fallback;
}

function requireEnv(name: string) {
	const value = getEnv(name);
	if (!value) fail(`Required environment variable '${name}' is not set.`);
	return value;
}

function isTrue(value: string) {
	return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

function trim(value: string) {
	return value.trim();
}

function parsePatchRefs(value: string) {
	return value
		.split(/\r?\n|,/)
		.map(trim)
		.filter(Boolean);
}

function run(command: string, args: string[], options: RunOptions = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? cwd,
		env: options.env ?? process.env,
		encoding: options.encoding ?? 'utf8',
	});

	if (result.error) throw result.error;
	if (!options.allowFailure && result.status !== 0) {
		const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : result.stderr.toString('utf8').trim();
		const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : result.stdout.toString('utf8').trim();
		fail([stderr, stdout].filter(Boolean).join('\n') || `${command} exited with status ${result.status ?? 1}`);
	}

	return result;
}

function runText(command: string, args: string[], options: RunOptions = {}) {
	const result = run(command, args, { ...options, encoding: 'utf8' });
	return {
		status: result.status ?? 0,
		stdout: result.stdout as string,
		stderr: result.stderr as string,
	};
}

function runBuffer(command: string, args: string[], options: RunOptions = {}) {
	const result = run(command, args, { ...options, encoding: 'buffer' });
	return {
		status: result.status ?? 0,
		stdout: result.stdout as Buffer,
		stderr: result.stderr as Buffer,
	};
}

function git(args: string[], options: RunOptions = {}) {
	return runText('git', args, options);
}

function gh(args: string[], options: RunOptions = {}) {
	return runText('gh', args, options);
}

function writeOutput(key: string, value: string) {
	const file = getEnv('GITHUB_OUTPUT');
	if (!file) return;
	if (!value.includes('\n')) {
		appendFileSync(file, `${key}=${value}\n`);
		return;
	}

	const marker = `EOF_${Math.random().toString(16).slice(2)}`;
	appendFileSync(file, `${key}<<${marker}\n${value}\n${marker}\n`);
}

function writeSummary(title: string, body: string, section = '') {
	const file = getEnv('GITHUB_STEP_SUMMARY');
	if (!file) return;
	appendFileSync(file, `${title}\n\n`);
	if (body) appendFileSync(file, `${body}\n\n`);
	if (section) appendFileSync(file, `${section}\n`);
}

function bulletList(items: string[]) {
	return items
		.filter(Boolean)
		.map((item) => `- \`${item}\``)
		.join('\n');
}

function parseJson<T>(value: string) {
	return JSON.parse(value) as T;
}

function resolveRelease(upstreamOwner: string, upstreamRepo: string, releaseSelector: string) {
	const pathName = `repos/${upstreamOwner}/${upstreamRepo}`;
	process.stderr.write(`Resolving upstream release with selector '${releaseSelector}'\n`);

	if (releaseSelector === 'latest') {
		return parseJson<{ tag_name: string; html_url?: string }>(gh(['api', `${pathName}/releases/latest`]).stdout);
	}

	const releases = parseJson<
		Array<{
			tag_name: string;
			html_url?: string;
			prerelease?: boolean;
			draft?: boolean;
		}>
	>(gh(['api', '--paginate', `${pathName}/releases?per_page=100`]).stdout);

	const match =
		releaseSelector === 'prerelease'
			? releases.find((release) => !release.draft && !!release.prerelease)
			: releases.find((release) => !release.draft && new RegExp(releaseSelector).test(release.tag_name));

	if (!match) fail(`No upstream release matched selector '${releaseSelector}'.`);
	return match;
}

function resolvePatchRef(ref: string, originRemoteName: string) {
	if (
		git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
			allowFailure: true,
		}).status === 0
	)
		return ref;

	const fetched = git(
		['fetch', '--no-tags', originRemoteName, `+refs/heads/${ref}:refs/remotes/${originRemoteName}/${ref}`],
		{ allowFailure: true },
	);
	if (fetched.status === 0) return `refs/remotes/${originRemoteName}/${ref}`;
	return '';
}

function parseConflictPaths(output: string) {
	return Array.from(
		new Set(
			output
				.split('\n')
				.flatMap((line) => {
					const applied = line.match(/^Applied patch to '(.+)' with conflicts\.$/);
					if (applied) return [applied[1]];
					const merge = line.match(/^CONFLICT \(.+\): Merge conflict in (.+)$/);
					if (merge) return [merge[1]];
					const missing = line.match(/^error: (.+): does not exist in index$/);
					if (missing) return [missing[1]];
					return [];
				})
				.filter(Boolean),
		),
	);
}

function tmpFile(name: string) {
	return path.join(mkdtempSync(path.join(tmpdir(), `${name}-`)), 'payload');
}

function configureGitIdentity() {
	const name = git(['config', 'user.name'], {
		allowFailure: true,
	}).stdout.trim();
	const email = git(['config', 'user.email'], {
		allowFailure: true,
	}).stdout.trim();
	if (!name) {
		git(['config', 'user.name', 'github-actions[bot]']);
	}
	if (!email) {
		git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
	}
}

export type IntegrationSyncOptions = {
	upstreamOwner: string;
	upstreamRepo: string;
	patchRefs: string;
	baseBranch?: string;
	source?: string;
	upstreamRef?: string;
	releaseSelector?: string;
	syncBranch?: string;
	dryRun?: boolean;
	noPush?: boolean;
	forcePush?: boolean;
	allowDependentPatches?: boolean;
	originRemoteName?: string;
	upstreamRemoteName?: string;
	upstreamRemoteUrl?: string;
};

function hasGeneratedAncestry(resolved: string, diffBase: string) {
	const logResult = git(['log', '--format=%B', `${diffBase}..${resolved}`], {
		allowFailure: true,
	});
	if (logResult.status !== 0) return false;
	const text = logResult.stdout;
	return text.includes('\nPatch-Ref:') || text.includes('\nOriginal-Commit:') || text.includes('apply patch/');
}

function isBasedOnSyncBranch(resolved: string, remoteSyncRef: string) {
	if (!remoteSyncRef) return false;
	const result = git(['merge-base', '--is-ancestor', remoteSyncRef, resolved], {
		allowFailure: true,
	});
	return result.status === 0;
}

export function runIntegrationSync(options: IntegrationSyncOptions) {
	configureGitIdentity();

	const upstreamOwner = options.upstreamOwner;
	const upstreamRepo = options.upstreamRepo;
	const patchRefsRaw = options.patchRefs;

	const baseBranch = options.baseBranch ?? 'main';
	const upstreamSource = resolveUpstreamSource(
		options.source,
		options.upstreamRef ?? baseBranch,
		options.releaseSelector ?? '',
	);
	const upstreamRef = upstreamSource.kind === 'branch' ? upstreamSource.ref : (options.upstreamRef ?? baseBranch);
	const releaseSelector = upstreamSource.kind === 'release' ? upstreamSource.selector : '';
	const syncBranch = options.syncBranch ?? 'sync/integration';
	const dryRun = options.dryRun ?? false;
	const noPush = options.noPush ?? false;
	const forcePush = options.forcePush ?? false;
	const allowDependentPatches = options.allowDependentPatches ?? false;
	const originRemoteName = options.originRemoteName ?? 'origin';
	const upstreamRemoteName = options.upstreamRemoteName ?? 'upstream';
	const upstreamRemoteUrl = options.upstreamRemoteUrl ?? `https://github.com/${upstreamOwner}/${upstreamRepo}.git`;
	const remoteSyncRef = `refs/remotes/${originRemoteName}/${syncBranch}`;

	const existingUpstream = git(['remote', 'get-url', upstreamRemoteName], {
		allowFailure: true,
	});
	if (existingUpstream.status === 0) {
		git(['remote', 'set-url', upstreamRemoteName, upstreamRemoteUrl]);
	} else {
		git(['remote', 'add', upstreamRemoteName, upstreamRemoteUrl]);
	}

	git([
		'fetch',
		'--no-tags',
		originRemoteName,
		`+refs/heads/${baseBranch}:refs/remotes/${originRemoteName}/${baseBranch}`,
	]);
	git(
		[
			'fetch',
			'--no-tags',
			originRemoteName,
			`+refs/heads/${syncBranch}:refs/remotes/${originRemoteName}/${syncBranch}`,
		],
		{ allowFailure: true },
	);
	git(['fetch', '--no-tags', upstreamRemoteName, `+refs/heads/*:refs/remotes/${upstreamRemoteName}/*`]);
	if (releaseSelector) git(['fetch', upstreamRemoteName, '--force', '--tags', '+refs/tags/*:refs/tags/*']);

	let upstreamBase = `refs/remotes/${upstreamRemoteName}/${upstreamRef}`;
	let sourceLabel = `${upstreamRemoteName}/${upstreamRef}`;
	if (releaseSelector) {
		const release = resolveRelease(upstreamOwner, upstreamRepo, releaseSelector);
		if (!release.tag_name) fail('Failed to resolve an upstream release tag.');
		const tagCommit = git(['rev-list', '-n', '1', `refs/tags/${release.tag_name}^{commit}`]).stdout.trim();
		if (!tagCommit) fail(`Tag '${release.tag_name}' was not fetched from the upstream remote.`);
		upstreamBase = tagCommit;
		sourceLabel = `release ${release.tag_name}`;
	} else if (
		git(['rev-parse', '--verify', '--quiet', upstreamBase], {
			allowFailure: true,
		}).status !== 0
	) {
		fail(`Upstream ref '${upstreamRef}' was not fetched from ${upstreamRemoteName}.`);
	}

	const patchRefs = parsePatchRefs(patchRefsRaw);
	if (!patchRefs.length) fail('PATCH_REFS did not contain any patch branch names.');

	type PatchDiagnostic = {
		ref: string;
		resolvedSha: string;
		mergeBase: string;
		diffBase: string;
		commitSubjects: string[];
		changedFiles: string[];
		upstreamCommits: string[];
		warnings: string[];
	};

	function gatherPatchDiagnostics(ref: string, resolved: string): PatchDiagnostic {
		const resolvedSha = git(['rev-parse', `${resolved}^{commit}`]).stdout.trim();
		const isAncestor =
			git(['merge-base', '--is-ancestor', upstreamBase, resolved], {
				allowFailure: true,
			}).status === 0;

		let diffBase = upstreamBase;
		let mergeBase = upstreamBase;

		if (!isAncestor) {
			mergeBase = git(['merge-base', upstreamBase, resolved]).stdout.trim();
			const uniqueCommits = git(['rev-list', '--ancestry-path', `${mergeBase}..${resolved}`]).stdout.trim();

			if (uniqueCommits) {
				const commits = uniqueCommits.split('\n').filter(Boolean);
				const oldestUnique = commits[commits.length - 1]!;
				const tags = git(['tag', '--points-at', oldestUnique], {
					allowFailure: true,
				}).stdout.trim();

				if (tags) {
					diffBase = oldestUnique;
				} else {
					const parent = git(['rev-parse', `${oldestUnique}^`], {
						allowFailure: true,
					}).stdout.trim();
					if (parent) diffBase = parent;
				}

				log(`Patch ${ref} is not based on ${sourceLabel}; using ${diffBase.slice(0, 7)} as patch base`);
			}
		}

		const commitRange = `${diffBase}..${resolved}`;
		const commitShas = git(['rev-list', '--no-merges', '--reverse', commitRange], {
			allowFailure: true,
		})
			.stdout.trim()
			.split('\n')
			.filter(Boolean);
		const commitSubjects = commitShas.map((sha) => git(['log', '-1', '--format=%s', sha]).stdout.trim());
		const upstreamCommits = commitShas.filter((sha) => {
			const containingRefs = git(
				['for-each-ref', `--contains=${sha}`, '--format=%(refname)', `refs/remotes/${upstreamRemoteName}`],
				{ allowFailure: true },
			).stdout.trim();
			return Boolean(containingRefs);
		});
		const changedFiles = git(['diff', '--name-only', `${diffBase}...${resolved}`], {
			allowFailure: true,
		})
			.stdout.trim()
			.split('\n')
			.filter(Boolean);

		const warnings: string[] = [];
		if (hasGeneratedAncestry(resolved, diffBase)) {
			warnings.push('Contains generated patchlane commits in ancestry');
		}
		if (isBasedOnSyncBranch(resolved, remoteSyncRef)) {
			warnings.push('Appears to be based on sync branch output');
		}

		return { ref, resolvedSha, mergeBase, diffBase, commitSubjects, changedFiles, upstreamCommits, warnings };
	}

	function validatePatch(diagnostic: PatchDiagnostic, resolved: string) {
		const { ref, diffBase, upstreamCommits } = diagnostic;
		if (upstreamCommits.length) {
			const failedCommit = upstreamCommits[0]!;
			const failedSubject = git(['log', '-1', '--format=%s', failedCommit]).stdout.trim();
			const reason = `Patch ref '${ref}' includes ${upstreamCommits.length} upstream commit(s) that are not part of ${sourceLabel}.`;
			const body = [
				`- Base: \`${upstreamBase}\``,
				`- Source: \`${sourceLabel}\``,
				`- Failed bookmark: \`${ref}\``,
				`- First unexpected upstream commit: \`${failedCommit.slice(0, 7)} ${failedSubject}\``,
				`- Reason: ${reason}`,
			].join('\n');
			writeOutput('failed_bookmark', ref);
			writeOutput('failed_commit', failedCommit);
			writeOutput('conflicted_paths', '');
			writeOutput('applied_refs', '');
			writeOutput('sync_branch', syncBranch);
			writeOutput('status', 'invalid_patch_base');
			writeSummary(
				'## Integration rebuild failed',
				body,
				`Recreate \`${ref}\` from ${sourceLabel} so it contains only fork-owned commits.`,
			);
			fail(`${reason} Recreate the patch branch from ${sourceLabel}.`);
		}

		if (!allowDependentPatches) {
			const generated = hasGeneratedAncestry(resolved, diffBase);
			const basedOnSync = isBasedOnSyncBranch(resolved, remoteSyncRef);
			if (generated || basedOnSync) {
				const reason = generated
					? `Patch ref '${ref}' contains generated patchlane commits in its ancestry.`
					: `Patch ref '${ref}' appears to be based on sync branch output.`;
				const body = [
					`- Base: \`${upstreamBase}\``,
					`- Source: \`${sourceLabel}\``,
					`- Failed bookmark: \`${ref}\``,
					`- Reason: ${reason}`,
				].join('\n');
				writeOutput('failed_bookmark', ref);
				writeOutput('failed_commit', '');
				writeOutput('conflicted_paths', '');
				writeOutput('applied_refs', '');
				writeOutput('sync_branch', syncBranch);
				writeOutput('status', 'invalid_patch');
				writeSummary(
					'## Integration rebuild failed',
					body,
					'Recreate the patch branch from the upstream release or use --allow-dependent-patches.',
				);
				fail(`${reason} Recreate the patch branch from the upstream release or use --allow-dependent-patches.`);
			}
		}
	}

	function formatPatchDiagnostic(d: PatchDiagnostic): string {
		const lines: string[] = [`#### ${d.ref}`];
		lines.push(`- Resolved: \`${d.resolvedSha.slice(0, 7)}\``);
		if (d.mergeBase !== upstreamBase) {
			lines.push(`- Merge base: \`${d.mergeBase.slice(0, 7)}\` (not based on ${sourceLabel})`);
		}
		lines.push(`- Diff base: \`${d.diffBase.slice(0, 7)}\``);
		lines.push(`- Commits: ${d.commitSubjects.length}`);
		for (const subject of d.commitSubjects) {
			lines.push(`  - ${subject}`);
		}
		if (d.changedFiles.length) {
			lines.push('- Files changed:');
			for (const file of d.changedFiles) {
				lines.push(`  - \`${file}\``);
			}
		}
		for (const warning of d.warnings) {
			lines.push(`- ⚠️ ${warning}`);
		}
		return lines.join('\n');
	}

	function formatDiagnosticsSection(diagnostics: PatchDiagnostic[]): string {
		return `### Patch diagnostics\n\n${diagnostics.map(formatPatchDiagnostic).join('\n\n')}`;
	}

	function applyAllPatches(
		targetCwd: string,
		isDryRun: boolean,
	): { appliedRefs: string[]; patchDiagnostics: PatchDiagnostic[]; rebuiltSyncSha: string } {
		const appliedRefs: string[] = [];
		const patchDiagnostics: PatchDiagnostic[] = [];

		for (const ref of patchRefs) {
			const resolved = resolvePatchRef(ref, originRemoteName);
			if (!resolved) {
				const body = [
					`- Base: \`${upstreamBase}\``,
					`- Source: \`${sourceLabel}\``,
					`- Failed bookmark: \`${ref}\``,
					`- Reason: patch ref could not be resolved locally or from \`${originRemoteName}\`.`,
				].join('\n');
				writeOutput('failed_bookmark', ref);
				writeOutput('failed_commit', '');
				writeOutput('conflicted_paths', '');
				writeOutput('applied_refs', appliedRefs.join('\n'));
				writeOutput('sync_branch', syncBranch);
				writeOutput('status', 'missing_patch');
				writeSummary('## Integration rebuild failed', body);
				fail(`Patch ref '${ref}' could not be resolved locally or from ${originRemoteName}.`);
			}

			const d = gatherPatchDiagnostics(ref, resolved);
			validatePatch(d, resolved);
			patchDiagnostics.push(d);

			const commitRange = `${d.diffBase}..${resolved}`;
			const commitsToReplay = git(['rev-list', '--no-merges', '--reverse', commitRange], {
				allowFailure: true,
				cwd: targetCwd,
			});
			if (commitsToReplay.status !== 0) {
				fail(`Failed to list commits for patch ref '${ref}'.`);
			}
			const commitShas = commitsToReplay.stdout.trim().split('\n').filter(Boolean);

			if (!commitShas.length) {
				log(`Skipping ${ref}; no commits to replay against ${sourceLabel}.`);
				continue;
			}

			log(`Replaying ${commitShas.length} commit(s) from ${ref}`);

			let anyCommitApplied = false;

			for (const commitSha of commitShas) {
				const subject = git(['log', '-1', '--format=%s', commitSha], { cwd: targetCwd }).stdout.trim();

				const cherryPick = git(['cherry-pick', commitSha], {
					allowFailure: true,
					cwd: targetCwd,
				});
				const output = [cherryPick.stdout, cherryPick.stderr].filter(Boolean).join('\n');
				if (output) process.stdout.write(`${output.trim()}\n`);

				if (cherryPick.status !== 0) {
					const combinedOutput = cherryPick.stdout + cherryPick.stderr;
					if (combinedOutput.includes('The previous cherry-pick is now empty')) {
						git(['cherry-pick', '--skip'], { allowFailure: true, cwd: targetCwd });
						continue;
					}

					const unmerged = git(['diff', '--name-only', '--diff-filter=U'], {
						allowFailure: true,
						cwd: targetCwd,
					})
						.stdout.trim()
						.split('\n')
						.filter(Boolean);
					const conflictedPaths = unmerged.length ? unmerged : parseConflictPaths(output);

					const body = [
						`- Base: \`${upstreamBase}\``,
						`- Source: \`${sourceLabel}\``,
						`- Failed bookmark: \`${ref}\``,
						`- Failed commit: \`${commitSha}\``,
						`- Failed subject: \`${subject}\``,
					].join('\n');

					const sectionParts: string[] = [];
					if (conflictedPaths.length) {
						sectionParts.push(`### Conflicted paths\n\n${bulletList(conflictedPaths)}`);
					}
					sectionParts.push(
						`### Reproduction\n\n\`\`\`bash\ngit fetch origin ${ref}\ngit cherry-pick ${commitSha}\n\`\`\``,
					);

					writeOutput('failed_bookmark', ref);
					writeOutput('failed_commit', commitSha);
					writeOutput('conflicted_paths', conflictedPaths.join('\n'));
					writeOutput('applied_refs', appliedRefs.join('\n'));
					writeOutput('sync_branch', syncBranch);
					writeOutput('status', 'conflicted');
					writeSummary('## Integration rebuild failed', body, sectionParts.join('\n\n'));

					if (!isDryRun) {
						process.stderr.write(
							`\nWARNING: The working tree contains generated patchlane output in a conflicted state.\n`,
						);
						process.stderr.write(
							`Do not move patch branches or bookmarks to the failed working tree commit.\n`,
						);
					}
					fail(`Failed to replay commit ${commitSha.slice(0, 7)} from ${ref}: ${subject}`);
				}

				const headSubject = git(['log', '-1', '--format=%s', 'HEAD'], { cwd: targetCwd }).stdout.trim();
				const headBody = git(['log', '-1', '--format=%b', 'HEAD'], { cwd: targetCwd }).stdout.trim();
				const patchBaseSha = git(['rev-parse', d.diffBase], { cwd: targetCwd }).stdout.trim();
				const trailers = `Patch-Ref: ${ref}\nPatch-Base: ${patchBaseSha}\nOriginal-Commit: ${commitSha}`;
				const newMessage = headBody
					? `${headSubject}\n\n${headBody}\n\n${trailers}`
					: `${headSubject}\n\n${trailers}`;
				git(['commit', '--amend', '-m', newMessage], { cwd: targetCwd });
				anyCommitApplied = true;
			}

			if (!anyCommitApplied) {
				log(`Skipping ${ref}; patch produced no staged changes.`);
				continue;
			}

			appliedRefs.push(ref);
		}

		const rebuiltSyncSha = git(['rev-parse', 'HEAD'], { cwd: targetCwd }).stdout.trim();
		return { appliedRefs, patchDiagnostics, rebuiltSyncSha };
	}

	if (dryRun) {
		log(`Validating ${patchRefs.length} patch ref(s) for ${syncBranch}`);

		const worktreeDir = mkdtempSync(path.join(tmpdir(), 'patchlane-dry-run-'));
		try {
			git(['worktree', 'add', '--detach', worktreeDir, upstreamBase]);
			const { appliedRefs, patchDiagnostics } = applyAllPatches(worktreeDir, true);

			writeOutput('failed_bookmark', '');
			writeOutput('failed_commit', '');
			writeOutput('conflicted_paths', '');
			writeOutput('applied_refs', appliedRefs.join('\n'));
			writeOutput('sync_branch', syncBranch);
			writeOutput('status', 'dry_run');
			writeSummary(
				'## Integration rebuild validated',
				[
					`- Base: \`${upstreamBase}\``,
					`- Source: \`${sourceLabel}\``,
					`- Output branch: \`${syncBranch}\``,
					`- Promotion target: \`${baseBranch}\``,
					'- Mode: dry run (no local changes)',
				].join('\n'),
				formatDiagnosticsSection(patchDiagnostics),
			);
			log('Dry run enabled; no local changes applied.');
		} finally {
			git(['cherry-pick', '--abort'], { allowFailure: true, cwd: worktreeDir });
			git(['worktree', 'remove', '-f', worktreeDir], { allowFailure: true });
			rmSync(worktreeDir, { force: true, recursive: true });
		}
		return;
	}

	log(`Building ${syncBranch} from ${sourceLabel}`);
	git(['checkout', '-B', syncBranch, upstreamBase]);
	const { appliedRefs, patchDiagnostics, rebuiltSyncSha } = applyAllPatches(process.cwd(), false);

	writeOutput('failed_bookmark', '');
	writeOutput('failed_commit', '');
	writeOutput('conflicted_paths', '');
	writeOutput('applied_refs', appliedRefs.join('\n'));
	writeOutput('sync_branch', syncBranch);

	function buildSummarySections(): string {
		const parts: string[] = [];
		if (appliedRefs.length) {
			parts.push(`### Applied patches\n\n${bulletList(appliedRefs)}`);
		}
		if (patchDiagnostics.length) {
			parts.push(formatDiagnosticsSection(patchDiagnostics));
		}
		return parts.join('\n\n');
	}

	if (noPush) {
		writeOutput('sync_sha', rebuiltSyncSha);
		writeOutput('status', 'no_push');
		writeSummary(
			'## Integration rebuild completed',
			[
				`- Base: \`${upstreamBase}\``,
				`- Source: \`${sourceLabel}\``,
				`- Output branch: \`${syncBranch}\``,
				`- Promotion target: \`${baseBranch}\``,
				'- Mode: no push',
			].join('\n'),
			buildSummarySections(),
		);
		log('No-push enabled; skipping push and promotion operations.');
		return;
	}

	const remoteSyncExists =
		git(['rev-parse', '--verify', '--quiet', remoteSyncRef], {
			allowFailure: true,
		}).status === 0;
	if (remoteSyncExists && !forcePush) {
		const rebuiltTree = git(['rev-parse', `${rebuiltSyncSha}^{tree}`]).stdout.trim();
		const remoteSyncSha = git(['rev-parse', remoteSyncRef]).stdout.trim();
		const remoteSyncTree = git(['rev-parse', `${remoteSyncRef}^{tree}`]).stdout.trim();
		if (rebuiltTree === remoteSyncTree) {
			writeOutput('sync_sha', remoteSyncSha);
			writeOutput('status', 'unchanged');
			writeSummary(
				'## Integration rebuild unchanged',
				[
					`- Base: \`${upstreamBase}\``,
					`- Source: \`${sourceLabel}\``,
					`- Output branch: \`${syncBranch}\``,
					`- Promotion target: \`${baseBranch}\``,
					`- Published SHA: \`${remoteSyncSha}\``,
					'- Reason: rebuilt branch tree matches the current published sync branch.',
				].join('\n'),
				buildSummarySections(),
			);
			log(`Skipping push for ${syncBranch}; rebuilt tree matches ${originRemoteName}/${syncBranch}.`);
			return;
		}
	}

	log(`Pushing ${syncBranch} to ${originRemoteName}`);
	git(['push', '--force-with-lease', '--set-upstream', originRemoteName, syncBranch]);

	writeOutput('sync_sha', rebuiltSyncSha);
	writeOutput('status', 'published');
	writeSummary(
		'## Integration rebuild published',
		[
			`- Base: \`${upstreamBase}\``,
			`- Source: \`${sourceLabel}\``,
			`- Output branch: \`${syncBranch}\``,
			`- Promotion target: \`${baseBranch}\``,
		].join('\n'),
		buildSummarySections(),
	);
	log("Integration sync completed with status 'published'");
}

function main() {
	runIntegrationSync({
		upstreamOwner: requireEnv('UPSTREAM_OWNER'),
		upstreamRepo: requireEnv('UPSTREAM_REPO'),
		patchRefs: requireEnv('PATCH_REFS'),
		baseBranch: getEnv('BASE_BRANCH', 'main'),
		upstreamRef: getEnv('UPSTREAM_REF'),
		source: getEnv('UPSTREAM_SOURCE'),
		releaseSelector: getEnv('RELEASE_SELECTOR'),
		syncBranch: getEnv('SYNC_BRANCH', 'sync/integration'),
		dryRun: isTrue(getEnv('DRY_RUN', 'false')),
		noPush: isTrue(getEnv('NO_PUSH', 'false')),
		forcePush: isTrue(getEnv('FORCE_PUSH', 'false')),
		allowDependentPatches: isTrue(getEnv('ALLOW_DEPENDENT_PATCHES', 'false')),
		originRemoteName: getEnv('ORIGIN_REMOTE_NAME', 'origin'),
		upstreamRemoteName: getEnv('UPSTREAM_REMOTE_NAME', 'upstream'),
		upstreamRemoteUrl: getEnv('UPSTREAM_REMOTE_URL'),
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
