import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrapPatchlane } from '../src/bootstrap.js';
import { loadPatchlaneConfig, type PatchlaneConfig } from '../src/config.js';
import { runDoctor } from '../src/doctor.js';
import { runIntegrationSync } from '../src/integration-sync.js';
import { runPromoteSync } from '../src/promote-sync.js';
import { git, run, type CommandResult } from '../src/subprocess.js';

vi.mock('../src/config.js', () => ({ loadPatchlaneConfig: vi.fn() }));
vi.mock('../src/doctor.js', () => ({ runDoctor: vi.fn() }));
vi.mock('../src/integration-sync.js', () => ({ runIntegrationSync: vi.fn() }));
vi.mock('../src/promote-sync.js', () => ({ runPromoteSync: vi.fn() }));
vi.mock('../src/subprocess.js', () => ({ git: vi.fn(), run: vi.fn() }));

const cwd = '/tmp/patchlane-bootstrap';
const syncSha = '0123456789abcdef0123456789abcdef01234567';
const syncRef = 'refs/heads/sync/integration';
const repository = 'example/fork';
const config: PatchlaneConfig = {
	upstreamOwner: 'example',
	upstreamRepo: 'upstream',
	source: 'branch:main',
	baseBranch: 'main',
	syncBranch: 'sync/integration',
	patchRefs: ['patch/sync', 'patch/product'],
	ciWorkflow: 'Fork CI',
	allowedWorkflows: ['fork-ci.yml'],
};

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
	return { status: 0, stdout: '', stderr: '', ...overrides };
}

function runs(...workflowRuns: Array<Record<string, unknown>>) {
	return commandResult({ stdout: JSON.stringify({ total_count: workflowRuns.length, workflow_runs: workflowRuns }) });
}

function matchingRun(id = 42) {
	return {
		id,
		name: config.ciWorkflow,
		event: 'push',
		head_branch: config.syncBranch,
		head_sha: syncSha,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(loadPatchlaneConfig).mockReturnValue(config);
	vi.mocked(runDoctor).mockReturnValue({ ok: true, checks: [] });
	vi.mocked(git).mockReturnValue(`${syncSha}\t${syncRef}`);
	vi.mocked(run).mockReturnValue(commandResult());
});

afterEach(() => {
	vi.useRealTimers();
});

describe('bootstrapPatchlane', () => {
	test('validates the rebuild without publishing', async () => {
		await expect(bootstrapPatchlane({ cwd })).resolves.toEqual({ status: 'validated' });

		expect(runDoctor).toHaveBeenCalledWith({ cwd });
		expect(runIntegrationSync).toHaveBeenCalledOnce();
		expect(runIntegrationSync).toHaveBeenCalledWith(
			expect.objectContaining({
				upstreamOwner: 'example',
				upstreamRepo: 'upstream',
				patchRefs: 'patch/sync,patch/product',
				dryRun: true,
			}),
		);
		expect(git).not.toHaveBeenCalled();
		expect(runPromoteSync).not.toHaveBeenCalled();
	});

	test('uses the published remote SHA after validation', async () => {
		await expect(bootstrapPatchlane({ cwd, publish: true })).resolves.toEqual({
			status: 'published',
			syncSha,
		});

		expect(runIntegrationSync).toHaveBeenCalledTimes(2);
		const [validationOptions] = vi.mocked(runIntegrationSync).mock.calls[0];
		const [publishOptions] = vi.mocked(runIntegrationSync).mock.calls[1];
		expect(validationOptions).toEqual(expect.objectContaining({ dryRun: true }));
		expect(publishOptions).not.toHaveProperty('dryRun');
		expect(git).toHaveBeenCalledWith(['ls-remote', '--exit-code', 'origin', syncRef], cwd);
		expect(run).not.toHaveBeenCalled();
	});

	test('queries Actions directly until the exact CI run appears and then promotes', async () => {
		vi.useFakeTimers();
		vi.mocked(run)
			.mockReturnValueOnce(commandResult({ stdout: repository }))
			.mockReturnValueOnce(runs())
			.mockReturnValueOnce(
				runs(
					{
						id: 41,
						name: 'Docs',
						event: 'push',
						head_branch: config.syncBranch,
						head_sha: syncSha,
					},
					matchingRun(),
				),
			)
			.mockReturnValueOnce(commandResult({ stdout: 'CI passed' }));

		const result = bootstrapPatchlane({ cwd, publish: true, wait: true });
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(result).resolves.toEqual({ status: 'promoted', syncSha, runId: '42' });
		expect(run).toHaveBeenCalledTimes(4);
		expect(run).toHaveBeenNthCalledWith(
			1,
			'gh',
			['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
			cwd,
		);
		expect(run).toHaveBeenNthCalledWith(
			2,
			'gh',
			[
				'api',
				expect.stringContaining(
					`repos/${repository}/actions/runs?head_sha=${syncSha}&branch=sync%2Fintegration&event=push`,
				),
			],
			cwd,
		);
		expect(run).toHaveBeenNthCalledWith(4, 'gh', ['run', 'watch', '42', '--exit-status'], cwd);
		expect(runPromoteSync).toHaveBeenCalledWith({
			expectedSyncSha: syncSha,
			allowedWorkflows: config.allowedWorkflows,
			baseBranch: config.baseBranch,
			syncBranch: config.syncBranch,
			originRemoteName: 'origin',
		});
	});

	test('performs a final lookup at the timeout deadline', async () => {
		vi.useFakeTimers();
		vi.mocked(run)
			.mockReturnValueOnce(commandResult({ stdout: repository }))
			.mockReturnValueOnce(runs())
			.mockReturnValueOnce(runs())
			.mockReturnValueOnce(runs(matchingRun()))
			.mockReturnValueOnce(commandResult());

		const result = bootstrapPatchlane({
			cwd,
			publish: true,
			wait: true,
			ciTimeoutSeconds: 10,
			ciPollIntervalSeconds: 5,
		});
		await vi.advanceTimersByTimeAsync(10_000);

		await expect(result).resolves.toEqual({ status: 'promoted', syncSha, runId: '42' });
	});

	test('times out with query details when no CI run starts', async () => {
		vi.useFakeTimers();
		vi.mocked(run)
			.mockReturnValueOnce(commandResult({ stdout: repository }))
			.mockReturnValue(runs());
		const result = bootstrapPatchlane({
			cwd,
			publish: true,
			wait: true,
			ciTimeoutSeconds: 10,
			ciPollIntervalSeconds: 5,
		});
		const rejection = expect(result).rejects.toThrow(
			`Timed out after 10 seconds waiting for '${config.ciWorkflow}' to start.\n` +
				`Repository: ${repository}\n` +
				`Branch: ${config.syncBranch}\n` +
				`Commit: ${syncSha}\n` +
				'Event: push',
		);

		await vi.runAllTimersAsync();
		await rejection;
		expect(run).toHaveBeenCalledTimes(4);
		expect(runPromoteSync).not.toHaveBeenCalled();
	});

	test('reports persistent GitHub lookup failures instead of hiding them', async () => {
		vi.useFakeTimers();
		vi.mocked(run)
			.mockReturnValueOnce(commandResult({ stdout: repository }))
			.mockReturnValue(commandResult({ status: 1, stderr: 'HTTP 503' }));
		const result = bootstrapPatchlane({
			cwd,
			publish: true,
			wait: true,
			ciTimeoutSeconds: 5,
			ciPollIntervalSeconds: 5,
		});
		const rejection = expect(result).rejects.toThrow('Last lookup error: HTTP 503');

		await vi.runAllTimersAsync();
		await rejection;
	});

	test('refuses to promote when CI fails', async () => {
		vi.mocked(run)
			.mockReturnValueOnce(commandResult({ stdout: repository }))
			.mockReturnValueOnce(runs(matchingRun()))
			.mockReturnValueOnce(commandResult({ status: 1, stderr: 'CI failed' }));

		await expect(bootstrapPatchlane({ cwd, publish: true, wait: true })).rejects.toThrow(
			'CI run 42 did not succeed; refusing to promote.',
		);
		expect(run).toHaveBeenLastCalledWith('gh', ['run', 'watch', '42', '--exit-status'], cwd);
		expect(runPromoteSync).not.toHaveBeenCalled();
	});
});
