import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDoctor } from '../src/doctor.js';

function git(args: string[], cwd: string) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function configureUser(repo: string) {
	git(['config', 'user.name', 'Patchlane Test'], repo);
	git(['config', 'user.email', 'patchlane@example.test'], repo);
}

test('reports a ready configuration and required bootstrap', () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-doctor-'));
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
		git(['switch', '-c', 'patch/sync', 'upstream/main'], forkWork);
		writeFileSync(path.join(forkWork, 'PATCH.md'), 'Patch\n');
		git(['add', 'PATCH.md'], forkWork);
		git(['commit', '-m', 'Add patch'], forkWork);
		git(['push', 'origin', 'patch/sync'], forkWork);
		git(['fetch', 'origin', 'main'], forkWork);

		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			'version: 1\nupstream: example/upstream\nsource: branch:main\npatchRefs: [patch/sync]\nciWorkflow: Existing CI\n',
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

		git(['remote', 'set-url', 'upstream', upstreamBare], forkWork);
		const report = runDoctor({ cwd: forkWork, json: true });
		expect(report.ok).toBe(true);
		expect(report.resolvedSource).toBe('branch main');
		expect(report.checks).toContainEqual(
			expect.objectContaining({ severity: 'info', message: expect.stringContaining("'patch/sync' contains 1") }),
		);
		expect(report.checks).toContainEqual(
			expect.objectContaining({ severity: 'warning', message: expect.stringContaining('Initial bootstrap') }),
		);
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});
