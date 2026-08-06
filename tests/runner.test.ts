import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runAgent } from '../evals/runner.ts';
import type {
	EvalContext,
	MutationSnapshot,
	RunnerOptions,
	UserDriverTranscript,
	UserScenario,
} from '../evals/types.ts';

const piMocks = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	DefaultResourceLoader: vi.fn(),
	defineTool: vi.fn(),
	loadSkills: vi.fn(),
	modelRuntimeCreate: vi.fn(),
	resolveCliModel: vi.fn(),
	sessionManagerInMemory: vi.fn(),
	settingsManagerInMemory: vi.fn(),
	snapshotFixture: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
	createAgentSession: piMocks.createAgentSession,
	DefaultResourceLoader: piMocks.DefaultResourceLoader,
	defineTool: piMocks.defineTool,
	loadSkills: piMocks.loadSkills,
	ModelRuntime: { create: piMocks.modelRuntimeCreate },
	resolveCliModel: piMocks.resolveCliModel,
	SessionManager: { inMemory: piMocks.sessionManagerInMemory },
	SettingsManager: { inMemory: piMocks.settingsManagerInMemory },
}));

vi.mock('../evals/fixtures.ts', () => ({ snapshotFixture: piMocks.snapshotFixture }));

type Model = { provider: string; id: string };

type FakeSession = {
	model: Model;
	prompt: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	getSessionStats: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	emit: (event: unknown) => void;
};

const workerModel: Model = { provider: 'provider', id: 'worker' };
const driverModel: Model = { provider: 'provider', id: 'driver' };
const credentialNames = [
	'PATH',
	'UPSTREAM_REMOTE_URL',
	'PATCHLANE_RUNNER_SECRET',
	'PATCHLANE_RUNNER_API_KEY',
	'PATCHLANE_RUNNER_USER_API_KEY',
];
let originalEnvironment: Record<string, string | undefined>;
const runtimeInstances: Array<{
	options: Record<string, unknown>;
	runtime: { setRuntimeApiKey: ReturnType<typeof vi.fn> };
}> = [];

function snapshot(metadata: Record<string, unknown> = {}) {
	return {
		capturedAt: '2026-01-01T00:00:00.000Z',
		...metadata,
		refs: {},
		remoteRefs: {},
		remotes: {},
		gitConfig: {},
		sourceFiles: {},
		files: {},
		worktrees: [],
		worktreeStatus: {},
		workspaceState: {},
	} as MutationSnapshot;
}

function messageEnd(content: string) {
	return { type: 'message_end', message: { role: 'assistant', content } };
}

function makeSession(
	model: Model,
	onPrompt: (session: FakeSession, message: string, options: unknown) => unknown,
	stats: { tokens: number; cost: number } = { tokens: 0, cost: 0 },
): FakeSession {
	let listener: ((event: unknown) => void) | undefined;
	const session: FakeSession = {
		model,
		prompt: vi.fn(async (message: string, options: unknown) => onPrompt(session, message, options)),
		subscribe: vi.fn((callback: (event: unknown) => void) => {
			listener = callback;
			return vi.fn();
		}),
		getSessionStats: vi.fn(() => ({ tokens: { total: stats.tokens }, cost: stats.cost })),
		abort: vi.fn(async () => undefined),
		dispose: vi.fn(),
		emit: (event: unknown) => listener?.(event),
	};
	return session;
}

function installSessions(options: {
	onWorkerPrompt?: (session: FakeSession, message: string, promptOptions: unknown) => unknown;
	onDriverPrompt?: (session: FakeSession, message: string, promptOptions: unknown) => unknown;
	driverStats?: { tokens: number; cost: number };
}) {
	const worker = makeSession(optionsForModel('worker'), options.onWorkerPrompt ?? (() => undefined));
	const driver = makeSession(
		optionsForModel('driver'),
		options.onDriverPrompt ?? (() => undefined),
		options.driverStats,
	);
	const createdOptions: Array<Record<string, any>> = [];
	piMocks.createAgentSession.mockImplementation(async (sessionOptions: Record<string, any>) => {
		createdOptions.push(sessionOptions);
		return { session: sessionOptions.customTools ? driver : worker };
	});
	return { worker, driver, createdOptions };
}

function optionsForModel(name: 'worker' | 'driver') {
	return name === 'worker' ? workerModel : driverModel;
}

function installLiveConversation(
	onWorkerPrompt: (session: FakeSession, message: string, promptOptions: unknown) => unknown = (session) => {
		session.emit(messageEnd('The worker completed the requested change.'));
	},
) {
	let driverTurn = 0;
	let sessions: ReturnType<typeof installSessions>;
	sessions = installSessions({
		onWorkerPrompt,
		onDriverPrompt: async (session) => {
			driverTurn++;
			if (driverTurn === 1) {
				session.emit(messageEnd('Please make the requested change.'));
				return;
			}
			const endTool = sessions.createdOptions[1]?.customTools.find(
				(tool: { name: string }) => tool.name === 'end',
			);
			await endTool.execute('end-call', { status: 'complete', reason: 'The requested change is complete.' });
		},
	});
	return sessions;
}

function context(): EvalContext {
	return {
		root: '/tmp/patchlane-runner-test',
		forkWork: '/tmp/patchlane-runner-test/fork-work',
		forkBare: '/tmp/patchlane-runner-test/fork.git',
		upstreamRemoteUrl: '/tmp/patchlane-runner-test/upstream.git',
		cwd: '/tmp/patchlane-runner-test/fork-work',
		targetLane: 'patch/product',
		targetLaneBefore: 'before',
		cleanup: vi.fn(),
	};
}

function scenario(overrides: Partial<UserScenario> = {}): UserScenario {
	return {
		name: 'runner-test',
		goal: 'Make the requested change.',
		preferences: [],
		authorization: [],
		prohibitions: [],
		...overrides,
	};
}

function runnerOptions(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
	return {
		model: 'provider/worker',
		userModel: 'provider/driver',
		timeoutMs: 1_000,
		userTimeoutMs: 1_000,
		...overrides,
	};
}

function replayTranscript(testScenario: UserScenario): UserDriverTranscript {
	return {
		version: 2,
		systemPromptVersion: 'user-driver-v3',
		scenario: testScenario,
		worker: { requestedModel: 'provider/worker' },
		driver: { requestedModel: 'provider/driver' },
		initialSnapshot: snapshot(),
		turns: [
			{
				index: 0,
				decision: { type: 'reply', content: 'Please continue.' },
				approvalIds: [],
				before: snapshot(),
				driverEvents: [],
			},
			{
				index: 1,
				decision: { type: 'end', status: 'complete', reason: 'The work is complete.' },
				approvalIds: [],
				before: snapshot(),
				driverEvents: [],
			},
		],
	};
}

beforeEach(() => {
	originalEnvironment = Object.fromEntries(credentialNames.map((name) => [name, process.env[name]]));
	vi.resetAllMocks();
	runtimeInstances.length = 0;
	piMocks.snapshotFixture.mockImplementation((_context: EvalContext, metadata?: Record<string, unknown>) =>
		snapshot(metadata),
	);
	piMocks.DefaultResourceLoader.mockImplementation(function (this: { reload: ReturnType<typeof vi.fn> }) {
		this.reload = vi.fn(async () => undefined);
	});
	piMocks.defineTool.mockImplementation((definition: unknown) => definition);
	piMocks.loadSkills.mockReturnValue({ skills: [], diagnostics: [] });
	piMocks.modelRuntimeCreate.mockImplementation(async (options: Record<string, unknown>) => {
		const runtime = { setRuntimeApiKey: vi.fn(async () => undefined) };
		runtimeInstances.push({ options, runtime });
		return runtime;
	});
	piMocks.resolveCliModel.mockImplementation(({ cliModel }: { cliModel: string }) => ({
		model: cliModel === 'provider/driver' ? driverModel : workerModel,
		thinkingLevel: 'minimal',
		warning: undefined,
		error: undefined,
	}));
	piMocks.sessionManagerInMemory.mockImplementation((cwd: string) => ({ cwd }));
	piMocks.settingsManagerInMemory.mockImplementation(() => ({}));
});

afterEach(() => {
	vi.useRealTimers();
	for (const [name, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe('runAgent orchestration', () => {
	test('returns a worker error when the requested model cannot be resolved', async () => {
		piMocks.resolveCliModel.mockReturnValue({
			model: undefined,
			thinkingLevel: undefined,
			warning: undefined,
			error: 'unknown worker model',
		});
		const beforePath = process.env.PATH;
		const beforeUpstream = process.env.UPSTREAM_REMOTE_URL;

		const result = await runAgent(context(), scenario(), runnerOptions());

		expect(result.status).toBe(1);
		expect(result.modelError).toBe('unknown worker model');
		expect(result.transcript.stopReason).toBe('worker_error');
		expect(result.userDriver.stopReason).toBe('worker_error');
		expect(piMocks.createAgentSession).not.toHaveBeenCalled();
		expect(runtimeInstances[0]?.options).toMatchObject({
			authPath: path.join('/tmp/patchlane-runner-test', 'isolated-worker-auth.json'),
			modelsPath: null,
			allowModelNetwork: false,
		});
		expect(process.env.PATH).toBe(beforePath);
		expect(process.env.UPSTREAM_REMOTE_URL).toBe(beforeUpstream);
	});

	test('isolates ambient credentials during live turns and restores them afterward', async () => {
		process.env.PATCHLANE_RUNNER_SECRET = 'ambient-secret';
		process.env.PATCHLANE_RUNNER_API_KEY = 'worker-env-key';
		process.env.PATCHLANE_RUNNER_USER_API_KEY = 'driver-env-key';
		const beforePath = process.env.PATH;
		const beforeUpstream = process.env.UPSTREAM_REMOTE_URL;
		let workerEnvironment: Record<string, string | undefined> | undefined;
		const sessions = installLiveConversation((session) => {
			workerEnvironment = {
				secret: process.env.PATCHLANE_RUNNER_SECRET,
				workerKey: process.env.PATCHLANE_RUNNER_API_KEY,
				userKey: process.env.PATCHLANE_RUNNER_USER_API_KEY,
			};
			session.emit(messageEnd('The worker completed the requested change.'));
		});
		const result = await runAgent(
			context(),
			scenario(),
			runnerOptions({
				apiKeyEnv: 'PATCHLANE_RUNNER_API_KEY',
				userApiKeyEnv: 'PATCHLANE_RUNNER_USER_API_KEY',
			}),
		);
		expect(result.transcript.stopReason).toBe('driver_end');
		expect(sessions.createdOptions).toHaveLength(2);
		expect(runtimeInstances.map(({ options }) => options.authPath)).toEqual([
			path.join('/tmp/patchlane-runner-test', 'isolated-worker-auth.json'),
			path.join('/tmp/patchlane-runner-test', 'isolated-user-driver-auth.json'),
		]);
		expect(runtimeInstances[0]?.runtime.setRuntimeApiKey).toHaveBeenCalledWith('provider', 'worker-env-key');
		expect(runtimeInstances[1]?.runtime.setRuntimeApiKey).toHaveBeenCalledWith('provider', 'driver-env-key');
		expect(workerEnvironment).toEqual({ secret: undefined, workerKey: undefined, userKey: undefined });
		expect(process.env.PATH).toBe(beforePath);
		expect(process.env.UPSTREAM_REMOTE_URL).toBe(beforeUpstream);
		expect(process.env.PATCHLANE_RUNNER_SECRET).toBe('ambient-secret');
		expect(process.env.PATCHLANE_RUNNER_API_KEY).toBe('worker-env-key');
		expect(process.env.PATCHLANE_RUNNER_USER_API_KEY).toBe('driver-env-key');
	});

	test('honors explicit worker and driver credential paths', async () => {
		const sessions = installLiveConversation();

		await runAgent(
			context(),
			scenario(),
			runnerOptions({
				authPath: '/custom/worker-auth.json',
				userAuthPath: '/custom/driver-auth.json',
				apiKey: 'direct-worker-key',
				userApiKey: 'direct-driver-key',
			}),
		);

		expect(sessions.createdOptions).toHaveLength(2);
		expect(runtimeInstances.map(({ options }) => options.authPath)).toEqual([
			'/custom/worker-auth.json',
			'/custom/driver-auth.json',
		]);
		expect(runtimeInstances[0]?.runtime.setRuntimeApiKey).toHaveBeenCalledWith('provider', 'direct-worker-key');
		expect(runtimeInstances[1]?.runtime.setRuntimeApiKey).toHaveBeenCalledWith('provider', 'direct-driver-key');
	});

	test('runs a live worker conversation until the driver ends it', async () => {
		const sessions = installLiveConversation();

		const result = await runAgent(context(), scenario(), runnerOptions({ maxTurns: 3 }));

		expect(result.status).toBe(0);
		expect(result.userDriver.replayed).toBe(false);
		expect(result.userDriver.end).toEqual({
			type: 'end',
			status: 'complete',
			reason: 'The requested change is complete.',
		});
		expect(result.userDriver.stopReason).toBe('driver_end');
		expect(result.transcript.stopReason).toBe('driver_end');
		expect(result.transcript.turns).toHaveLength(2);
		expect(result.transcript.turns[0]).toMatchObject({
			decision: { type: 'reply', content: 'Please make the requested change.' },
			userMessage: 'Please make the requested change.',
			workerResponse: 'The worker completed the requested change.',
		});
		expect(result.transcript.turns[1]?.decision).toEqual(result.userDriver.end);
		expect(sessions.driver.prompt).toHaveBeenCalledTimes(2);
		expect(sessions.worker.prompt).toHaveBeenCalledWith('Please make the requested change.', { source: 'rpc' });
		expect(sessions.worker.dispose).toHaveBeenCalledOnce();
		expect(sessions.driver.dispose).toHaveBeenCalledOnce();
	});

	test('replays driver decisions without creating a live driver session', async () => {
		const testScenario = scenario();
		const sessions = installSessions({
			onWorkerPrompt: (session) => session.emit(messageEnd('The worker made progress.')),
		});

		const result = await runAgent(
			context(),
			testScenario,
			runnerOptions({ replay: replayTranscript(testScenario) }),
		);

		expect(result.status).toBe(0);
		expect(result.userDriver.replayed).toBe(true);
		expect(result.userDriver.stopReason).toBe('driver_end');
		expect(result.transcript.systemPromptVersion).toBe('user-driver-v3');
		expect(result.transcript.turns.map(({ decision }) => decision.type)).toEqual(['reply', 'end']);
		expect(result.userDriver.turnEvents).toEqual([[], []]);
		expect(piMocks.createAgentSession).toHaveBeenCalledOnce();
		expect(sessions.worker.prompt).toHaveBeenCalledWith('Please continue.', { source: 'rpc' });
		expect(sessions.driver.prompt).not.toHaveBeenCalled();
	});

	test('records worker_timeout and aborts a worker that exceeds its turn timeout', async () => {
		vi.useFakeTimers();
		let workerStarted!: () => void;
		const workerPromptStarted = new Promise<void>((resolve) => {
			workerStarted = resolve;
		});
		const sessions = installSessions({
			onDriverPrompt: (session) => session.emit(messageEnd('Please make the requested change.')),
			onWorkerPrompt: () => {
				workerStarted();
				return new Promise<void>(() => undefined);
			},
		});

		const running = runAgent(
			context(),
			scenario(),
			runnerOptions({ timeoutMs: 50, userTimeoutMs: 50, totalTimeoutMs: 500, maxTurns: 1 }),
		);
		await workerPromptStarted;
		await vi.advanceTimersByTimeAsync(60);
		const result = await running;

		expect(result.status).toBe(124);
		expect(result.modelError).toBe('agent timed out after 50ms');
		expect(result.transcript.stopReason).toBe('worker_timeout');
		expect(result.userDriver.stopReason).toBe('worker_timeout');
		expect(sessions.worker.abort).toHaveBeenCalled();
	});

	test('stops with budget_exceeded before sending the worker turn', async () => {
		const sessions = installSessions({
			driverStats: { tokens: 101, cost: 0.2 },
			onDriverPrompt: (session) => session.emit(messageEnd('Please make the requested change.')),
		});

		const result = await runAgent(context(), scenario(), runnerOptions({ maxTurns: 1, maxUserTokens: 100 }));

		expect(result.status).toBe(1);
		expect(result.transcript.stopReason).toBe('budget_exceeded');
		expect(result.userDriver.stopReason).toBe('budget_exceeded');
		expect(result.userDriver.modelError).toBe('user-driver token or cost budget exceeded');
		expect(result.userDriver.tokens).toBe(101);
		expect(result.userDriver.cost).toBe(0.2);
		expect(result.transcript.turns[0]?.after).toBeDefined();
		expect(sessions.worker.prompt).not.toHaveBeenCalled();
	});
});
