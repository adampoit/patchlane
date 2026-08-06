import { bashCommands, check, readPaths, workspaceChangeChecks } from '../assertions.ts';
import { createFixture } from '../fixtures.ts';
import type { Scenario } from '../types.ts';

export function featureChangeScenario(): Scenario {
	return {
		name: 'feature-change',
		description: 'Change existing fork behavior in a composed workspace and validate it without pushing.',
		intent: {
			name: 'feature-change',
			goal: 'Review the existing feature in the example application, improve it, and leave it ready for review.',
			preferences: [
				'Inspect the existing behavior before changing it.',
				'Keep the improvement focused.',
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
		setup: createFixture,
		assert: (context, run) => [
			...workspaceChangeChecks(context, run),
			check(
				[...bashCommands(run), ...readPaths(run)].some((entry) => /app\.js/.test(entry)),
				'inspected the existing feature before changing it',
			),
		],
	};
}
