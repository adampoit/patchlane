import { workspaceChangeChecks } from '../assertions.ts';
import { createFixture } from '../fixtures.ts';
import { loadScenarioIntent } from '../intent.ts';
import type { Scenario } from '../types.ts';

export function featureAddScenario(): Scenario {
	const intent = loadScenarioIntent('feature-add');
	return {
		name: intent.name,
		description: 'Add a focused fork feature in a composed workspace and validate it without pushing.',
		intent,
		setup: () => createFixture({ existingProductPatch: false }),
		assert: workspaceChangeChecks,
	};
}
