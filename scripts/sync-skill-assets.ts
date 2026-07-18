import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { format } from 'prettier';
import type { PatchlaneConfig } from '../src/config.ts';
import { renderPromotionWorkflow, renderSyncWorkflow } from '../src/workflow-templates.ts';

const rootDir = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const packagePath = path.join(rootDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
if (typeof packageJson.version !== 'string' || !packageJson.version) {
	throw new Error('Patchlane package version is missing.');
}

const exampleConfig: PatchlaneConfig = {
	upstreamOwner: 'example',
	upstreamRepo: 'upstream',
	source: 'release:latest',
	baseBranch: 'main',
	syncBranch: 'sync/integration',
	patchRefs: ['patch/sync', 'patch/ci'],
	ciWorkflow: 'Fork CI',
	allowedWorkflows: ['fork-ci.yml'],
};

const prettierOptions = {
	filepath: path.join(rootDir, 'examples/sync-upstream.yml'),
	singleQuote: true,
};
const syncWorkflow = await format(renderSyncWorkflow(exampleConfig, packageJson.version), prettierOptions);
const promotionWorkflow = await format(renderPromotionWorkflow(exampleConfig, packageJson.version), prettierOptions);
const forkCiWorkflow = readFileSync(path.join(rootDir, 'examples/fork-ci.yml'), 'utf8');

const generatedFiles = new Map([
	['examples/sync-upstream.yml', syncWorkflow],
	['examples/promote-tested-sync.yml', promotionWorkflow],
	['skills/patchlane-fork-setup/assets/sync-upstream.yml', syncWorkflow],
	['skills/patchlane-fork-setup/assets/promote-tested-sync.yml', promotionWorkflow],
	['skills/patchlane-fork-setup/assets/fork-ci.yml', forkCiWorkflow],
]);

const stalePaths: string[] = [];
for (const [relativePath, contents] of generatedFiles) {
	const filePath = path.join(rootDir, relativePath);
	if (existsSync(filePath) && readFileSync(filePath, 'utf8') === contents) continue;
	if (check) {
		stalePaths.push(relativePath);
	} else {
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, contents);
	}
}

const packageLockPath = path.join(rootDir, 'package-lock.json');
const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8')) as {
	version?: unknown;
	packages?: { ''?: { version?: unknown } };
};
if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
	if (check) {
		stalePaths.push('package-lock.json');
	} else {
		packageLock.version = packageJson.version;
		if (!packageLock.packages?.['']) throw new Error('Package lock root package is missing.');
		packageLock.packages[''].version = packageJson.version;
		writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
	}
}

if (stalePaths.length) {
	throw new Error(`Generated artifacts are stale:\n${stalePaths.map((file) => `- ${file}`).join('\n')}`);
}
