import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { patchlaneGitEnvironment, withIsolatedGitConfig } from './git-environment.js';
import {
	parseAllowedWorkflows,
	PATCHLANE_CONFIG_FILE,
	serializePatchlaneConfig,
	type PatchlaneConfig,
} from './config.js';
import { getPackageVersion } from './package-version.js';
import { parseUpstreamSource } from './upstream-source.js';
import { renderPromotionWorkflow, renderSyncWorkflow } from './workflow-templates.js';

export type InitOptions = {
	upstream?: string;
	source?: string;
	baseBranch?: string;
	syncBranch?: string;
	patchRefs?: string;
	ciWorkflow?: string;
	allowedWorkflows?: string;
	force?: boolean;
	cwd?: string;
};

function git(args: string[], cwd: string) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: patchlaneGitEnvironment() });
	if (result.error) throw result.error;
	return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function parseGithubRepository(remoteUrl: string) {
	const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

function detectUpstream(cwd: string) {
	const remote = git(['remote', 'get-url', 'upstream'], cwd);
	return remote.status === 0 ? parseGithubRepository(remote.stdout) : undefined;
}

function detectCiWorkflow(cwd: string) {
	const workflowDir = path.join(cwd, '.github', 'workflows');
	if (!existsSync(workflowDir)) return undefined;

	const candidates = readdirSync(workflowDir)
		.filter((file) => /\.ya?ml$/.test(file))
		.map((file) => {
			const filePath = path.join(workflowDir, file);
			try {
				const workflow = parse(readFileSync(filePath, 'utf8')) as unknown;
				const name =
					typeof workflow === 'object' &&
					workflow !== null &&
					'name' in workflow &&
					typeof workflow.name === 'string'
						? workflow.name
						: undefined;
				return { file, name };
			} catch {
				return { file, name: undefined };
			}
		})
		.filter((candidate): candidate is { file: string; name: string } => Boolean(candidate.name));

	return (
		candidates.find((candidate) => /^ci\.ya?ml$/i.test(candidate.file)) ??
		candidates.find((candidate) => /\bci\b/i.test(candidate.name))
	);
}

function parsePatchRefs(value: string) {
	const refs = value
		.split(/\r?\n|,/)
		.map((ref) => ref.trim())
		.filter(Boolean);
	if (!refs.length) throw new Error('At least one patch branch is required.');
	return refs;
}

function writeNewFile(filePath: string, contents: string) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
}

function initializePatchlaneInternal(options: InitOptions = {}) {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const upstream = options.upstream ?? detectUpstream(cwd);
	if (!upstream) {
		throw new Error(
			"Could not detect an upstream GitHub repository. Pass --upstream=owner/repo or add an 'upstream' remote.",
		);
	}
	const separator = upstream.indexOf('/');
	if (separator < 1 || separator === upstream.length - 1) {
		throw new Error("--upstream must use the 'owner/repo' format.");
	}

	const source = options.source ?? 'release:latest';
	parseUpstreamSource(source);
	const detectedCiWorkflow = detectCiWorkflow(cwd);
	const configuredAllowedWorkflows =
		options.allowedWorkflows === undefined
			? [detectedCiWorkflow?.file ?? 'fork-ci.yml']
			: options.allowedWorkflows
					.split(/\r?\n|,/)
					.map((workflow) => workflow.trim())
					.filter(Boolean);
	const config: PatchlaneConfig = {
		upstreamOwner: upstream.slice(0, separator),
		upstreamRepo: upstream.slice(separator + 1),
		source,
		baseBranch: options.baseBranch ?? 'main',
		syncBranch: options.syncBranch ?? 'sync/integration',
		patchRefs: parsePatchRefs(options.patchRefs ?? 'patch/sync,patch/ci'),
		ciWorkflow: options.ciWorkflow ?? detectedCiWorkflow?.name ?? 'Fork CI',
		allowedWorkflows: parseAllowedWorkflows(configuredAllowedWorkflows),
	};

	const force = options.force ?? false;
	const packageVersion = getPackageVersion();
	const configPath = path.join(cwd, PATCHLANE_CONFIG_FILE);
	const syncWorkflowPath = path.join(cwd, '.github', 'workflows', 'sync-upstream.yml');
	const promotionWorkflowPath = path.join(cwd, '.github', 'workflows', 'promote-tested-sync.yml');
	if (!force) {
		const existingPath = [configPath, syncWorkflowPath, promotionWorkflowPath].find(existsSync);
		if (existingPath) {
			throw new Error(`${path.relative(cwd, existingPath)} already exists; pass --force to replace it.`);
		}
	}
	writeNewFile(configPath, serializePatchlaneConfig(config));
	writeNewFile(syncWorkflowPath, renderSyncWorkflow(config, packageVersion));
	writeNewFile(promotionWorkflowPath, renderPromotionWorkflow(config, packageVersion));

	process.stdout.write(
		[
			'Initialized Patchlane.',
			`Upstream source: ${config.source}`,
			`Patch order: ${config.patchRefs.join(', ')}`,
			`CI workflow: ${config.ciWorkflow}`,
			`Allowed repository workflows: ${config.allowedWorkflows.join(', ') || '(none)'}`,
			'Configure PATCHLANE_APP_CLIENT_ID and PATCHLANE_APP_PRIVATE_KEY in the fork repository.',
			'Run `npx patchlane doctor` before publishing any branches.',
		].join('\n') + '\n',
	);
	return config;
}

export function initializePatchlane(options: InitOptions = {}) {
	return withIsolatedGitConfig(() => initializePatchlaneInternal(options));
}
