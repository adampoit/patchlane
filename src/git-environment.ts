import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PATCHLANE_GIT_CONFIGURATION_DIAGNOSTIC =
	'Patchlane uses stock Git merge behavior; user/system Git configuration and global attributes are isolated, so external merge resolvers are not used by default.';

type GitIsolationEnvironment = {
	GIT_CONFIG_GLOBAL: string;
	GIT_CONFIG_SYSTEM: string;
	GIT_CONFIG_NOSYSTEM: '1';
	GIT_ATTR_NOSYSTEM: '1';
};

let activeIsolation: GitIsolationEnvironment | undefined;

function isGitConfigEnvironmentVariable(name: string) {
	return (
		name === 'GIT_CONFIG' ||
		name === 'GIT_CONFIG_GLOBAL' ||
		name === 'GIT_CONFIG_SYSTEM' ||
		name === 'GIT_CONFIG_NOSYSTEM' ||
		name === 'GIT_CONFIG_PARAMETERS' ||
		name === 'GIT_ATTR_SOURCE' ||
		/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)
	);
}

function isolatedEnvironment(overrides?: NodeJS.ProcessEnv) {
	const environment = { ...process.env, ...overrides };
	for (const name of Object.keys(environment)) {
		if (isGitConfigEnvironmentVariable(name)) delete environment[name];
	}
	if (activeIsolation) Object.assign(environment, activeIsolation);
	return environment;
}

export function patchlaneGitEnvironment(overrides?: NodeJS.ProcessEnv) {
	return activeIsolation ? isolatedEnvironment(overrides) : { ...process.env, ...overrides };
}

function quoteGitConfigPath(filePath: string) {
	const portablePath = filePath.replaceAll('\\', '/');
	return `"${portablePath.replaceAll('"', '\\\"')}"`;
}

export function withIsolatedGitConfig<T>(operation: () => T): T {
	if (activeIsolation) return operation();

	const directory = mkdtempSync(path.join(tmpdir(), 'patchlane-git-config-'));
	const globalConfig = path.join(directory, 'global.config');
	const systemConfig = path.join(directory, 'system.config');
	const globalAttributes = path.join(directory, 'attributes');
	try {
		writeFileSync(systemConfig, '');
		writeFileSync(globalAttributes, '');
		// Explicitly replace Git's default user attributes path as well as the global config.
		writeFileSync(globalConfig, `[core]\n\tattributesFile = ${quoteGitConfigPath(globalAttributes)}\n`);
	} catch (error) {
		rmSync(directory, { force: true, recursive: true });
		throw error;
	}

	const isolation: GitIsolationEnvironment = {
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_SYSTEM: systemConfig,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_ATTR_NOSYSTEM: '1',
	};
	const previousIsolation = activeIsolation;
	activeIsolation = isolation;

	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		rmSync(directory, { force: true, recursive: true });
	};
	const cleanupOnExit = () => cleanup();
	process.once('exit', cleanupOnExit);

	try {
		return operation();
	} finally {
		activeIsolation = previousIsolation;
		process.removeListener('exit', cleanupOnExit);
		cleanup();
	}
}
