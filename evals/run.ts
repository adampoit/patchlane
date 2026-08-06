#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { writeText } from './fixtures.ts';
import { defaultModel, defaultUserModel, skillPaths, cliPath } from './config.ts';
import { parseUserDriverTranscript, runAgent, serializeRun, serializeTranscript } from './runner.ts';
import { registeredScenarios } from './scenarios/index.ts';
import type { Check, Scenario, UserDriverTranscript } from './types.ts';

function parseNumber(value: string | undefined, name: string, minimum: number) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`${name} must be at least ${minimum}.`);
	return parsed;
}

function parseArguments() {
	const args = process.argv.slice(2);
	let scenarioName = 'all';
	let model = defaultModel;
	let userModel = defaultUserModel;
	let timeoutMs = 5 * 60_000;
	let totalTimeoutMs: number | undefined;
	let userTimeoutMs: number | undefined;
	let maxTurns: number | undefined;
	let maxUserMessageChars: number | undefined;
	let maxUserTokens: number | undefined;
	let maxUserCost: number | undefined;
	let failFast = false;
	let keep = false;
	let apiKey: string | undefined;
	let apiKeyEnv = 'PATCHLANE_EVAL_API_KEY';
	let authPath: string | undefined;
	let userApiKey: string | undefined;
	let userApiKeyEnv: string | undefined;
	let userAuthPath: string | undefined;
	let replayPath: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--scenario') scenarioName = args[++index] ?? scenarioName;
		else if (arg === '--model') model = args[++index] ?? model;
		else if (arg === '--user-model' || arg === '--driver-model') userModel = args[++index] ?? userModel;
		else if (arg === '--timeout') timeoutMs = parseNumber(args[++index], '--timeout', 1);
		else if (arg === '--total-timeout') totalTimeoutMs = parseNumber(args[++index], '--total-timeout', 1);
		else if (arg === '--user-timeout' || arg === '--driver-timeout') {
			userTimeoutMs = parseNumber(args[++index], '--user-timeout', 1);
		} else if (arg === '--max-turns') maxTurns = parseNumber(args[++index], '--max-turns', 1);
		else if (arg === '--max-user-message-chars') {
			maxUserMessageChars = parseNumber(args[++index], '--max-user-message-chars', 1);
		} else if (arg === '--max-user-tokens' || arg === '--user-max-tokens' || arg === '--max-tokens') {
			maxUserTokens = parseNumber(args[++index], '--max-user-tokens', 1);
		} else if (arg === '--max-user-cost' || arg === '--user-max-cost' || arg === '--max-cost') {
			maxUserCost = parseNumber(args[++index], '--max-user-cost', 0);
		} else if (arg === '--api-key') apiKey = args[++index];
		else if (arg === '--api-key-env') apiKeyEnv = args[++index] ?? apiKeyEnv;
		else if (arg === '--auth-path') authPath = args[++index];
		else if (arg === '--user-api-key' || arg === '--driver-api-key') userApiKey = args[++index];
		else if (arg === '--user-api-key-env' || arg === '--driver-api-key-env') {
			userApiKeyEnv = args[++index];
		} else if (arg === '--user-auth-path' || arg === '--driver-auth-path') {
			userAuthPath = args[++index];
		} else if (arg === '--replay' || arg === '--replay-transcript') replayPath = args[++index];
		else if (arg === '--fail-fast') failFast = true;
		else if (arg === '--keep') keep = true;
		else if (arg === '--help' || arg === '-h') {
			console.log(
				`Usage: npm run evals -- [options]\n\nOptions:\n  --scenario <name|all>       Scenario to run (default: all)\n  --model <provider/id>       Worker Pi model (default: ${defaultModel})\n  --user-model <provider/id>  User-driver model (default: ${defaultUserModel})\n  --timeout <ms>              Worker turn timeout (default: ${timeoutMs})\n  --total-timeout <ms>        Total scenario timeout (default: 2 x --timeout)\n  --user-timeout <ms>         User-driver turn timeout (default: --timeout)\n  --max-turns <n>             Maximum user-driver turns (default: scenario value)\n  --max-user-message-chars <n>  Maximum generated user-message length\n  --max-user-tokens <n>       User-driver token budget\n  --max-user-cost <n>         User-driver cost budget\n  --api-key <key>             Worker runtime provider API key\n  --api-key-env <name>        Worker API key environment variable (default: ${apiKeyEnv})\n  --auth-path <path>          Worker credentials file; never read by default\n  --user-api-key <key>        User-driver runtime provider API key\n  --user-api-key-env <name>   User-driver API key environment variable (defaults to worker env)\n  --user-auth-path <path>     User-driver credentials file\n  --replay <path>             Replay a stored user-driver transcript without a user-model request\n  --fail-fast                 Stop after the first failed scenario\n  --keep                      Keep temporary fixtures for inspection`,
			);
			process.exit(0);
		}
	}
	return {
		scenarioName,
		model,
		userModel,
		timeoutMs,
		totalTimeoutMs: totalTimeoutMs ?? timeoutMs * 2,
		userTimeoutMs,
		maxTurns,
		maxUserMessageChars,
		maxUserTokens,
		maxUserCost,
		failFast,
		keep,
		apiKey,
		apiKeyEnv,
		authPath,
		userApiKey,
		userApiKeyEnv,
		userAuthPath,
		replayPath,
	};
}

export function modelMatches(requested: string, observed: string | undefined) {
	if (!observed) return false;
	const withoutThinking = requested.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, '');
	if (withoutThinking.includes('/')) return observed === withoutThinking;
	return observed === withoutThinking || observed.endsWith(`/${withoutThinking}`);
}

function readTranscript(filePath: string): UserDriverTranscript {
	try {
		return parseUserDriverTranscript(JSON.parse(readFileSync(filePath, 'utf8')));
	} catch (error) {
		throw new Error(
			`Invalid or incompatible user-driver transcript at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function main() {
	if (!existsSync(cliPath)) throw new Error(`Missing ${cliPath}; run npm run build first.`);
	for (const skill of skillPaths) {
		if (!existsSync(skill)) throw new Error(`Missing skill ${skill}`);
	}

	const options = parseArguments();
	const replay = options.replayPath ? readTranscript(options.replayPath) : undefined;
	if (replay && options.scenarioName === 'all') options.scenarioName = replay.scenario.name;
	const scenarios: Scenario[] = registeredScenarios();
	const selected =
		options.scenarioName === 'all'
			? scenarios
			: scenarios.filter((scenario) => scenario.name === options.scenarioName);
	if (!selected.length) {
		throw new Error(
			`Unknown scenario '${options.scenarioName}'. Available: ${scenarios.map(({ name }) => name).join(', ')}`,
		);
	}
	if (replay && (selected.length !== 1 || selected[0].name !== replay.scenario.name)) {
		throw new Error(`Replay transcript scenario '${replay.scenario.name}' does not match the selected scenario.`);
	}

	let failed = false;
	for (const scenario of selected) {
		console.log(`\n=== ${scenario.name} ===\n${scenario.description}`);
		let context: ReturnType<Scenario['setup']> | undefined;
		let scenarioFailed = false;
		try {
			context = scenario.setup();
			const run = await runAgent(context, scenario.intent, {
				model: options.model,
				userModel: options.userModel,
				timeoutMs: options.timeoutMs,
				totalTimeoutMs: options.totalTimeoutMs,
				userTimeoutMs: options.userTimeoutMs,
				maxTurns: options.maxTurns,
				maxUserMessageChars: options.maxUserMessageChars,
				maxUserTokens: options.maxUserTokens,
				maxUserCost: options.maxUserCost,
				apiKey: options.apiKey,
				apiKeyEnv: options.apiKeyEnv,
				authPath: options.authPath,
				userApiKey: options.userApiKey,
				userApiKeyEnv: options.userApiKeyEnv,
				userAuthPath: options.userAuthPath,
				replay,
			});
			writeText(`${context.root}/pi-output.jsonl`, serializeRun(run));
			writeText(`${context.root}/user-driver-transcript.json`, serializeTranscript(run.transcript));
			console.log(
				`Requested worker model: ${run.requestedModel}; observed model: ${run.observedModel ?? 'none'}`,
			);
			console.log(
				`Requested user model: ${run.userDriver.requestedModel}; observed model: ${run.userDriver.observedModel ?? 'none'}${run.userDriver.replayed ? ' (replay)' : ''}`,
			);
			const checks: Check[] = [
				check(
					modelMatches(options.model, run.observedModel),
					'worker used the requested model',
					`observed ${run.observedModel ?? 'none'}`,
				),
				check(!run.modelError, 'completed the worker model request', run.modelError),
				check(
					run.userDriver.replayed || modelMatches(options.userModel, run.userDriver.observedModel),
					run.userDriver.replayed
						? 'replayed the recorded user driver'
						: 'user driver used the requested model',
					`observed ${run.userDriver.observedModel ?? 'none'}`,
				),
				check(!run.userDriver.modelError, 'completed the user-driver model request', run.userDriver.modelError),
				check(
					run.userDriver.end?.status === 'complete',
					'user driver ended as complete',
					run.userDriver.end
						? `${run.userDriver.end.status}: ${run.userDriver.end.reason}`
						: run.transcript.stopReason,
				),
				...scenario.assert(context, run),
			];
			for (const result of checks) {
				console.log(
					`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? ` (${result.detail})` : ''}`,
				);
			}
			if (run.status !== 0) {
				scenarioFailed = true;
				failed = true;
				console.log(`FAIL pi eval exited with status ${run.status}`);
				if (run.modelError) console.log(run.modelError);
				if (run.userDriver.modelError) console.log(run.userDriver.modelError);
			}
			if (checks.some((result) => !result.ok)) {
				scenarioFailed = true;
				failed = true;
			}
			if (options.keep || scenarioFailed) console.log(`Fixture: ${context.root}`);
		} catch (error) {
			scenarioFailed = true;
			failed = true;
			console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
			if (context) console.log(`Fixture: ${context.root}`);
		} finally {
			if (context && !options.keep && !scenarioFailed) context.cleanup();
		}
		if (scenarioFailed && options.failFast) break;
	}
	if (failed) process.exitCode = 1;
}

function check(ok: boolean, name: string, detail?: string): Check {
	return { name, ok, ...(detail ? { detail } : {}) };
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
