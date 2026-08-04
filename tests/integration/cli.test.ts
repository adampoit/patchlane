import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { PatchlaneConfig } from '../../src/config.js';
import { renderPromotionWorkflow, renderSyncWorkflow } from '../../src/workflow-templates.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
	if (result.error) throw result.error;
	return result;
}

function git(args: string[], cwd: string) {
	const result = run('git', args, cwd);
	if (result.status !== 0) {
		throw new Error([result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n'));
	}
	return result.stdout.trim();
}

function configureUser(repo: string) {
	git(['config', 'user.name', 'Patchlane Test'], repo);
	git(['config', 'user.email', 'patchlane@example.test'], repo);
}

test('reports the installed package version', () => {
	const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
	const result = run('node', [cliPath, '--version'], repoRoot);

	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim()).toContain(`patchlane/${packageJson.version}`);
});

test('agents installs bundled skills without fetching GitHub', () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-agents-'));
	try {
		const installDir = path.join(tempRoot, 'skills');
		const env = { ...process.env };
		delete env.PATCHLANE_SKILLS_BASE_URL;
		delete env.PATCHLANE_SKILLS_REF;

		const result = run('node', [cliPath, 'agents', '--dir', installDir], tempRoot, env);

		expect(result.status, [result.stderr, result.stdout].filter(Boolean).join('\\n')).toBe(0);
		expect(result.stdout).toContain('Using bundled Patchlane agent skills');
		expect(readFileSync(path.join(installDir, 'patchlane-workspace', 'SKILL.md'), 'utf8')).toContain(
			'Patchlane Composed Workspace',
		);
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});

test('sync skip-push flags do not publish the generated branch', () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-cli-'));
	try {
		const upstreamBare = path.join(tempRoot, 'upstream.git');
		const upstreamWork = path.join(tempRoot, 'upstream-work');
		const forkBare = path.join(tempRoot, 'fork.git');
		const forkWork = path.join(tempRoot, 'fork-work');

		git(['init', '--bare', '--initial-branch=main', upstreamBare], tempRoot);
		git(['clone', upstreamBare, upstreamWork], tempRoot);
		configureUser(upstreamWork);
		writeFileSync(path.join(upstreamWork, 'README.md'), '# Upstream\n');
		git(['add', 'README.md'], upstreamWork);
		git(['commit', '-m', 'Initial upstream'], upstreamWork);
		git(['push', 'origin', 'main'], upstreamWork);

		git(['init', '--bare', '--initial-branch=main', forkBare], tempRoot);
		git(['clone', upstreamBare, forkWork], tempRoot);
		configureUser(forkWork);
		git(['remote', 'rename', 'origin', 'upstream'], forkWork);
		git(['remote', 'add', 'origin', forkBare], forkWork);
		git(['push', 'origin', 'main'], forkWork);
		git(['switch', '-c', 'patch/product', 'upstream/main'], forkWork);
		writeFileSync(path.join(forkWork, 'PRODUCT.md'), 'Fork patch\n');
		git(['add', 'PRODUCT.md'], forkWork);
		git(['commit', '-m', 'Add product patch'], forkWork);
		git(['push', 'origin', 'patch/product'], forkWork);
		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			[
				'version: 1',
				'upstream: example/upstream',
				'source: branch:main',
				'baseBranch: main',
				'syncBranch: sync/integration',
				'patchRefs:',
				'  - patch/product',
				'ciWorkflow: Existing CI',
				'allowedWorkflows: [ci.yml]',
				'',
			].join('\n'),
		);
		const workflowDir = path.join(forkWork, '.github', 'workflows');
		mkdirSync(workflowDir, { recursive: true });
		writeFileSync(
			path.join(workflowDir, 'ci.yml'),
			'name: Existing CI\non:\n  push:\n    branches: [main, sync/integration]\n',
		);
		const workflowConfig: PatchlaneConfig = {
			upstreamOwner: 'example',
			upstreamRepo: 'upstream',
			source: 'branch:main',
			baseBranch: 'main',
			syncBranch: 'sync/integration',
			patchRefs: ['patch/product'],
			ciWorkflow: 'Existing CI',
			allowedWorkflows: ['ci.yml'],
		};
		writeFileSync(path.join(workflowDir, 'sync-upstream.yml'), renderSyncWorkflow(workflowConfig, '1.2.3'));
		writeFileSync(
			path.join(workflowDir, 'promote-tested-sync.yml'),
			renderPromotionWorkflow(workflowConfig, '1.2.3'),
		);
		git(['add', '.patchlane.yml', '.github/workflows'], forkWork);
		git(['commit', '-m', 'Configure Patchlane'], forkWork);
		git(['push', 'origin', 'patch/product'], forkWork);

		const result = run('node', [cliPath, 'sync', `--upstream-remote-url=${upstreamBare}`, '--skip-push'], forkWork);

		expect(result.status, [result.stderr, result.stdout].filter(Boolean).join('\n')).toBe(0);
		expect(result.stdout).toContain('No-push enabled');
		expect(
			run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/sync/integration'], forkBare).status,
		).not.toBe(0);

		const legacyNoPush = run(
			'node',
			[cliPath, 'sync', `--upstream-remote-url=${upstreamBare}`, '--no-push'],
			forkWork,
		);
		expect(legacyNoPush.status, [legacyNoPush.stderr, legacyNoPush.stdout].filter(Boolean).join('\n')).toBe(0);
		expect(
			run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/sync/integration'], forkBare).status,
		).not.toBe(0);

		const bootstrap = run('node', [cliPath, 'bootstrap'], forkWork, {
			...process.env,
			UPSTREAM_REMOTE_URL: upstreamBare,
		});
		expect(bootstrap.status, [bootstrap.stderr, bootstrap.stdout].filter(Boolean).join('\n')).toBe(0);
		expect(bootstrap.stdout).toContain('Bootstrap validation passed');
		expect(
			run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/sync/integration'], forkBare).status,
		).not.toBe(0);
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});
