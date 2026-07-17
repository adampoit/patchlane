import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { initializePatchlane } from '../src/init.js';

function git(args: string[], cwd: string) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

test('initializes config and pinned workflows from repository conventions', () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-init-'));
	try {
		git(['init'], tempRoot);
		git(['remote', 'add', 'upstream', 'git@github.com:example/upstream.git'], tempRoot);
		const workflowDir = path.join(tempRoot, '.github', 'workflows');
		mkdirSync(workflowDir, { recursive: true });
		writeFileSync(path.join(workflowDir, 'ci.yml'), 'name: Existing CI\non: [push]\n');

		const config = initializePatchlane({
			cwd: tempRoot,
			patchRefs: 'patch/sync, patch/ci, patch/product',
		});

		expect(config).toMatchObject({
			upstreamOwner: 'example',
			upstreamRepo: 'upstream',
			source: 'release:latest',
			ciWorkflow: 'Existing CI',
		});
		const configFile = parse(readFileSync(path.join(tempRoot, '.patchlane.yml'), 'utf8')) as {
			patchRefs: string[];
		};
		expect(configFile.patchRefs).toEqual(['patch/sync', 'patch/ci', 'patch/product']);

		const syncWorkflow = readFileSync(path.join(workflowDir, 'sync-upstream.yml'), 'utf8');
		expect(syncWorkflow).toContain('default: release:latest');
		expect(syncWorkflow).toContain('npx patchlane@0.3.1 sync');
		const promotionWorkflow = readFileSync(path.join(workflowDir, 'promote-tested-sync.yml'), 'utf8');
		expect(promotionWorkflow).toContain('workflows: ["Existing CI"]');
		expect(promotionWorkflow).toContain('npx patchlane@0.3.1 promote');

		expect(() => initializePatchlane({ cwd: tempRoot })).toThrow(/already exists/);
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});
