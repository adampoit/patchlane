import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadPatchlaneConfig, type PatchlaneConfig } from '../src/config.js';
import { resolveForkRepository } from '../src/github-repository.js';
import { run, type CommandResult } from '../src/subprocess.js';
import { verifyGitHubAuth } from '../src/verify-auth.js';

vi.mock('../src/config.js', () => ({ loadPatchlaneConfig: vi.fn() }));
vi.mock('../src/github-repository.js', () => ({ resolveForkRepository: vi.fn() }));
vi.mock('../src/subprocess.js', () => ({ run: vi.fn() }));

const cwd = '/tmp/patchlane-auth';
const repository = 'example/fork';
const config: PatchlaneConfig = {
	upstreamOwner: 'example',
	upstreamRepo: 'upstream',
	source: 'release:latest',
	baseBranch: 'main',
	syncBranch: 'sync/integration',
	patchRefs: ['patch/sync'],
	ciWorkflow: 'Fork CI',
	allowedWorkflows: ['ci.yml'],
};

function result(overrides: Partial<CommandResult> = {}): CommandResult {
	return { status: 0, stdout: '', stderr: '', ...overrides };
}

function runs(...workflowRuns: Array<{ databaseId: number; displayTitle: string }>) {
	return result({ stdout: JSON.stringify(workflowRuns) });
}

function verificationRun(databaseId = 11) {
	return { databaseId, displayTitle: 'Verify Patchlane authentication (verify-123)' };
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(loadPatchlaneConfig).mockReturnValue(config);
	vi.mocked(resolveForkRepository).mockReturnValue(repository);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('verifyGitHubAuth', () => {
	test('dispatches and watches a correlated no-push workflow run', async () => {
		vi.mocked(run)
			.mockReturnValueOnce(result())
			.mockReturnValueOnce(runs(verificationRun(), { databaseId: 10, displayTitle: 'Sync Upstream Integration' }))
			.mockReturnValueOnce(result({ stdout: 'Authentication passed' }));

		await expect(verifyGitHubAuth({ cwd, verificationId: 'verify-123' })).resolves.toEqual({
			status: 'verified',
			repository,
			runId: '11',
		});
		expect(resolveForkRepository).toHaveBeenCalledWith({
			cwd,
			repository: undefined,
			originRemoteName: undefined,
		});
		expect(run).toHaveBeenNthCalledWith(
			1,
			'gh',
			[
				'workflow',
				'run',
				'sync-upstream.yml',
				'--repo',
				repository,
				'--ref',
				'main',
				'--field',
				'no_push=true',
				'--field',
				'verification_id=verify-123',
			],
			cwd,
		);
		expect(run).toHaveBeenLastCalledWith('gh', ['run', 'watch', '11', '--repo', repository, '--exit-status'], cwd);
	});

	test('waits for GitHub to expose the correlated run', async () => {
		vi.useFakeTimers();
		vi.mocked(run)
			.mockReturnValueOnce(result())
			.mockReturnValueOnce(runs({ databaseId: 10, displayTitle: 'Sync Upstream Integration' }))
			.mockReturnValueOnce(runs(verificationRun()))
			.mockReturnValueOnce(result());

		const verification = verifyGitHubAuth({
			cwd,
			pollIntervalSeconds: 2,
			verificationId: 'verify-123',
		});
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(verification).resolves.toEqual(expect.objectContaining({ runId: '11' }));
	});

	test('reports a failed authentication workflow', async () => {
		vi.mocked(run)
			.mockReturnValueOnce(result())
			.mockReturnValueOnce(runs(verificationRun()))
			.mockReturnValueOnce(result({ status: 1, stderr: 'token creation failed' }));

		await expect(verifyGitHubAuth({ cwd, verificationId: 'verify-123' })).rejects.toThrow(
			'Patchlane authentication check run 11 failed.',
		);
	});
});
