import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	isProtectedPath,
	isReadOnlyShellCommand,
	normalizeToolPath,
	registerEvalIntentGuard,
	shellBlockReason,
	stagedProtectedFiles,
	type GitFileQuery,
} from '../.pi/extensions/eval-intent-guard.ts';
import { contractManifestChanges, createContractManifest, readContractManifest } from '../evals/contract-integrity.ts';
import { listScenarioIntentNames, loadScenarioIntent, validateScenarioIntent } from '../evals/intent.ts';
import { registeredScenarios, scenarioFactories } from '../evals/scenarios/index.ts';
import { followUpUserDriverPrompt, initialUserDriverPrompt, loadUserDriverBundle } from '../evals/user-driver.ts';

const temporaryDirectories: string[] = [];
const root = path.resolve(import.meta.dirname, '..');

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('eval scenario contracts', () => {
	test('registers exactly one strict intent file per scenario', () => {
		const registeredNames = Object.keys(scenarioFactories).sort();
		expect(listScenarioIntentNames()).toEqual(registeredNames);
		const scenarios = registeredScenarios();
		expect(scenarios.map(({ name }) => name).sort()).toEqual(registeredNames);
		for (const scenario of scenarios) expect(scenario.intent).toEqual(loadScenarioIntent(scenario.name));
	});

	test('rejects missing, unknown, and malformed intent fields', () => {
		const valid = loadScenarioIntent('health-check');
		expect(() => validateScenarioIntent({ ...valid, extra: true })).toThrow(/exactly/);
		const { maxTurns: _maxTurns, ...missing } = valid;
		expect(() => validateScenarioIntent(missing)).toThrow(/exactly/);
		expect(() => validateScenarioIntent({ ...valid, maxTurns: 0 })).toThrow(/positive/);
		expect(() =>
			validateScenarioIntent({ ...valid, authorization: [{ id: '../bad', description: 'Bad' }] }),
		).toThrow(/invalid ID/);
	});

	test('loads immutable driver templates and interpolates only allowed values', () => {
		const bundle = loadUserDriverBundle();
		expect(bundle.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(bundle.system).not.toContain('{{');
		expect(initialUserDriverPrompt(loadScenarioIntent('health-check'))).toContain(
			'Find out whether this Patchlane setup is healthy.',
		);
		expect(followUpUserDriverPrompt('A sanitized response.')).toContain('A sanitized response.');
	});

	test('matches the reviewed contract hash manifest', () => {
		expect(contractManifestChanges(readContractManifest(root), createContractManifest(root))).toEqual([]);
	});
});

describe('eval intent Pi guard', () => {
	test('normalizes relative, absolute, and traversal paths', () => {
		const nested = path.join(root, 'src');
		expect(normalizeToolPath('../evals/intents/setup.json', nested)).toBe(
			path.join(root, 'evals/intents/setup.json'),
		);
		expect(isProtectedPath('../evals/intents/setup.json', root, nested)).toBe(true);
		expect(isProtectedPath(path.join(root, 'evals/user-driver/system.md'), root, '/tmp')).toBe(true);
		expect(isProtectedPath('../skills/patchlane-workspace/SKILL.md', root, nested)).toBe(false);
	});

	test('classifies read-only inspection without allowing shell mutations', () => {
		expect(isReadOnlyShellCommand('git diff -- evals/intents/setup.json')).toBe(true);
		expect(isReadOnlyShellCommand('grep -R goal evals/intents | head')).toBe(true);
		expect(isReadOnlyShellCommand('find evals/intents -type f -print')).toBe(true);
		expect(isReadOnlyShellCommand('find evals/intents -type f -delete')).toBe(false);
		expect(isReadOnlyShellCommand('cat evals/intents/setup.json > /tmp/copy')).toBe(false);
	});

	test.each([
		'echo changed > evals/intents/setup.json',
		'tee evals/user-driver/system.md < /tmp/input',
		"sed -i '' s/old/new/ evals/intents/setup.json",
		'cp /tmp/replacement evals/intents/setup.json',
		'rm -f ./evals/user-driver/follow-up.md',
		"python -c \"open('evals/intents/setup.json','w').write('x')\"",
	])('blocks protected shell mutation: %s', async (command) => {
		expect(await shellBlockReason(command, root, root)).toMatch(/protected contracts/);
	});

	test('allows ordinary source mutations and protected reads', async () => {
		expect(await shellBlockReason('printf changed > src/example.ts', root, root)).toBeUndefined();
		expect(await shellBlockReason('git show HEAD:evals/intents/setup.json', root, root)).toBeUndefined();
	});

	test('blocks commits and broad staging when protected files are present', async () => {
		const stagedQuery: GitFileQuery = vi.fn(async (args) => ({
			stdout: args[0] === 'diff' ? 'evals/intents/setup.json\n' : '',
			code: 0,
		}));
		expect(await stagedProtectedFiles(root, stagedQuery)).toEqual(['evals/intents/setup.json']);
		expect(await shellBlockReason('git commit -m baseline', root, root, stagedQuery)).toBeDefined();

		const changedQuery: GitFileQuery = vi.fn(async (args) => ({
			stdout: args[0] === 'status' ? ' M evals/user-driver/system.md\n' : '',
			code: 0,
		}));
		expect(await shellBlockReason('git add .', root, root, changedQuery)).toBeDefined();
		expect(await shellBlockReason('git add evals', root, root, changedQuery)).toBeDefined();
		expect(await shellBlockReason('git commit --only evals', root, root, changedQuery)).toBeDefined();
		expect(await shellBlockReason('git add src', root, root, changedQuery)).toBeUndefined();
		expect(await shellBlockReason('git checkout another-branch', root, root, changedQuery)).toBeDefined();
		expect(await shellBlockReason('git restore -- src', root, root, changedQuery)).toBeUndefined();
		expect(await shellBlockReason('git restore -- .', root, root, changedQuery)).toBeDefined();
	});

	test('blocks a built-in write before a disposable session can change the file', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'patchlane-guard-'));
		temporaryDirectories.push(directory);
		const protectedDirectory = path.join(directory, 'evals/intents');
		const driverDirectory = path.join(directory, 'evals/user-driver');
		await import('node:fs/promises').then(({ mkdir }) =>
			Promise.all([mkdir(protectedDirectory, { recursive: true }), mkdir(driverDirectory, { recursive: true })]),
		);
		const target = path.join(protectedDirectory, 'setup.json');
		writeFileSync(target, 'original\n');

		let handler: ((event: any, context: any) => Promise<any>) | undefined;
		const pi = {
			on: (_name: string, candidate: typeof handler) => {
				handler = candidate;
			},
			exec: vi.fn(),
		};
		registerEvalIntentGuard(pi as never, directory);
		expect(handler).toBeDefined();
		const result = await handler!(
			{ toolName: 'write', input: { path: target, content: 'changed' } },
			{ cwd: directory },
		);
		expect(result).toMatchObject({ block: true });
		if (!result?.block) writeFileSync(target, 'changed\n');
		expect(readFileSync(target, 'utf8')).toBe('original\n');
	});
});
