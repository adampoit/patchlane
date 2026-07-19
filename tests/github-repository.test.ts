import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { githubRepositoryFromRemote, resolveForkRepository } from '../src/github-repository.js';
import { run, type CommandResult } from '../src/subprocess.js';

vi.mock('../src/subprocess.js', () => ({ run: vi.fn() }));

const cwd = '/tmp/patchlane-repository';

function result(overrides: Partial<CommandResult> = {}): CommandResult {
	return { status: 0, stdout: '', stderr: '', ...overrides };
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv('GITHUB_REPOSITORY', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('githubRepositoryFromRemote', () => {
	test.each([
		['https://github.com/fork/project.git', 'fork/project'],
		['git@github.com:fork/project.git', 'fork/project'],
		['ssh://git@github.com/fork/project', 'fork/project'],
		['https://token@github.com/fork/project.git', 'fork/project'],
	])('parses %s', (remote, repository) => {
		expect(githubRepositoryFromRemote(remote)).toBe(repository);
	});

	test('rejects non-GitHub hosts', () => {
		expect(githubRepositoryFromRemote('https://notgithub.com/fork/project.git')).toBeUndefined();
	});
});

describe('resolveForkRepository', () => {
	test("uses the origin push target instead of gh's configured default", () => {
		vi.mocked(run).mockReturnValue(result({ stdout: 'https://github.com/fork/project.git' }));

		expect(resolveForkRepository({ cwd })).toBe('fork/project');
		expect(run).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledWith('git', ['remote', 'get-url', '--push', 'origin'], cwd);
	});

	test('uses a configured remote name', () => {
		vi.mocked(run).mockReturnValue(result({ stdout: 'git@github.com:fork/project.git' }));

		expect(resolveForkRepository({ cwd, originRemoteName: 'publish' })).toBe('fork/project');
		expect(run).toHaveBeenCalledWith('git', ['remote', 'get-url', '--push', 'publish'], cwd);
	});

	test('allows an explicit repository override without inspecting remotes', () => {
		expect(resolveForkRepository({ cwd, repository: 'other/fork' })).toBe('other/fork');
		expect(run).not.toHaveBeenCalled();
	});

	test('falls back to the Actions repository when the push target is unavailable', () => {
		vi.stubEnv('GITHUB_REPOSITORY', 'actions/fork');
		vi.mocked(run).mockReturnValue(result({ status: 2, stderr: 'No such remote' }));

		expect(resolveForkRepository({ cwd })).toBe('actions/fork');
	});

	test('reports how to configure an unresolved repository', () => {
		vi.mocked(run).mockReturnValue(result({ stdout: 'https://example.com/fork/project.git' }));

		expect(() => resolveForkRepository({ cwd })).toThrow(
			"Could not determine the fork GitHub repository from the 'origin' push target",
		);
	});
});
