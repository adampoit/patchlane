import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { gitResult } from '../src/git.js';

test('isolates direct low-level Git calls when no outer operation is active', () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-git-runner-'));
	try {
		const repository = path.join(tempRoot, 'repository');
		const ambientConfig = path.join(tempRoot, 'ambient.config');
		writeFileSync(ambientConfig, '[user]\n\tname = ambient-user\n');

		expect(gitResult(['init', repository], tempRoot).status).toBe(0);
		const result = gitResult(['config', '--get', 'user.name'], repository, {
			allowFailure: true,
			env: { ...process.env, GIT_CONFIG_GLOBAL: ambientConfig },
		});

		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe('');
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});
