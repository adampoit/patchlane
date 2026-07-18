import { expect, test } from 'vitest';
import { validateWorkflowPolicy } from '../src/workflow-policy.js';

test('accepts an exact composed workflow allowlist', () => {
	const violations = validateWorkflowPolicy(
		['ci.yml'],
		[
			{ file: 'sync-upstream.yml', content: 'name: Sync\n' },
			{ file: 'ci.yml', content: 'name: CI\n' },
			{ file: 'promote-tested-sync.yml', content: 'name: Promote\n' },
		],
	);

	expect(violations).toEqual([]);
});

test('requires implicitly allowed Patchlane workflows', () => {
	const violations = validateWorkflowPolicy(
		['ci.yml'],
		[
			{ file: 'ci.yml', content: 'name: CI\n' },
			{ file: 'sync-upstream.yml', content: 'name: Sync\n' },
		],
	);

	expect(violations.map(({ message }) => message)).toEqual([
		"Allowed workflow '.github/workflows/promote-tested-sync.yml' is missing from the composed tree.",
	]);
});

test('reports added, deleted, and dangling reusable workflows in a composed tree', () => {
	const violations = validateWorkflowPolicy(
		['ci.yml', 'deleted.yml', 'reusable.yml'],
		[
			{ file: 'promote-tested-sync.yml', content: 'name: Promote\n' },
			{ file: 'sync-upstream.yml', content: 'name: Sync\n' },
			{
				file: 'ci.yml',
				content: [
					'name: CI',
					'jobs:',
					'  allowed:',
					'    uses: ./.github/workflows/reusable.yml',
					'  missing:',
					'    uses: ./.github/workflows/missing.yml',
					'  disallowed:',
					'    uses: ./.github/workflows/unexpected.yml',
				].join('\n'),
			},
			{ file: 'reusable.yml', content: 'name: Reusable\n' },
			{ file: 'unexpected.yml', content: 'name: Unexpected\n' },
		],
	);

	expect(violations.map(({ message }) => message)).toEqual([
		"Unexpected workflow '.github/workflows/unexpected.yml' is not in allowedWorkflows.",
		"Allowed workflow '.github/workflows/deleted.yml' is missing from the composed tree.",
		"Workflow '.github/workflows/ci.yml' references missing local reusable workflow '.github/workflows/missing.yml'.",
		"Workflow '.github/workflows/ci.yml' references disallowed local reusable workflow '.github/workflows/unexpected.yml'.",
	]);
});

test('preserves existing behavior when allowedWorkflows is omitted', () => {
	expect(
		validateWorkflowPolicy(undefined, [
			{
				file: 'release.yml',
				content: 'jobs:\n  missing:\n    uses: ./.github/workflows/missing.yml\n',
			},
		]),
	).toEqual([]);
});
