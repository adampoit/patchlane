import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { withIsolatedGitConfig } from './git-environment.js';
import { gitResult } from './git.js';
import { parseUpstreamSource } from './upstream-source.js';

export const PATCHLANE_CONFIG_FILE = '.patchlane.yml';

export const NOTIFICATION_EVENTS = ['sync-failed', 'ci-failed', 'promotion-failed'] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type GithubIssueNotifications = {
	assignees: string[];
	labels: string[];
	events: NotificationEvent[];
	closeOnRecovery: boolean;
};

export type PatchlaneConfig = {
	upstreamOwner: string;
	upstreamRepo: string;
	source: string;
	baseBranch: string;
	syncBranch: string;
	patchRefs: string[];
	ciWorkflow?: string;
	allowedWorkflows: string[];
	notifications?: {
		githubIssues: GithubIssueNotifications;
	};
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

function parseStringArray(value: unknown, field: string) {
	if (!Array.isArray(value)) throw new Error(`Patchlane config field '${field}' must be an array.`);
	const values = value.map((item) => {
		if (typeof item !== 'string' || !item.trim()) {
			throw new Error(`Patchlane config field '${field}' must contain only non-empty strings.`);
		}
		return item.trim();
	});
	if (new Set(values).size !== values.length) {
		throw new Error(`Patchlane config field '${field}' must not contain duplicates.`);
	}
	return values;
}

function parseNotifications(value: unknown): PatchlaneConfig['notifications'] {
	if (value === undefined) return undefined;
	if (!isPlainObject(value) || !isPlainObject(value.githubIssues)) {
		throw new Error("Patchlane config field 'notifications.githubIssues' must be a YAML object.");
	}
	const provider = value.githubIssues;
	const assignees = parseStringArray(provider.assignees ?? [], 'notifications.githubIssues.assignees');
	const labels = parseStringArray(provider.labels ?? [], 'notifications.githubIssues.labels');
	const rawEvents = parseStringArray(provider.events, 'notifications.githubIssues.events');
	if (!rawEvents.length) {
		throw new Error("Patchlane config field 'notifications.githubIssues.events' must not be empty.");
	}
	const events = rawEvents.map((event) => {
		if (!(NOTIFICATION_EVENTS as readonly string[]).includes(event)) {
			throw new Error(
				`Patchlane config field 'notifications.githubIssues.events' contains invalid event '${event}'.`,
			);
		}
		return event as NotificationEvent;
	});
	if (provider.closeOnRecovery !== undefined && typeof provider.closeOnRecovery !== 'boolean') {
		throw new Error("Patchlane config field 'notifications.githubIssues.closeOnRecovery' must be a boolean.");
	}
	return {
		githubIssues: {
			assignees,
			labels,
			events,
			closeOnRecovery: provider.closeOnRecovery ?? false,
		},
	};
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
		const ref = patchRef.trim();
		if (
			ref.startsWith('-') ||
			ref.startsWith('refs/') ||
			ref.startsWith('/') ||
			ref.endsWith('/') ||
			ref.includes('\\') ||
			ref.includes('..') ||
			ref.includes('@{') ||
			ref.split('/').some((part) => !part || part === '.' || part === '..')
		) {
			throw new Error(`Patchlane config field 'patchRefs' contains invalid ref '${ref}'.`);
		}
		return ref;
	});
	if (new Set(patchRefs).size !== patchRefs.length) {
		throw new Error("Patchlane config field 'patchRefs' must not contain duplicates.");
	}

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
		notifications: parseNotifications(value.notifications),
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
		...(config.notifications ? { notifications: config.notifications } : {}),
	});
}

export function parsePatchlaneConfigText(contents: string, source = PATCHLANE_CONFIG_FILE): PatchlaneConfig {
	let parsed: unknown;
	try {
		parsed = parse(contents) as unknown;
	} catch (error) {
		throw new Error(`Failed to parse ${source}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parsePatchlaneConfig(parsed);
	} catch (error) {
		throw new Error(`Invalid ${source}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function loadPatchlaneConfig(cwd = process.cwd(), configPath?: string): PatchlaneConfig | undefined {
	const resolvedPath = path.resolve(cwd, configPath ?? process.env.PATCHLANE_CONFIG ?? PATCHLANE_CONFIG_FILE);
	if (!existsSync(resolvedPath)) return undefined;
	return parsePatchlaneConfigText(
		readFileSync(resolvedPath, 'utf8'),
		path.relative(cwd, resolvedPath) || resolvedPath,
	);
}

export function loadPatchlaneConfigAtRef(cwd = process.cwd(), ref: string): PatchlaneConfig {
	return withIsolatedGitConfig(() => {
		const result = gitResult(['show', `${ref}:${PATCHLANE_CONFIG_FILE}`], cwd);
		if (result.status !== 0) {
			const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
			throw new Error(`Could not load ${PATCHLANE_CONFIG_FILE} at ref '${ref}': ${detail || 'git show failed'}`);
		}
		return parsePatchlaneConfigText(result.stdout, `${ref}:${PATCHLANE_CONFIG_FILE}`);
	});
}
