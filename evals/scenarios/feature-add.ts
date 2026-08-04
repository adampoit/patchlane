import { workspaceChangeChecks } from '../assertions.ts';
import { createFixture } from '../fixtures.ts';
import type { Scenario } from '../types.ts';

export function featureAddScenario(): Scenario {
	return {
		name: 'feature-add',
		description: 'Add a focused fork feature in a composed workspace and validate it without pushing.',
		intent: {
			name: 'feature-add',
			goal: 'Add a small greeting feature to the example application and leave it ready for review.',
			preferences: [
				'Keep the change focused.',
				'Preserve the existing Patchlane composition.',
				'Use the configured product lane for this application feature.',
				'Before we finish, validate the composed workspace and review its landing as a dry run without landing it.',
			],
			authorization: [
				{
					id: 'workspace.create-and-commit',
					description: 'Create a composed development workspace and commit the reviewable change there.',
				},
			],
			prohibitions: ['Do not push, land, or change the configured patch refs.'],
			maxTurns: 8,
		},
		setup: () => createFixture({ existingProductPatch: false }),
		assert: workspaceChangeChecks,
	};
}
