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
const syncSha = '0123456789abcdef';
const config: PatchlaneConfig = {
	upstreamOwner: 'example',
	upstreamRepo: 'upstream',
	source: 'branch:main',
	baseBranch: 'main',
	syncBranch: 'sync/integration',
	patchRefs: ['patch/sync', 'patch/product'],
	ciWorkflow: 'Fork CI',
};

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
	return { status: 0, stdout: '', stderr: '', ...overrides };
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(loadPatchlaneConfig).mockReturnValue(config);
	vi.mocked(runDoctor).mockReturnValue({ ok: true, checks: [] });
	vi.mocked(git).mockReturnValue(syncSha);
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

	test('publishes the sync branch after validation', async () => {
		await expect(bootstrapPatchlane({ cwd, publish: true })).resolves.toEqual({
			status: 'published',
			syncSha,
		});

		expect(runIntegrationSync).toHaveBeenCalledTimes(2);
		const [validationOptions] = vi.mocked(runIntegrationSync).mock.calls[0];
		const [publishOptions] = vi.mocked(runIntegrationSync).mock.calls[1];
		expect(validationOptions).toEqual(expect.objectContaining({ dryRun: true }));
		expect(publishOptions).not.toHaveProperty('dryRun');
		expect(git).toHaveBeenCalledWith(['rev-parse', config.syncBranch], cwd);
		expect(run).not.toHaveBeenCalled();
	});

	test('polls until the CI run starts and promotes after it succeeds', async () => {
		vi.useFakeTimers();
		vi.mocked(run)
			.mockReturnValueOnce(commandResult())
			.mockReturnValueOnce(commandResult({ stdout: '42' }))
			.mockReturnValueOnce(commandResult({ stdout: 'CI passed' }));

		const result = bootstrapPatchlane({ cwd, publish: true, wait: true });
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(result).resolves.toEqual({ status: 'promoted', syncSha, runId: '42' });
		expect(run).toHaveBeenCalledTimes(3);
		expect(run).toHaveBeenNthCalledWith(
			1,
			'gh',
			expect.arrayContaining(['run', 'list', '--workflow', 'Fork CI', '--commit', syncSha]),
			cwd,
		);
		expect(run).toHaveBeenNthCalledWith(
			2,
			'gh',
			expect.arrayContaining(['run', 'list', '--workflow', 'Fork CI', '--commit', syncSha]),
			cwd,
		);
		expect(run).toHaveBeenNthCalledWith(3, 'gh', ['run', 'watch', '42', '--exit-status'], cwd);
		expect(runPromoteSync).toHaveBeenCalledWith({
			expectedSyncSha: syncSha,
			baseBranch: config.baseBranch,
			syncBranch: config.syncBranch,
		});
	});

	test('times out when no CI run starts', async () => {
		vi.useFakeTimers();
		const result = bootstrapPatchlane({ cwd, publish: true, wait: true });
		const rejection = expect(result).rejects.toThrow(
			`Timed out waiting for '${config.ciWorkflow}' to start for ${syncSha}.`,
		);

		await vi.runAllTimersAsync();
		await rejection;
		expect(run).toHaveBeenCalledTimes(24);
		expect(runPromoteSync).not.toHaveBeenCalled();
	});

	test('refuses to promote when CI fails', async () => {
		vi.mocked(run)
			.mockReturnValueOnce(commandResult({ stdout: '42' }))
			.mockReturnValueOnce(commandResult({ status: 1, stderr: 'CI failed' }));

		await expect(bootstrapPatchlane({ cwd, publish: true, wait: true })).rejects.toThrow(
			'CI run 42 did not succeed; refusing to promote.',
		);
		expect(run).toHaveBeenLastCalledWith('gh', ['run', 'watch', '42', '--exit-status'], cwd);
		expect(runPromoteSync).not.toHaveBeenCalled();
	});
});
