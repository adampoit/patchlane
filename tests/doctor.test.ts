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

test('composes non-overlapping changes to the same workflow from independent patches', () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-doctor-composed-'));
	try {
		const upstreamBare = path.join(tempRoot, 'upstream.git');
		const upstreamWork = path.join(tempRoot, 'upstream-work');
		const forkBare = path.join(tempRoot, 'fork.git');
		const forkWork = path.join(tempRoot, 'fork-work');
		git(['init', '--bare', '--initial-branch=main', upstreamBare], tempRoot);
		git(['clone', upstreamBare, upstreamWork], tempRoot);
		configureUser(upstreamWork);
		const upstreamWorkflowDir = path.join(upstreamWork, '.github', 'workflows');
		mkdirSync(upstreamWorkflowDir, { recursive: true });
		writeFileSync(path.join(upstreamWork, 'README.md'), '# Upstream\n');
		writeFileSync(
			path.join(upstreamWorkflowDir, 'ci.yml'),
			'name: Existing CI\nrun-name: Continuous integration\npermissions:\n  contents: read\nconcurrency:\n  group: continuous-integration\n  cancel-in-progress: true\non:\n  push:\n    branches: [feature]\n',
		);
		git(['add', '.'], upstreamWork);
		git(['commit', '-m', 'Initial upstream'], upstreamWork);
		git(['push', 'origin', 'main'], upstreamWork);

		git(['init', '--bare', '--initial-branch=main', forkBare], tempRoot);
		git(['clone', upstreamBare, forkWork], tempRoot);
		configureUser(forkWork);
		git(['remote', 'rename', 'origin', 'upstream'], forkWork);
		git(['remote', 'add', 'origin', forkBare], forkWork);
		git(['push', 'origin', 'main'], forkWork);

		git(['switch', '-c', 'patch/sync', 'upstream/main'], forkWork);
		const workflowDir = path.join(forkWork, '.github', 'workflows');
		writeFileSync(path.join(workflowDir, 'sync-upstream.yml'), 'name: Sync\npermissions:\n  contents: write\n');
		writeFileSync(
			path.join(workflowDir, 'promote-tested-sync.yml'),
			'name: Promote\non:\n  workflow_run:\n    workflows: [Product CI]\npermissions:\n  contents: write\n',
		);
		git(['add', '.github/workflows'], forkWork);
		git(['commit', '-m', 'Add sync workflows'], forkWork);
		git(['push', 'origin', 'patch/sync'], forkWork);

		git(['switch', '-c', 'patch/ci', 'upstream/main'], forkWork);
		writeFileSync(
			path.join(workflowDir, 'ci.yml'),
			'name: Existing CI\nrun-name: Continuous integration\npermissions:\n  contents: read\nconcurrency:\n  group: continuous-integration\n  cancel-in-progress: true\non:\n  push:\n    branches: [main, sync/integration]\n',
		);
		git(['add', '.github/workflows/ci.yml'], forkWork);
		git(['commit', '-m', 'Run CI on integration branches'], forkWork);
		git(['push', 'origin', 'patch/ci'], forkWork);

		git(['switch', '-c', 'patch/product', 'upstream/main'], forkWork);
		writeFileSync(path.join(forkWork, 'PRODUCT.md'), 'Product patch\n');
		git(['add', 'PRODUCT.md'], forkWork);
		git(['commit', '-m', 'Add product patch'], forkWork);
		git(['push', 'origin', 'patch/product'], forkWork);

		git(['switch', '-c', 'patch/product-workflow', 'upstream/main'], forkWork);
		writeFileSync(
			path.join(workflowDir, 'ci.yml'),
			'name: Product CI\nrun-name: Continuous integration\npermissions:\n  contents: read\nconcurrency:\n  group: continuous-integration\n  cancel-in-progress: true\non:\n  push:\n    branches: [feature]\n',
		);
		git(['add', '.github/workflows/ci.yml'], forkWork);
		git(['commit', '-m', 'Rename product CI workflow'], forkWork);
		git(['push', 'origin', 'patch/product-workflow'], forkWork);

		git(['switch', 'patch/sync'], forkWork);
		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			[
				'version: 1',
				'upstream: example/upstream',
				'source: branch:main',
				'patchRefs: [patch/sync, patch/ci, patch/product, patch/product-workflow]',
				'ciWorkflow: Product CI',
				'allowedWorkflows: [ci.yml]',
				'',
			].join('\n'),
		);

		const report = runDoctor({ cwd: forkWork, json: true });
		expect(report.ok).toBe(true);
		expect(report.checks).not.toContainEqual(
			expect.objectContaining({ message: expect.stringContaining('must run on pushes') }),
		);

		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			[
				'version: 1',
				'upstream: example/upstream',
				'source: branch:main',
				'patchRefs: [patch/sync, patch/ci, patch/product, patch/product-workflow]',
				'ciWorkflow: Product CI',
				'allowedWorkflows: [missing.yml]',
				'',
			].join('\n'),
		);
		const deniedReport = runDoctor({ cwd: forkWork, json: true });
		expect(deniedReport.ok).toBe(false);
		expect(deniedReport.checks).toContainEqual(
			expect.objectContaining({ severity: 'error', message: expect.stringContaining('ci.yml') }),
		);
		expect(deniedReport.checks).toContainEqual(
			expect.objectContaining({ severity: 'error', message: expect.stringContaining('missing.yml') }),
		);
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});

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
			'version: 1\nupstream: example/upstream\nsource: branch:main\npatchRefs: [patch/sync]\nciWorkflow: Existing CI\nallowedWorkflows: [ci.yml]\n',
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

		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			[
				'version: 1',
				'upstream: example/upstream',
				'source: branch:main',
				'patchRefs: [patch/sync]',
				'ciWorkflow: Existing CI',
				'allowedWorkflows: [ci.yml]',
				'notifications:',
				'  githubIssues:',
				'    events: [sync-failed, ci-failed]',
				'',
			].join('\n'),
		);
		const notificationReport = runDoctor({ cwd: forkWork, json: true });
		expect(notificationReport.ok).toBe(false);
		expect(notificationReport.checks).toContainEqual(
			expect.objectContaining({ severity: 'error', message: expect.stringContaining('issues: write') }),
		);
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});
