import { expect, test } from 'vitest';
import { parseUpstreamSource, resolveUpstreamSource } from '../src/upstream-source.js';

test('parses explicit release and branch sources', () => {
	expect(parseUpstreamSource('release:latest')).toEqual({
		kind: 'release',
		selector: 'latest',
		value: 'release:latest',
	});
	expect(parseUpstreamSource('release:^v2\\.')).toEqual({
		kind: 'release',
		selector: '^v2\\.',
		value: 'release:^v2\\.',
	});
	expect(parseUpstreamSource('branch:main')).toEqual({
		kind: 'branch',
		ref: 'main',
		value: 'branch:main',
	});
});

test('rejects ambiguous or incomplete sources', () => {
	expect(() => parseUpstreamSource('latest')).toThrow(/Invalid upstream source/);
	expect(() => parseUpstreamSource('release:')).toThrow(/cannot be empty/);
	expect(() => parseUpstreamSource('tag:v1.0.0')).toThrow(/Invalid upstream source kind/);
});

test('supports legacy release selector and branch ref options', () => {
	expect(resolveUpstreamSource(undefined, 'main', 'latest')).toMatchObject({
		kind: 'release',
		selector: 'latest',
	});
	expect(resolveUpstreamSource(undefined, 'stable', '')).toMatchObject({
		kind: 'branch',
		ref: 'stable',
	});
});
