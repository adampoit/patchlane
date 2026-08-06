import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export type CommandResult = {
	status: number;
	stdout: string;
	stderr: string;
};

export type UserAuthorization = {
	id: string;
	description: string;
};

export type UserScenario = {
	name: string;
	goal: string;
	preferences: string[];
	authorization: UserAuthorization[];
	prohibitions: string[];
	maxTurns?: number;
};

export type UserDriverDecision =
	{ type: 'reply'; content: string } | { type: 'end'; status: 'complete' | 'blocked' | 'unsafe'; reason: string };

export type SerializedEvent = Record<string, unknown>;

export type WorktreeSnapshot = {
	path: string;
	head?: string;
	branch?: string;
	status: string;
};

/** State captured around a worker turn. Timestamps and metadata are not state predicates. */
export type MutationSnapshot = {
	capturedAt: string;
	phase?: 'initial' | 'before-turn' | 'after-turn' | 'final';
	turn?: number;
	refs: Record<string, string>;
	remoteRefs: Record<string, string>;
	remotes: Record<string, string[]>;
	gitConfig: Record<string, string[]>;
	sourceFiles: Record<string, string>;
	files: Record<string, string>;
	worktrees: WorktreeSnapshot[];
	worktreeStatus: Record<string, string>;
	workspaceState: Record<string, string>;
};

export type UserDriverTranscriptTurn = {
	index: number;
	decision: UserDriverDecision;
	approvalIds: string[];
	before: MutationSnapshot;
	after?: MutationSnapshot;
	userMessage?: string;
	workerTurn?: number;
	workerResponse?: string;
	driverEvents: SerializedEvent[];
	workerEvents?: SerializedEvent[];
};

export type UserDriverTranscript = {
	version: 2;
	scenario: UserScenario;
	systemPromptVersion: string;
	contractHashes?: {
		intent: string;
		driverBundle: string;
	};
	worker: {
		requestedModel: string;
		observedModel?: string;
	};
	driver: {
		requestedModel: string;
		observedModel?: string;
		usage?: { tokens: number; cost: number };
	};
	initialSnapshot: MutationSnapshot;
	turns: UserDriverTranscriptTurn[];
	end?: {
		turn: number;
		status: 'complete' | 'blocked' | 'unsafe';
		reason: string;
	};
	stopReason?:
		| 'driver_end'
		| 'max_turns'
		| 'worker_error'
		| 'worker_timeout'
		| 'driver_error'
		| 'driver_timeout'
		| 'budget_exceeded'
		| 'invalid_driver_message'
		| 'runner_error';
	finalSnapshot?: MutationSnapshot;
};

export type UserDriverRun = {
	requestedModel: string;
	observedModel?: string;
	modelError?: string;
	events: AgentSessionEvent[];
	turnEvents: AgentSessionEvent[][];
	decisions: Array<{ turn: number; decision: UserDriverDecision }>;
	end?: Extract<UserDriverDecision, { type: 'end' }>;
	stopReason?: UserDriverTranscript['stopReason'];
	tokens?: number;
	cost?: number;
	replayed: boolean;
};

export type PiRun = {
	status: number;
	events: AgentSessionEvent[];
	turnEvents: AgentSessionEvent[][];
	requestedModel: string;
	observedModel?: string;
	modelError?: string;
	mutationSnapshots: MutationSnapshot[];
	transcript: UserDriverTranscript;
	userDriver: UserDriverRun;
};

export type Check = {
	name: string;
	ok: boolean;
	detail?: string;
};

export type EvalContext = {
	root: string;
	forkWork: string;
	forkBare: string;
	upstreamRemoteUrl: string;
	cwd: string;
	targetLane: string;
	targetLaneBefore: string;
	targetLaneLocalBefore?: string;
	sourceLaneBefore?: string;
	cleanup: () => void;
};

export type Scenario = {
	name: string;
	description: string;
	intent: UserScenario;
	setup: () => EvalContext;
	assert: (context: EvalContext, run: PiRun) => Check[];
};

export type RunnerOptions = {
	model: string;
	userModel?: string;
	timeoutMs: number;
	userTimeoutMs?: number;
	totalTimeoutMs?: number;
	maxTurns?: number;
	maxUserMessageChars?: number;
	maxUserTokens?: number;
	maxUserCost?: number;
	apiKey?: string;
	apiKeyEnv?: string;
	authPath?: string;
	userApiKey?: string;
	userApiKeyEnv?: string;
	userAuthPath?: string;
	replay?: UserDriverTranscript;
};
