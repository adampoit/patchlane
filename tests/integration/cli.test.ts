import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

test('sync --no-push does not publish the generated branch', () => {
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
				'',
			].join('\n'),
		);
		const workflowDir = path.join(forkWork, '.github', 'workflows');
		mkdirSync(workflowDir, { recursive: true });
		writeFileSync(
			path.join(workflowDir, 'ci.yml'),
			'name: Existing CI\non:\n  push:\n    branches: [main, sync/integration]\n',
		);
		writeFileSync(path.join(workflowDir, 'sync-upstream.yml'), 'name: Sync\npermissions:\n  contents: write\n');
		writeFileSync(
			path.join(workflowDir, 'promote-tested-sync.yml'),
			'name: Promote\non:\n  workflow_run:\n    workflows: [Existing CI]\npermissions:\n  contents: write\n',
		);

		const result = run('node', [cliPath, 'sync', `--upstream-remote-url=${upstreamBare}`, '--no-push'], forkWork);

		expect(result.status, [result.stderr, result.stdout].filter(Boolean).join('\n')).toBe(0);
		expect(result.stdout).toContain('No-push enabled');
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
