import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { loadPatchlaneConfig, type PatchlaneConfig } from './config.js';
import { parseUpstreamSource } from './upstream-source.js';

export type DoctorCheck = {
	severity: 'error' | 'warning' | 'info';
	message: string;
};

export type DoctorReport = {
	ok: boolean;
	resolvedSource?: string;
	checks: DoctorCheck[];
};

type DoctorOptions = {
	cwd?: string;
	json?: boolean;
};

type RunOptions = {
	env?: NodeJS.ProcessEnv;
	input?: string;
	trimOutput?: boolean;
};

function run(command: string, args: string[], cwd: string, options: RunOptions = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: options.env ?? process.env,
		input: options.input,
	});
	if (result.error) return { status: 1, stdout: '', stderr: result.error.message };
	return {
		status: result.status ?? 1,
		stdout: options.trimOutput === false ? result.stdout : result.stdout.trim(),
		stderr: options.trimOutput === false ? result.stderr : result.stderr.trim(),
	};
}

function git(args: string[], cwd: string, options?: RunOptions) {
	return run('git', args, cwd, options);
}

function remoteUrl(cwd: string, remote: string) {
	const result = git(['remote', 'get-url', remote], cwd);
	return result.status === 0 ? result.stdout : undefined;
}

function resolveRelease(config: PatchlaneConfig, selector: string, cwd: string) {
	const repo = `${config.upstreamOwner}/${config.upstreamRepo}`;
	if (selector === 'latest') {
		const result = run('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], cwd);
		return result.status === 0 ? result.stdout : undefined;
	}
	const result = run(
		'gh',
		[
			'api',
			'--paginate',
			`repos/${repo}/releases?per_page=100`,
			'--jq',
			selector === 'prerelease'
				? '[.[] | select(.draft == false and .prerelease == true)][0].tag_name'
				: `.[] | select(.draft == false) | .tag_name`,
		],
		cwd,
	);
	if (result.status !== 0) return undefined;
	const tags = result.stdout.split(/\r?\n/).filter(Boolean);
	if (selector === 'prerelease') return tags[0];
	let regex: RegExp;
	try {
		regex = new RegExp(selector);
	} catch {
		return undefined;
	}
	return tags.find((tag) => regex.test(tag));
}

function resolveSource(config: PatchlaneConfig, cwd: string, checks: DoctorCheck[]) {
	const source = parseUpstreamSource(config.source);
	const upstreamUrl =
		remoteUrl(cwd, 'upstream') ?? `https://github.com/${config.upstreamOwner}/${config.upstreamRepo}.git`;
	if (source.kind === 'branch') {
		const result = git(['ls-remote', upstreamUrl, `refs/heads/${source.ref}`], cwd);
		const sha = result.stdout.split(/\s+/)[0];
		if (result.status !== 0 || !sha) {
			checks.push({ severity: 'error', message: `Upstream branch '${source.ref}' could not be resolved.` });
			return undefined;
		}
		return { label: `branch ${source.ref}`, sha };
	}

	const tag = resolveRelease(config, source.selector, cwd);
	if (!tag) {
		checks.push({
			severity: 'error',
			message: `Release selector '${source.selector}' did not resolve to a release.`,
		});
		return undefined;
	}
	const result = git(['ls-remote', upstreamUrl, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], cwd);
	const lines = result.stdout.split(/\r?\n/).filter(Boolean);
	const dereferenced = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`)) ?? lines[0];
	const sha = dereferenced?.split(/\s+/)[0];
	if (result.status !== 0 || !sha) {
		checks.push({ severity: 'error', message: `Release tag '${tag}' could not be resolved from upstream.` });
		return undefined;
	}
	return { label: `release ${tag}`, sha };
}

function workingTreeWorkflowFiles(cwd: string) {
	const workflowDir = path.join(cwd, '.github', 'workflows');
	if (!existsSync(workflowDir)) return [];
	return readdirSync(workflowDir)
		.filter((file) => /\.ya?ml$/.test(file))
		.map((file) => ({ file, content: readFileSync(path.join(workflowDir, file), 'utf8') }));
}

function workflowFiles(config: PatchlaneConfig, sourceSha: string | undefined, cwd: string) {
	if (!sourceSha || git(['cat-file', '-e', `${sourceSha}^{commit}`], cwd).status !== 0) {
		return workingTreeWorkflowFiles(cwd);
	}

	const tempDir = mkdtempSync(path.join(tmpdir(), 'patchlane-doctor-'));
	const indexFile = path.join(tempDir, 'index');
	const indexEnv = { ...process.env, GIT_INDEX_FILE: indexFile };

	function applyPatch(diff: ReturnType<typeof git>) {
		if (diff.status !== 0 || !diff.stdout) return diff.status === 0;
		return (
			git(['apply', '--cached', '--3way', '--whitespace=nowarn', '-'], cwd, {
				env: indexEnv,
				input: diff.stdout,
			}).status === 0
		);
	}

	function applyDiff(from: string, to: string) {
		return applyPatch(
			git(['diff', '--binary', '--full-index', from, to, '--', '.github/workflows'], cwd, {
				trimOutput: false,
			}),
		);
	}

	function applyWorkingTreeChanges(head: string) {
		const trackedDiff = git(['diff', '--binary', '--full-index', head, '--', '.github/workflows'], cwd, {
			trimOutput: false,
		});
		if (!applyPatch(trackedDiff)) return false;
		const untracked = git(['ls-files', '--others', '--exclude-standard', '--', '.github/workflows'], cwd)
			.stdout.split(/\r?\n/)
			.filter((file) => /\.ya?ml$/.test(file));
		if (!untracked.length) return true;
		return git(['add', '--', ...untracked], cwd, { env: indexEnv }).status === 0;
	}

	try {
		if (git(['read-tree', sourceSha], cwd, { env: indexEnv }).status !== 0) {
			return workingTreeWorkflowFiles(cwd);
		}

		const head = git(['rev-parse', 'HEAD'], cwd).stdout;
		for (const patchRef of config.patchRefs) {
			const mergeBase = git(['merge-base', sourceSha, patchRef], cwd);
			if (mergeBase.status !== 0 || !mergeBase.stdout) continue;

			const commits = git(['rev-list', '--no-merges', '--reverse', `${mergeBase.stdout}..${patchRef}`], cwd)
				.stdout.split(/\r?\n/)
				.filter(Boolean);
			for (const commit of commits) {
				if (!applyDiff(`${commit}^`, commit)) return workingTreeWorkflowFiles(cwd);
			}
		}
		if (!applyWorkingTreeChanges(head)) return workingTreeWorkflowFiles(cwd);

		const files = git(['ls-files', '.github/workflows'], cwd, { env: indexEnv })
			.stdout.split(/\r?\n/)
			.filter((file) => /\.ya?ml$/.test(file));
		return files.flatMap((relativePath) => {
			const content = git(['show', `:${relativePath}`], cwd, { env: indexEnv, trimOutput: false });
			return content.status === 0 ? [{ file: path.basename(relativePath), content: content.stdout }] : [];
		});
	} finally {
		rmSync(tempDir, { force: true, recursive: true });
	}
}

function readWorkflow(contents: string) {
	try {
		const value = parse(contents) as unknown;
		return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function workflowName(workflow: Record<string, unknown> | undefined) {
	return workflow && typeof workflow.name === 'string' ? workflow.name : undefined;
}

function eventConfig(workflow: Record<string, unknown>, event: string) {
	const on = workflow.on;
	if (typeof on !== 'object' || on === null || Array.isArray(on)) return undefined;
	return (on as Record<string, unknown>)[event];
}

function configuredBranches(workflow: Record<string, unknown>) {
	const push = eventConfig(workflow, 'push');
	if (typeof push !== 'object' || push === null || Array.isArray(push)) return [];
	const branches = (push as Record<string, unknown>).branches;
	if (typeof branches === 'string') return [branches];
	return Array.isArray(branches) ? branches.filter((branch): branch is string => typeof branch === 'string') : [];
}

function hasWriteContents(workflow: Record<string, unknown>) {
	const permissions = workflow.permissions;
	return (
		typeof permissions === 'object' &&
		permissions !== null &&
		!Array.isArray(permissions) &&
		(permissions as Record<string, unknown>).contents === 'write'
	);
}

function inspectWorkflows(config: PatchlaneConfig, sourceSha: string | undefined, cwd: string, checks: DoctorCheck[]) {
	const files = workflowFiles(config, sourceSha, cwd);
	const parsed = files.map((file) => ({ ...file, workflow: readWorkflow(file.content) }));
	const sync = parsed.find((file) => file.file === 'sync-upstream.yml');
	const promotion = parsed.find((file) => file.file === 'promote-tested-sync.yml');
	const ci = parsed.find((file) => workflowName(file.workflow) === config.ciWorkflow);

	if (!sync?.workflow) checks.push({ severity: 'error', message: 'Missing .github/workflows/sync-upstream.yml.' });
	else if (!hasWriteContents(sync.workflow)) {
		checks.push({ severity: 'error', message: 'The sync workflow must grant contents: write.' });
	}
	if (!promotion?.workflow) {
		checks.push({ severity: 'error', message: 'Missing .github/workflows/promote-tested-sync.yml.' });
	} else {
		if (!hasWriteContents(promotion.workflow)) {
			checks.push({ severity: 'error', message: 'The promotion workflow must grant contents: write.' });
		}
		const workflowRun = eventConfig(promotion.workflow, 'workflow_run');
		const workflows =
			typeof workflowRun === 'object' && workflowRun !== null && !Array.isArray(workflowRun)
				? (workflowRun as Record<string, unknown>).workflows
				: undefined;
		if (!Array.isArray(workflows) || !workflows.includes(config.ciWorkflow)) {
			checks.push({
				severity: 'error',
				message: `The promotion workflow must listen for the '${config.ciWorkflow}' workflow.`,
			});
		}
	}

	if (!ci?.workflow) {
		checks.push({ severity: 'error', message: `CI workflow '${config.ciWorkflow}' was not found.` });
	} else {
		const branches = configuredBranches(ci.workflow);
		for (const branch of [config.baseBranch, config.syncBranch]) {
			if (!branches.includes(branch)) {
				checks.push({
					severity: 'error',
					message: `CI workflow '${config.ciWorkflow}' must run on pushes to '${branch}'.`,
				});
			}
		}
	}
}

function inspectPatchRefs(config: PatchlaneConfig, sourceSha: string | undefined, cwd: string, checks: DoctorCheck[]) {
	const originUrl = remoteUrl(cwd, 'origin');
	if (!originUrl) {
		checks.push({ severity: 'error', message: "Git remote 'origin' is missing." });
		return;
	}
	for (const patchRef of config.patchRefs) {
		const remote = git(['ls-remote', originUrl, `refs/heads/${patchRef}`], cwd);
		if (remote.status !== 0 || !remote.stdout) {
			checks.push({ severity: 'error', message: `Patch branch '${patchRef}' is missing from origin.` });
			continue;
		}
		const localRef = git(['rev-parse', '--verify', '--quiet', `${patchRef}^{commit}`], cwd);
		if (localRef.status !== 0 || !sourceSha || git(['cat-file', '-e', `${sourceSha}^{commit}`], cwd).status !== 0) {
			checks.push({
				severity: 'warning',
				message: `Patch branch '${patchRef}' exists, but its base could not be inspected without local source refs.`,
			});
			continue;
		}
		const isBasedOnSource = git(['merge-base', '--is-ancestor', sourceSha, patchRef], cwd).status === 0;
		if (!isBasedOnSource) {
			checks.push({
				severity: 'warning',
				message: `Patch branch '${patchRef}' is not based directly on the selected source.`,
			});
			continue;
		}
		const count = git(['rev-list', '--count', `${sourceSha}..${patchRef}`], cwd).stdout;
		checks.push({
			severity: 'info',
			message: `Patch branch '${patchRef}' contains ${count} fork-owned commit(s).`,
		});
	}
}

function inspectBootstrap(config: PatchlaneConfig, cwd: string, checks: DoctorCheck[]) {
	const remoteBase = `refs/remotes/origin/${config.baseBranch}`;
	if (git(['rev-parse', '--verify', '--quiet', remoteBase], cwd).status !== 0) return;
	if (git(['cat-file', '-e', `${remoteBase}:.github/workflows/promote-tested-sync.yml`], cwd).status !== 0) {
		checks.push({
			severity: 'warning',
			message:
				'Initial bootstrap is required because the promotion workflow is not on the remote base branch yet.',
		});
	}
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const checks: DoctorCheck[] = [];
	let config: PatchlaneConfig;
	try {
		const loaded = loadPatchlaneConfig(cwd);
		if (!loaded) throw new Error('Missing .patchlane.yml. Run `npx patchlane init` first.');
		config = loaded;
	} catch (error) {
		checks.push({ severity: 'error', message: error instanceof Error ? error.message : String(error) });
		return printReport({ ok: false, checks }, options.json ?? false);
	}

	const resolved = resolveSource(config, cwd, checks);
	if (resolved)
		checks.push({ severity: 'info', message: `Resolved ${config.source} to ${resolved.label} @ ${resolved.sha}.` });
	inspectPatchRefs(config, resolved?.sha, cwd, checks);
	inspectWorkflows(config, resolved?.sha, cwd, checks);
	inspectBootstrap(config, cwd, checks);

	return printReport(
		{ ok: !checks.some((check) => check.severity === 'error'), resolvedSource: resolved?.label, checks },
		options.json ?? false,
	);
}

function printReport(report: DoctorReport, json: boolean) {
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return report;
	}
	for (const check of report.checks) {
		const marker = check.severity === 'error' ? '✗' : check.severity === 'warning' ? '!' : '✓';
		process.stdout.write(`${marker} ${check.message}\n`);
	}
	process.stdout.write(
		report.ok ? 'Patchlane configuration is ready.\n' : 'Patchlane configuration needs attention.\n',
	);
	return report;
}
