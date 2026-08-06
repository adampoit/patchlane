import { bashCommands, check, readPaths, workspaceChangeChecks } from '../assertions.ts';
import { createFixture } from '../fixtures.ts';
import { loadScenarioIntent } from '../intent.ts';
import type { Scenario } from '../types.ts';

export function featureChangeScenario(): Scenario {
	const intent = loadScenarioIntent('feature-change');
	return {
		name: intent.name,
		description: 'Change existing fork behavior in a composed workspace and validate it without pushing.',
		intent,
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
