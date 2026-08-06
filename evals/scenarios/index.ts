import { featureAddScenario } from './feature-add.ts';
import { featureChangeScenario } from './feature-change.ts';
import { healthCheckScenario } from './health-check.ts';
import { setupScenario } from './setup.ts';
import { syncRepairScenario } from './sync-repair.ts';
import type { Scenario } from '../types.ts';

export const scenarioFactories = {
	setup: setupScenario,
	'feature-add': featureAddScenario,
	'feature-change': featureChangeScenario,
	'sync-repair': syncRepairScenario,
	'health-check': healthCheckScenario,
} satisfies Record<string, () => Scenario>;

export function registeredScenarios() {
	return Object.values(scenarioFactories).map((factory) => factory());
}
