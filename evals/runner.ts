import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	loadSkills,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { snapshotFixture } from './fixtures.ts';
import { skillPaths } from './config.ts';
import { hashScenarioIntent, validateScenarioIntent } from './intent.ts';
import { followUpUserDriverPrompt, initialUserDriverPrompt, loadUserDriverBundle } from './user-driver.ts';
import type {
	EvalContext,
	MutationSnapshot,
	PiRun,
	RunnerOptions,
	SerializedEvent,
	UserDriverDecision,
	UserDriverTranscript,
	UserAuthorization,
	UserDriverTranscriptTurn,
	UserScenario,
} from './types.ts';

export const USER_DRIVER_SYSTEM_PROMPT_VERSION = 'user-driver-v5';
export const LEGACY_USER_DRIVER_SYSTEM_PROMPT_VERSIONS = [
	'user-driver-v1',
	'user-driver-v2',
	'user-driver-v3',
	'user-driver-v4',
] as const;
const SUPPORTED_USER_DRIVER_SYSTEM_PROMPT_VERSIONS: readonly string[] = [
	USER_DRIVER_SYSTEM_PROMPT_VERSION,
	...LEGACY_USER_DRIVER_SYSTEM_PROMPT_VERSIONS,
];

function expandHome(filePath: string) {
	return filePath === '~'
		? homedir()
		: filePath.startsWith('~/')
			? path.join(homedir(), filePath.slice(2))
			: filePath;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function eventError(events: AgentSessionEvent[]) {
	for (const event of events) {
		if (event.type !== 'message_end' || !event.message || typeof event.message !== 'object') continue;
		const message = event.message as unknown as Record<string, unknown>;
		if (message.stopReason === 'error' || typeof message.errorMessage === 'string') {
			return typeof message.errorMessage === 'string' ? message.errorMessage : 'model request failed';
		}
	}
	return undefined;
}

function restoreEnvironment(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

export function sensitiveEnvironmentNames(
	environment: NodeJS.ProcessEnv,
	explicitNames: Array<string | undefined> = [],
) {
	const sensitiveName =
		/(?:^|_)(?:api_?key|token|secret|password|passwd|private_?key|access_?key(?:_id)?|session_?token|credentials?|auth(?:_token|_key)?)(?:$|_)/i;
	return [
		...new Set([
			...explicitNames.filter((name): name is string => Boolean(name)),
			...Object.keys(environment).filter(
				(name) =>
					sensitiveName.test(name) || name === 'SSH_AUTH_SOCK' || name === 'GOOGLE_APPLICATION_CREDENTIALS',
			),
		]),
	].sort();
}

function modelProvider(modelReference: string) {
	const slash = modelReference.indexOf('/');
	return slash === -1 ? undefined : modelReference.slice(0, slash);
}

function serializeEvent(event: AgentSessionEvent): string {
	try {
		return JSON.stringify(event);
	} catch {
		return JSON.stringify({ type: 'serialization_error', message: String(event) });
	}
}

function serializeEventObject(event: AgentSessionEvent): SerializedEvent {
	try {
		return JSON.parse(JSON.stringify(event)) as SerializedEvent;
	} catch {
		return { type: 'serialization_error', message: String(event) };
	}
}

export function serializeRun(run: PiRun) {
	return run.events.map(serializeEvent).join('\n') + (run.events.length ? '\n' : '');
}

export function serializeTranscript(transcript: UserDriverTranscript) {
	return `${JSON.stringify(transcript, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseUserDriverTranscript(value: unknown): UserDriverTranscript {
	if (!isRecord(value) || value.version !== 2) throw new Error('unsupported transcript version');
	if (
		typeof value.systemPromptVersion !== 'string' ||
		!SUPPORTED_USER_DRIVER_SYSTEM_PROMPT_VERSIONS.includes(value.systemPromptVersion)
	) {
		throw new Error('unsupported user-driver system prompt version');
	}
	if (!isRecord(value.scenario) || typeof value.scenario.name !== 'string') {
		throw new Error('transcript requires a scenario');
	}
	const scenario = value.scenario as Partial<UserScenario>;
	if (
		typeof scenario.goal !== 'string' ||
		!Array.isArray(scenario.preferences) ||
		!scenario.preferences.every((preference) => typeof preference === 'string') ||
		!Array.isArray(scenario.authorization) ||
		!Array.isArray(scenario.prohibitions) ||
		!scenario.prohibitions.every((prohibition) => typeof prohibition === 'string') ||
		(scenario.maxTurns !== undefined && (!Number.isInteger(scenario.maxTurns) || scenario.maxTurns <= 0))
	) {
		throw new Error('transcript scenario is malformed');
	}
	validateScenarioAuthorizations(scenario.authorization as UserAuthorization[]);
	if (value.contractHashes !== undefined) {
		if (
			!isRecord(value.contractHashes) ||
			typeof value.contractHashes.intent !== 'string' ||
			!/^[a-f0-9]{64}$/.test(value.contractHashes.intent) ||
			typeof value.contractHashes.driverBundle !== 'string' ||
			!/^[a-f0-9]{64}$/.test(value.contractHashes.driverBundle)
		) {
			throw new Error('transcript contract hashes are malformed');
		}
	}
	if (!Array.isArray(value.turns)) throw new Error('transcript requires turns');
	for (const [index, candidate] of value.turns.entries()) {
		if (
			!isRecord(candidate) ||
			candidate.index !== index ||
			!Array.isArray(candidate.approvalIds) ||
			!isRecord(candidate.before) ||
			!Array.isArray(candidate.driverEvents)
		) {
			throw new Error(`transcript turn ${index} is malformed`);
		}
		if (
			!candidate.approvalIds.every(
				(id) =>
					typeof id === 'string' &&
					(scenario.authorization as UserAuthorization[]).some((authorization) => authorization.id === id),
			) ||
			candidate.approvalIds.length > 1
		) {
			throw new Error(`transcript turn ${index} has invalid authorization IDs`);
		}
		if (!isRecord(candidate.decision)) throw new Error(`transcript turn ${index} requires a decision`);
		if (candidate.approvalIds.length && candidate.decision.type !== 'reply') {
			throw new Error(`transcript turn ${index} approval requires a reply`);
		}
		if (
			(candidate.decision.type === 'reply' && typeof candidate.decision.content === 'string') ||
			(candidate.decision.type === 'end' &&
				(candidate.decision.status === 'complete' ||
					candidate.decision.status === 'blocked' ||
					candidate.decision.status === 'unsafe') &&
				typeof candidate.decision.reason === 'string')
		) {
			continue;
		}
		throw new Error(`transcript turn ${index} has an invalid decision`);
	}
	if (!isRecord(value.worker) || !isRecord(value.driver) || !isRecord(value.initialSnapshot)) {
		throw new Error('transcript metadata is malformed');
	}
	return value as UserDriverTranscript;
}

function contentText(message: unknown) {
	if (!message || typeof message !== 'object') return '';
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== 'assistant') return '';
	if (typeof candidate.content === 'string') return candidate.content;
	if (!Array.isArray(candidate.content)) return '';
	return candidate.content
		.filter(
			(value): value is { type: 'text'; text: string } =>
				Boolean(value) &&
				typeof value === 'object' &&
				(value as { type?: unknown }).type === 'text' &&
				typeof (value as { text?: unknown }).text === 'string',
		)
		.map((value) => value.text)
		.join('');
}

function sanitizeWorkerResponse(text: string, context: EvalContext) {
	let sanitized = text;
	const rawPaths = [context.root, context.cwd, context.forkWork, context.forkBare];
	const pathVariants = new Set<string>(rawPaths);
	for (const rawPath of rawPaths) {
		try {
			pathVariants.add(realpathSync(rawPath));
		} catch {
			// The fixture may have been removed while a timed-out worker was settling.
		}
	}
	for (const rawPath of [...pathVariants].sort((left, right) => right.length - left.length)) {
		sanitized = sanitized.split(rawPath).join('<repository>');
	}
	// Fixture names are intentionally disposable, but never make their absolute
	// paths part of the user model's context if a tool summary leaks one.
	sanitized = sanitized.replace(/(?:\/private)?\/tmp\/patchlane-[^\s'"`<>]+/g, '<repository>');
	return sanitized.slice(0, 6000).trim() || '(The worker gave no user-visible response.)';
}

function workerVisibleResponse(events: AgentSessionEvent[], context: EvalContext) {
	const text = events
		.filter((event): event is Extract<AgentSessionEvent, { type: 'message_end' }> => event.type === 'message_end')
		.map((event) => contentText(event.message))
		.filter(Boolean)
		.join('\n');
	return sanitizeWorkerResponse(text, context);
}

export function validateUserMessage(content: string, maxChars: number) {
	const message = content.trim();
	if (!message) return 'the user driver returned an empty message';
	if (message.length > maxChars) return `the user driver message exceeds ${maxChars} characters`;
	if (message.includes('\n') || message.includes('\r')) return 'the user driver message contains multiple lines';
	if (
		/(?:^|\s)(?:git|npx|npm)\s+[^\s]+|(?:^|\s)(?:run|execute|invoke|call|use)\s+(?:the\s+)?(?:npx\s+)?patchlane\s+(?:doctor|sync|init|workspace|promote|bootstrap)\b|--[a-z][\w-]*/i.test(
			message,
		)
	) {
		return 'the user driver message contains an implementation command or flag';
	}
	return undefined;
}

export function validateScenarioAuthorizations(authorizations: UserAuthorization[]) {
	const seen = new Set<string>();
	for (const authorization of authorizations) {
		if (
			!authorization ||
			typeof authorization.id !== 'string' ||
			!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(authorization.id)
		) {
			throw new Error(`invalid scenario authorization ID '${authorization?.id}'`);
		}
		if (seen.has(authorization.id)) {
			throw new Error(`duplicate scenario authorization ID '${authorization.id}'`);
		}
		if (typeof authorization.description !== 'string' || !authorization.description.trim()) {
			throw new Error(`scenario authorization '${authorization.id}' requires a description`);
		}
		seen.add(authorization.id);
	}
}

function approveToolParameters(authorizations: UserAuthorization[]) {
	return {
		type: 'object',
		properties: {
			authorizationId: {
				type: 'string',
				enum: authorizations.map(({ id }) => id),
				description: 'The exact scenario authorization ID corresponding to the approved worker plan.',
			},
		},
		required: ['authorizationId'],
		additionalProperties: false,
	} as const;
}

export function parseAuthorizationId(value: unknown, authorizations: UserAuthorization[]) {
	if (!value || typeof value !== 'object') throw new Error('approve requires an object');
	const authorizationId = (value as { authorizationId?: unknown }).authorizationId;
	if (typeof authorizationId !== 'string' || !authorizationId.trim()) {
		throw new Error('approve requires an authorization ID');
	}
	if (!authorizations.some(({ id }) => id === authorizationId)) {
		throw new Error(`approval is not authorized for '${authorizationId}'`);
	}
	return authorizationId;
}

function createApproveTool(
	authorizations: UserAuthorization[],
	onApproval: (authorizationId: string) => void,
	canApprove: () => boolean,
): ToolDefinition {
	return defineTool({
		name: 'approve',
		label: 'Approve action',
		description:
			'Record explicit approval for one authorized worker plan. Call this only after the worker has presented a clear plan, then send the corresponding natural-language approval message.',
		promptSnippet: 'Record one explicit scenario authorization by its exact ID',
		parameters: approveToolParameters(authorizations),
		execute: async (_toolCallId, params: unknown) => {
			const authorizationId = parseAuthorizationId(params, authorizations);
			if (!canApprove()) {
				return {
					content: [{ type: 'text', text: 'Approval is unavailable until the worker has presented a plan.' }],
					details: { accepted: false, authorizationId },
				};
			}
			onApproval(authorizationId);
			return {
				content: [{ type: 'text', text: `Recorded authorization: ${authorizationId}` }],
				details: { accepted: true, authorizationId },
			};
		},
	});
}

function parseEndDecision(value: unknown): Extract<UserDriverDecision, { type: 'end' }> {
	if (!value || typeof value !== 'object') throw new Error('end requires an object');
	const params = value as { status?: unknown; reason?: unknown };
	if (params.status !== 'complete' && params.status !== 'blocked' && params.status !== 'unsafe') {
		throw new Error('end status must be complete, blocked, or unsafe');
	}
	if (typeof params.reason !== 'string' || !params.reason.trim()) {
		throw new Error('end reason must be a non-empty string');
	}
	return { type: 'end', status: params.status, reason: params.reason.trim() };
}

const END_TOOL_PARAMETERS = {
	type: 'object',
	properties: {
		status: {
			type: 'string',
			enum: ['complete', 'blocked', 'unsafe'],
			description: 'Why the conversation is stopping',
		},
		reason: {
			type: 'string',
			minLength: 1,
			description: 'A short user-facing reason for stopping',
		},
	},
	required: ['status', 'reason'],
	additionalProperties: false,
} as const;

function createEndTool(onEnd: (decision: Extract<UserDriverDecision, { type: 'end' }>) => void): ToolDefinition {
	return defineTool({
		name: 'end',
		label: 'End scenario',
		description:
			'End the user conversation when the task is complete, blocked, or unsafe; this does not determine whether the evaluation passes.',
		promptSnippet: 'Stop the user simulation with a status and reason',
		parameters: END_TOOL_PARAMETERS,
		execute: async (_toolCallId, params: unknown) => {
			const decision = parseEndDecision(params);
			onEnd(decision);
			return {
				content: [{ type: 'text', text: `Scenario ended as ${decision.status}: ${decision.reason}` }],
				details: decision,
				terminate: true,
			};
		},
	});
}

async function resolveModel(
	modelReference: string,
	options: { authPath: string; apiKey?: string; apiKeyEnv?: string },
) {
	const modelRuntime = await ModelRuntime.create({
		authPath: options.authPath,
		modelsPath: null,
		allowModelNetwork: false,
	});
	const apiKey = options.apiKey ?? (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
	const provider = modelProvider(modelReference);
	if (apiKey && provider) await modelRuntime.setRuntimeApiKey(provider, apiKey);

	const resolved = resolveCliModel({
		cliModel: modelReference,
		modelRuntime,
	});
	if (resolved.error || !resolved.model) {
		throw new Error(resolved.error ?? `Could not resolve model '${modelReference}'.`);
	}
	return { modelRuntime, model: resolved.model, thinkingLevel: resolved.thinkingLevel ?? 'minimal' };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void) {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			onTimeout();
			reject(new Error(`agent timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function statsFor(session: AgentSession | undefined) {
	if (!session) return undefined;
	const stats = session.getSessionStats();
	return { tokens: stats.tokens.total, cost: stats.cost };
}

class RunnerFailure extends Error {
	readonly kind: 'worker' | 'driver' | 'budget' | 'invalid' | 'runner';

	constructor(message: string, kind: 'worker' | 'driver' | 'budget' | 'invalid' | 'runner') {
		super(message);
		this.kind = kind;
	}
}

export async function runAgent(context: EvalContext, scenario: UserScenario, options: RunnerOptions): Promise<PiRun> {
	const validatedScenario = validateScenarioIntent(scenario);
	validateScenarioAuthorizations(validatedScenario.authorization);
	const driverBundle = loadUserDriverBundle();
	const workerEvents: AgentSessionEvent[] = [];
	const workerTurnEvents: AgentSessionEvent[][] = [];
	const driverEvents: AgentSessionEvent[] = [];
	const mutationSnapshots: MutationSnapshot[] = [];
	const requestedUserModel = options.userModel ?? options.model;
	const replay = options.replay ? parseUserDriverTranscript(options.replay) : undefined;
	if (replay && hashScenarioIntent(replay.scenario) !== hashScenarioIntent(validatedScenario)) {
		throw new Error(`replay scenario contract does not match '${validatedScenario.name}'`);
	}
	const initialSnapshot = snapshotFixture(context, { phase: 'initial', turn: 0 });
	mutationSnapshots.push(initialSnapshot);
	const contractHashes = replay
		? replay.contractHashes
		: { intent: hashScenarioIntent(validatedScenario), driverBundle: driverBundle.hash };
	const transcript: UserDriverTranscript = {
		version: 2,
		scenario: validatedScenario,
		systemPromptVersion: replay?.systemPromptVersion ?? USER_DRIVER_SYSTEM_PROMPT_VERSION,
		...(contractHashes ? { contractHashes } : {}),
		worker: { requestedModel: options.model },
		driver: { requestedModel: requestedUserModel },
		initialSnapshot,
		turns: [],
	};

	const userDriver: PiRun['userDriver'] = {
		requestedModel: requestedUserModel,
		events: driverEvents,
		turnEvents: [],
		decisions: [],
		replayed: Boolean(replay),
	};

	const bin = path.join(context.root, 'bin');
	const previousPath = process.env.PATH;
	const previousUpstreamRemoteUrl = process.env.UPSTREAM_REMOTE_URL;
	const credentialEnvironmentNames = sensitiveEnvironmentNames(process.env, [
		options.apiKeyEnv,
		options.userApiKeyEnv,
	]);
	const credentialEnvironment = new Map(credentialEnvironmentNames.map((name) => [name, process.env[name]]));
	process.env.PATH = `${bin}:${previousPath ?? ''}`;
	process.env.UPSTREAM_REMOTE_URL = context.upstreamRemoteUrl;

	let workerSession: AgentSession | undefined;
	let driverSession: AgentSession | undefined;
	let workerUnsubscribe: (() => void) | undefined;
	let driverUnsubscribe: (() => void) | undefined;
	let activeWorkerTurn = -1;
	let status = 0;
	let workerError: string | undefined;
	let driverError: string | undefined;
	let stopReason: UserDriverTranscript['stopReason'];
	let timedOut = false;
	let timedOutRole: 'worker' | 'driver' | undefined;
	let currentRole: 'worker' | 'driver' | 'runner' = 'runner';
	let observedModel: string | undefined;
	let observedUserModel: string | undefined;
	let pendingEnd: Extract<UserDriverDecision, { type: 'end' }> | undefined;
	let pendingApprovalIds: string[] = [];
	let currentDriverTurn = -1;
	let deadline = Date.now() + (options.totalTimeoutMs ?? options.timeoutMs);

	try {
		currentRole = 'worker';
		const workerResolved = await resolveModel(options.model, {
			authPath: options.authPath
				? expandHome(options.authPath)
				: path.join(context.root, 'isolated-worker-auth.json'),
			apiKey: options.apiKey,
			apiKeyEnv: options.apiKeyEnv,
		});
		observedModel = `${workerResolved.model.provider}/${workerResolved.model.id}`;
		transcript.worker.observedModel = observedModel;

		const selectedSkills = loadSkills({
			cwd: context.cwd,
			agentDir: path.join(context.root, 'pi-config'),
			skillPaths,
			includeDefaults: false,
		});
		const workerResourceLoader = new DefaultResourceLoader({
			cwd: context.cwd,
			agentDir: path.join(context.root, 'pi-config'),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			skillsOverride: () => selectedSkills,
		});
		await workerResourceLoader.reload();

		const createdWorker = await createAgentSession({
			cwd: context.cwd,
			model: workerResolved.model,
			thinkingLevel: workerResolved.thinkingLevel,
			modelRuntime: workerResolved.modelRuntime,
			resourceLoader: workerResourceLoader,
			tools: ['read', 'bash', 'edit', 'write'],
			sessionManager: SessionManager.inMemory(context.cwd),
			settingsManager: SettingsManager.inMemory(),
		});
		workerSession = createdWorker.session;
		observedModel = workerSession.model
			? `${workerSession.model.provider}/${workerSession.model.id}`
			: observedModel;
		transcript.worker.observedModel = observedModel;
		workerUnsubscribe = workerSession.subscribe((event) => {
			workerEvents.push(event);
			if (activeWorkerTurn >= 0) {
				(workerTurnEvents[activeWorkerTurn] ??= []).push(event);
			}
		});

		if (!replay) {
			currentRole = 'driver';
			const driverResolved = await resolveModel(requestedUserModel, {
				authPath: options.userAuthPath
					? expandHome(options.userAuthPath)
					: path.join(context.root, 'isolated-user-driver-auth.json'),
				apiKey: options.userApiKey ?? options.apiKey,
				apiKeyEnv: options.userApiKeyEnv ?? options.apiKeyEnv,
			});
			observedUserModel = `${driverResolved.model.provider}/${driverResolved.model.id}`;
			transcript.driver.observedModel = observedUserModel;
			userDriver.observedModel = observedUserModel;

			const driverResourceLoader = new DefaultResourceLoader({
				cwd: context.root,
				agentDir: path.join(context.root, 'pi-user-driver-config'),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPromptOverride: () => driverBundle.system,
				appendSystemPromptOverride: () => [],
			});
			await driverResourceLoader.reload();
			const endTool = createEndTool((decision) => {
				pendingEnd = decision;
			});
			const approveTool = validatedScenario.authorization.length
				? createApproveTool(
						validatedScenario.authorization,
						(authorizationId) => pendingApprovalIds.push(authorizationId),
						() => currentDriverTurn > 0 && Boolean(transcript.turns.at(-1)?.workerResponse),
					)
				: undefined;
			const createdDriver = await createAgentSession({
				cwd: context.root,
				model: driverResolved.model,
				thinkingLevel: driverResolved.thinkingLevel,
				modelRuntime: driverResolved.modelRuntime,
				resourceLoader: driverResourceLoader,
				tools: approveTool ? ['end', 'approve'] : ['end'],
				customTools: approveTool ? [endTool, approveTool] : [endTool],
				sessionManager: SessionManager.inMemory(context.root),
				settingsManager: SettingsManager.inMemory(),
			});
			driverSession = createdDriver.session;
			observedUserModel = driverSession.model
				? `${driverSession.model.provider}/${driverSession.model.id}`
				: observedUserModel;
			transcript.driver.observedModel = observedUserModel;
			userDriver.observedModel = observedUserModel;
			driverUnsubscribe = driverSession.subscribe((event) => driverEvents.push(event));
		}

		for (const name of credentialEnvironmentNames) delete process.env[name];

		const maxTurns = options.maxTurns ?? (replay ? replay.turns.length : validatedScenario.maxTurns);
		if (!Number.isInteger(maxTurns) || maxTurns <= 0)
			throw new RunnerFailure('maximum turns must be positive', 'runner');
		const maxMessageChars = options.maxUserMessageChars ?? 400;
		let workerResponse: string | undefined;

		for (let turn = 0; turn < maxTurns; turn++) {
			currentRole = 'driver';
			const before = snapshotFixture(context, { phase: 'before-turn', turn });
			mutationSnapshots.push(before);
			currentDriverTurn = turn;
			pendingApprovalIds = [];
			let decision: UserDriverDecision;
			let invalidMessage: string | undefined;
			let driverTurnEvents: SerializedEvent[] = [];
			let actualDriverTurnEvents: AgentSessionEvent[] = [];
			let budgetExceeded = false;

			if (replay) {
				const replayTurn = replay.turns[turn];
				if (!replayTurn) throw new RunnerFailure(`replay transcript has no turn ${turn}`, 'invalid');
				decision = replayTurn.decision;
			} else {
				if (!driverSession) throw new RunnerFailure('user-driver session was not created', 'driver');
				const eventStart = driverEvents.length;
				const prompt =
					turn === 0
						? initialUserDriverPrompt(validatedScenario)
						: followUpUserDriverPrompt(workerResponse ?? '');
				let driverAttempts = 0;
				while (true) {
					pendingEnd = undefined;
					pendingApprovalIds = [];
					const attemptEventStart = driverEvents.length;
					const remaining = deadline - Date.now();
					if (remaining <= 0)
						throw new RunnerFailure('scenario timed out before the user-driver turn', 'driver');
					currentRole = 'driver';
					try {
						await withTimeout(
							driverSession.prompt(prompt, { source: 'rpc' }),
							Math.min(options.userTimeoutMs ?? options.timeoutMs, remaining),
							() => {
								timedOut = true;
								timedOutRole = 'driver';
								void driverSession?.abort();
							},
						);
					} catch (caught) {
						driverError = errorMessage(caught);
						throw new RunnerFailure(driverError, 'driver');
					}
					const attemptEvents = driverEvents.slice(attemptEventStart);
					const modelError = eventError(attemptEvents);
					if (modelError) {
						driverError = modelError;
						throw new RunnerFailure(modelError, 'driver');
					}
					if (pendingEnd) {
						decision = pendingEnd;
					} else {
						const reply = attemptEvents
							.filter(
								(event): event is Extract<AgentSessionEvent, { type: 'message_end' }> =>
									event.type === 'message_end',
							)
							.map((event) => contentText(event.message))
							.filter(Boolean)
							.at(-1);
						if (!reply)
							throw new RunnerFailure('the user driver returned neither a reply nor end', 'driver');
						decision = { type: 'reply', content: reply.trim() };
					}

					const stats = statsFor(driverSession);
					budgetExceeded = Boolean(
						stats &&
						((options.maxUserTokens !== undefined && stats.tokens > options.maxUserTokens) ||
							(options.maxUserCost !== undefined && stats.cost > options.maxUserCost)),
					);
					invalidMessage =
						decision.type === 'reply' ? validateUserMessage(decision.content, maxMessageChars) : undefined;
					if (!invalidMessage || budgetExceeded || driverAttempts >= 2) break;
					driverAttempts += 1;
				}
				const turnEvents = driverEvents.slice(eventStart);
				actualDriverTurnEvents = turnEvents;
				driverTurnEvents = turnEvents.map(serializeEventObject);
			}

			const replayTurn = replay?.turns[turn];
			const approvalIds = replay ? [...(replayTurn?.approvalIds ?? [])] : [...pendingApprovalIds];
			if (approvalIds.length > 1 || new Set(approvalIds).size !== approvalIds.length) {
				throw new RunnerFailure('the user driver may record only one authorization per turn', 'invalid');
			}
			if (
				approvalIds.some(
					(id) => !validatedScenario.authorization.some((authorization) => authorization.id === id),
				)
			) {
				throw new RunnerFailure('the user driver recorded an unknown scenario authorization', 'invalid');
			}
			if (approvalIds.length && decision.type !== 'reply') {
				throw new RunnerFailure('an approval must be accompanied by a user reply to the worker', 'invalid');
			}
			const transcriptTurn: UserDriverTranscriptTurn = {
				index: turn,
				decision,
				approvalIds,
				before,
				driverEvents: driverTurnEvents,
			};
			transcript.turns.push(transcriptTurn);
			userDriver.decisions.push({ turn, decision });
			userDriver.turnEvents.push(replay ? [] : actualDriverTurnEvents);

			if (budgetExceeded) {
				const after = snapshotFixture(context, { phase: 'after-turn', turn });
				transcriptTurn.after = after;
				mutationSnapshots.push(after);
				stopReason = 'budget_exceeded';
				driverError = 'user-driver token or cost budget exceeded';
				throw new RunnerFailure(driverError, 'budget');
			}

			if (decision.type === 'end') {
				const after = snapshotFixture(context, { phase: 'after-turn', turn });
				transcriptTurn.after = after;
				mutationSnapshots.push(after);
				userDriver.end = decision;
				userDriver.stopReason = 'driver_end';
				transcript.end = { turn, ...decision };
				stopReason = 'driver_end';
				break;
			}

			invalidMessage = validateUserMessage(decision.content, maxMessageChars);
			if (invalidMessage) {
				const after = snapshotFixture(context, { phase: 'after-turn', turn });
				transcriptTurn.after = after;
				mutationSnapshots.push(after);
				stopReason = 'invalid_driver_message';
				driverError = invalidMessage;
				throw new RunnerFailure(invalidMessage, 'invalid');
			}
			transcriptTurn.userMessage = decision.content;
			const workerTurn = workerTurnEvents.length;
			transcriptTurn.workerTurn = workerTurn;
			workerTurnEvents.push([]);
			activeWorkerTurn = workerTurn;
			const workerEventStart = workerEvents.length;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new RunnerFailure('scenario timed out before the worker turn', 'worker');
			currentRole = 'worker';
			let workerFailure: RunnerFailure | undefined;
			try {
				await withTimeout(
					workerSession!.prompt(decision.content, { source: 'rpc' }),
					Math.min(options.timeoutMs, remaining),
					() => {
						timedOut = true;
						timedOutRole = 'worker';
						void workerSession?.abort();
					},
				);
				const modelError = eventError(workerTurnEvents[workerTurn]);
				if (modelError) workerFailure = new RunnerFailure(modelError, 'worker');
			} catch (caught) {
				if (timedOut && timedOutRole === 'worker') {
					try {
						await workerSession?.abort();
					} catch {
						// Preserve the timeout as the primary failure.
					}
				}
				workerFailure =
					caught instanceof RunnerFailure ? caught : new RunnerFailure(errorMessage(caught), 'worker');
			}
			activeWorkerTurn = -1;
			const workerEventsForTurn = workerEvents.slice(workerEventStart);
			transcriptTurn.workerEvents = workerEventsForTurn.map(serializeEventObject);
			workerResponse = workerVisibleResponse(workerTurnEvents[workerTurn], context);
			transcriptTurn.workerResponse = workerResponse;
			const after = snapshotFixture(context, { phase: 'after-turn', turn });
			transcriptTurn.after = after;
			mutationSnapshots.push(after);
			if (workerFailure) {
				workerError = workerFailure.message;
				throw workerFailure;
			}
		}

		if (!stopReason) {
			stopReason = 'max_turns';
			userDriver.stopReason = stopReason;
		}
	} catch (caught) {
		status = timedOut ? 124 : 1;
		if (!stopReason) {
			if (timedOut) stopReason = timedOutRole === 'driver' ? 'driver_timeout' : 'worker_timeout';
			else if (caught instanceof RunnerFailure && caught.kind === 'budget') stopReason = 'budget_exceeded';
			else if (caught instanceof RunnerFailure && caught.kind === 'invalid')
				stopReason = 'invalid_driver_message';
			else if (currentRole === 'driver') stopReason = 'driver_error';
			else if (currentRole === 'worker') stopReason = 'worker_error';
			else stopReason = 'runner_error';
		}
		if (currentRole === 'driver' && !driverError) driverError = errorMessage(caught);
		if (currentRole === 'worker' && !workerError) workerError = errorMessage(caught);
	} finally {
		if (timedOut && workerSession) {
			try {
				await workerSession.abort();
			} catch {
				// Preserve the timeout result.
			}
		}
		if (timedOut && driverSession) {
			try {
				await driverSession.abort();
			} catch {
				// Preserve the timeout result.
			}
		}
		try {
			const finalSnapshot = snapshotFixture(context, { phase: 'final', turn: transcript.turns.length });
			transcript.finalSnapshot = finalSnapshot;
			mutationSnapshots.push(finalSnapshot);
		} catch {
			// Preserve the original worker/model result if a failed fixture cannot be inspected.
		}
		workerUnsubscribe?.();
		driverUnsubscribe?.();
		const driverStats = statsFor(driverSession);
		userDriver.tokens = driverStats?.tokens;
		userDriver.cost = driverStats?.cost;
		if (driverStats) transcript.driver.usage = driverStats;
		workerSession?.dispose();
		driverSession?.dispose();
		restoreEnvironment('PATH', previousPath);
		restoreEnvironment('UPSTREAM_REMOTE_URL', previousUpstreamRemoteUrl);
		for (const [name, value] of credentialEnvironment) restoreEnvironment(name, value);
	}

	if (workerError) status = status === 124 ? status : 1;
	if (driverError) userDriver.modelError = driverError;
	userDriver.stopReason = stopReason;
	transcript.stopReason = stopReason;
	transcript.worker.observedModel = observedModel;
	transcript.driver.observedModel = observedUserModel ?? replay?.driver.observedModel;
	userDriver.observedModel = observedUserModel ?? replay?.driver.observedModel;

	return {
		status,
		events: workerEvents,
		turnEvents: workerTurnEvents,
		requestedModel: options.model,
		observedModel,
		modelError: workerError,
		mutationSnapshots,
		transcript,
		userDriver,
	};
}
