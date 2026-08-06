import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserAuthorization, UserScenario } from './types.ts';

export const intentDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'intents');
const INTENT_FIELDS = ['name', 'goal', 'preferences', 'authorization', 'prohibitions', 'maxTurns'] as const;
const AUTHORIZATION_FIELDS = ['id', 'description'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactFields(value: Record<string, unknown>, fields: readonly string[], label: string) {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
		throw new Error(`${label} must contain exactly: ${fields.join(', ')}`);
	}
}

function validateStrings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.trim())) {
		throw new Error(`scenario intent ${field} must be an array of non-empty strings`);
	}
	return [...value];
}

function validateAuthorizations(value: unknown): UserAuthorization[] {
	if (!Array.isArray(value)) throw new Error('scenario intent authorization must be an array');
	const seen = new Set<string>();
	return value.map((candidate, index) => {
		if (!isRecord(candidate)) throw new Error(`scenario authorization ${index} must be an object`);
		assertExactFields(candidate, AUTHORIZATION_FIELDS, `scenario authorization ${index}`);
		const { id, description } = candidate;
		if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) {
			throw new Error(`scenario authorization ${index} has an invalid ID`);
		}
		if (seen.has(id)) throw new Error(`duplicate scenario authorization ID '${id}'`);
		if (typeof description !== 'string' || !description.trim()) {
			throw new Error(`scenario authorization '${id}' requires a description`);
		}
		seen.add(id);
		return { id, description };
	});
}

export function validateScenarioIntent(value: unknown, expectedName?: string): UserScenario & { maxTurns: number } {
	if (!isRecord(value)) throw new Error('scenario intent must be an object');
	assertExactFields(value, INTENT_FIELDS, 'scenario intent');
	if (typeof value.name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.name)) {
		throw new Error('scenario intent name is invalid');
	}
	if (expectedName !== undefined && value.name !== expectedName) {
		throw new Error(`scenario intent name '${value.name}' does not match '${expectedName}'`);
	}
	if (typeof value.goal !== 'string' || !value.goal.trim()) {
		throw new Error('scenario intent goal must be a non-empty string');
	}
	if (!Number.isInteger(value.maxTurns) || (value.maxTurns as number) <= 0) {
		throw new Error('scenario intent maxTurns must be a positive integer');
	}
	return {
		name: value.name,
		goal: value.goal,
		preferences: validateStrings(value.preferences, 'preferences'),
		authorization: validateAuthorizations(value.authorization),
		prohibitions: validateStrings(value.prohibitions, 'prohibitions'),
		maxTurns: value.maxTurns as number,
	};
}

export function loadScenarioIntent(name: string): UserScenario & { maxTurns: number } {
	if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`invalid intent name '${name}'`);
	const filePath = path.join(intentDirectory, `${name}.json`);
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(filePath, 'utf8'));
	} catch (error) {
		throw new Error(
			`could not load scenario intent '${name}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return validateScenarioIntent(value, name);
}

export function listScenarioIntentNames() {
	return readdirSync(intentDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map((entry) => entry.name.slice(0, -'.json'.length))
		.sort();
}

export function hashScenarioIntent(intent: UserScenario) {
	const validated = validateScenarioIntent(intent);
	return createHash('sha256')
		.update(`${JSON.stringify(validated)}\n`)
		.digest('hex');
}
