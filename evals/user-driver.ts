import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenarioIntent } from './intent.ts';
import type { UserScenario } from './types.ts';

const userDriverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'user-driver');
const FILE_NAMES = ['system.md', 'initial.md', 'follow-up.md'] as const;

type UserDriverBundle = {
	system: string;
	initial: string;
	followUp: string;
	hash: string;
};

let cachedBundle: UserDriverBundle | undefined;

function interpolate(template: string, values: Record<string, string>) {
	const expected = new Set(Object.keys(values));
	const placeholders = [...template.matchAll(/{{([A-Za-z][A-Za-z0-9]*)}}/g)].map((match) => match[1]);
	if (
		placeholders.length !== expected.size ||
		placeholders.some((placeholder) => !expected.has(placeholder)) ||
		[...expected].some((placeholder) => !placeholders.includes(placeholder))
	) {
		throw new Error(`user-driver template placeholders do not match: ${[...expected].join(', ')}`);
	}
	return template.replace(/{{([A-Za-z][A-Za-z0-9]*)}}/g, (_match, name: string) => values[name]);
}

export function loadUserDriverBundle(): UserDriverBundle {
	if (cachedBundle) return cachedBundle;
	const contents = Object.fromEntries(
		FILE_NAMES.map((name) => [name, readFileSync(path.join(userDriverDirectory, name), 'utf8')]),
	) as Record<(typeof FILE_NAMES)[number], string>;
	const hash = createHash('sha256');
	for (const name of FILE_NAMES) hash.update(name).update('\0').update(contents[name]).update('\0');
	cachedBundle = {
		system: contents['system.md'].trimEnd(),
		initial: contents['initial.md'].trimEnd(),
		followUp: contents['follow-up.md'].trimEnd(),
		hash: hash.digest('hex'),
	};
	return cachedBundle;
}

export function initialUserDriverPrompt(scenario: UserScenario) {
	const validated = validateScenarioIntent(scenario);
	return interpolate(loadUserDriverBundle().initial, { scenario: JSON.stringify(validated) });
}

export function followUpUserDriverPrompt(sanitizedWorkerResponse: string) {
	return interpolate(loadUserDriverBundle().followUp, { workerResponse: sanitizedWorkerResponse });
}
