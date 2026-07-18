import { expect, test } from 'vitest';
import { parsePatchlaneConfig } from '../src/config.js';

test('parses Patchlane configuration', () => {
	expect(
		parsePatchlaneConfig({
			version: 1,
			upstream: 'example/upstream',
			source: 'release:latest',
			patchRefs: ['patch/sync', 'patch/ci'],
			ciWorkflow: 'CI',
			allowedWorkflows: ['ci.yml'],
		}),
	).toEqual({
		upstreamOwner: 'example',
		upstreamRepo: 'upstream',
		source: 'release:latest',
		baseBranch: 'main',
		syncBranch: 'sync/integration',
		patchRefs: ['patch/sync', 'patch/ci'],
		ciWorkflow: 'CI',
		allowedWorkflows: ['ci.yml'],
	});
});

test('parses and validates allowed workflow filenames', () => {
	expect(
		parsePatchlaneConfig({
			version: 1,
			upstream: 'example/upstream',
			source: 'branch:main',
			patchRefs: ['patch/sync'],
			allowedWorkflows: ['ci.yml', 'sync-upstream.yaml'],
		}).allowedWorkflows,
	).toEqual(['ci.yml', 'sync-upstream.yaml']);

	expect(() =>
		parsePatchlaneConfig({
			version: 1,
			upstream: 'example/upstream',
			source: 'branch:main',
			patchRefs: ['patch/sync'],
			allowedWorkflows: ['../ci.yml'],
		}),
	).toThrow(/filenames/);
});

test('rejects incomplete Patchlane configuration', () => {
	expect(() => parsePatchlaneConfig({ version: 1 })).toThrow(/upstream/);
	expect(() =>
		parsePatchlaneConfig({
			version: 1,
			upstream: 'example/upstream',
			source: 'branch:main',
			patchRefs: ['patch/sync'],
		}),
	).toThrow(/allowedWorkflows/);
	expect(() =>
		parsePatchlaneConfig({
			version: 1,
			upstream: 'example/upstream',
			source: 'latest',
			patchRefs: ['patch/sync'],
		}),
	).toThrow(/Invalid upstream source/);
});
