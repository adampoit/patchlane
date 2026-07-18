import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { parseUpstreamSource } from './upstream-source.js';

export const PATCHLANE_CONFIG_FILE = '.patchlane.yml';

export type PatchlaneConfig = {
	upstreamOwner: string;
	upstreamRepo: string;
	source: string;
	baseBranch: string;
	syncBranch: string;
	patchRefs: string[];
	ciWorkflow?: string;
	allowedWorkflows: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(config: Record<string, unknown>, key: string) {
	const value = config[key];
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Patchlane config field '${key}' must be a non-empty string.`);
	}
	return value.trim();
}

export function parsePatchlaneConfig(value: unknown): PatchlaneConfig {
	if (!isPlainObject(value)) throw new Error('Patchlane config must be a YAML object.');
	if (value.version !== 1) throw new Error("Patchlane config field 'version' must be 1.");

	const upstream = requireString(value, 'upstream');
	const separator = upstream.indexOf('/');
	if (separator < 1 || separator === upstream.length - 1) {
		throw new Error("Patchlane config field 'upstream' must use the 'owner/repo' format.");
	}
	const upstreamOwner = upstream.slice(0, separator);
	const upstreamRepo = upstream.slice(separator + 1);

	const source = requireString(value, 'source');
	parseUpstreamSource(source);

	const rawPatchRefs = value.patchRefs;
	if (!Array.isArray(rawPatchRefs) || rawPatchRefs.length === 0) {
		throw new Error("Patchlane config field 'patchRefs' must contain at least one branch name.");
	}
	const patchRefs = rawPatchRefs.map((patchRef) => {
		if (typeof patchRef !== 'string' || !patchRef.trim()) {
			throw new Error("Patchlane config field 'patchRefs' must contain only non-empty strings.");
		}
		return patchRef.trim();
	});

	const ciWorkflow = value.ciWorkflow;
	if (ciWorkflow !== undefined && (typeof ciWorkflow !== 'string' || !ciWorkflow.trim())) {
		throw new Error("Patchlane config field 'ciWorkflow' must be a non-empty string when provided.");
	}

	const allowedWorkflows = parseAllowedWorkflows(value.allowedWorkflows);

	return {
		upstreamOwner,
		upstreamRepo,
		source,
		baseBranch: typeof value.baseBranch === 'string' && value.baseBranch.trim() ? value.baseBranch.trim() : 'main',
		syncBranch:
			typeof value.syncBranch === 'string' && value.syncBranch.trim()
				? value.syncBranch.trim()
				: 'sync/integration',
		patchRefs,
		ciWorkflow: typeof ciWorkflow === 'string' ? ciWorkflow.trim() : undefined,
		allowedWorkflows,
	};
}

export function parseAllowedWorkflows(value: unknown) {
	if (!Array.isArray(value)) {
		throw new Error(
			"Patchlane config field 'allowedWorkflows' must be an array. See https://github.com/adampoit/patchlane/blob/main/docs/migrations.md for migration instructions.",
		);
	}
	const allowedWorkflows = value.map((workflow) => {
		if (typeof workflow !== 'string' || !workflow.trim()) {
			throw new Error(
				"Patchlane config field 'allowedWorkflows' must contain only non-empty workflow filenames.",
			);
		}
		const filename = workflow.trim();
		if (path.basename(filename) !== filename || filename.includes('\\') || !/\.ya?ml$/.test(filename)) {
			throw new Error(
				"Patchlane config field 'allowedWorkflows' must contain filenames ending in .yml or .yaml.",
			);
		}
		return filename;
	});
	if (new Set(allowedWorkflows).size !== allowedWorkflows.length) {
		throw new Error("Patchlane config field 'allowedWorkflows' must not contain duplicate filenames.");
	}
	return allowedWorkflows;
}

export function serializePatchlaneConfig(config: PatchlaneConfig) {
	return stringify({
		version: 1,
		upstream: `${config.upstreamOwner}/${config.upstreamRepo}`,
		source: config.source,
		baseBranch: config.baseBranch,
		syncBranch: config.syncBranch,
		patchRefs: config.patchRefs,
		...(config.ciWorkflow ? { ciWorkflow: config.ciWorkflow } : {}),
		allowedWorkflows: config.allowedWorkflows,
	});
}

export function loadPatchlaneConfig(cwd = process.cwd(), configPath?: string): PatchlaneConfig | undefined {
	const resolvedPath = path.resolve(cwd, configPath ?? process.env.PATCHLANE_CONFIG ?? PATCHLANE_CONFIG_FILE);
	if (!existsSync(resolvedPath)) return undefined;

	let parsed: unknown;
	try {
		parsed = parse(readFileSync(resolvedPath, 'utf8')) as unknown;
	} catch (error) {
		throw new Error(
			`Failed to parse ${path.relative(cwd, resolvedPath) || resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parsePatchlaneConfig(parsed);
}
