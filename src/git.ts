import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import path from 'node:path';

export type ProcessResult = {
	status: number;
	stdout: string;
	stderr: string;
	error?: Error;
};

export type RunGitOptions = {
	allowFailure?: boolean;
	env?: NodeJS.ProcessEnv;
	input?: string;
};

export class GitError extends Error {
	readonly name = 'GitError';

	constructor(
		message: string,
		readonly command: string[],
		readonly result?: ProcessResult,
	) {
		super(message);
	}
}

export function runProcess(
	command: string,
	args: string[],
	cwd: string,
	options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; input?: string } = {},
): ProcessResult {
	const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
		cwd,
		env: options.env ?? process.env,
		encoding: 'utf8',
		input: options.input,
	};
	const result = spawnSync(command, args, spawnOptions);
	if (result.error) {
		if (!options.allowFailure) throw result.error;
		return { status: 1, stdout: '', stderr: result.error.message, error: result.error };
	}
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

export function gitResult(args: string[], cwd: string, options: RunGitOptions = {}) {
	return runProcess('git', args, cwd, options);
}

export function git(args: string[], cwd: string, options: RunGitOptions = {}) {
	const result = gitResult(args, cwd, { ...options, allowFailure: true });
	if (!options.allowFailure && result.status !== 0) {
		const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
		throw new GitError(detail || `git ${args.join(' ')} failed`, args, result);
	}
	return result.stdout.trim();
}

export function gitOutput(args: string[], cwd: string, options: RunGitOptions = {}) {
	return git(args, cwd, options);
}

export function gitTopLevel(cwd: string) {
	return path.resolve(cwd, git(['rev-parse', '--show-toplevel'], cwd));
}

export function gitCommonDir(cwd: string) {
	const commonDir = git(['rev-parse', '--git-common-dir'], cwd);
	return path.resolve(cwd, commonDir);
}

export function currentBranch(cwd: string) {
	const result = gitResult(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

export function headSha(cwd: string) {
	return git(['rev-parse', 'HEAD^{commit}'], cwd);
}

export function refSha(cwd: string, ref: string) {
	const result = gitResult(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

export function objectExists(cwd: string, object: string) {
	return gitResult(['cat-file', '-e', object], cwd).status === 0;
}

export function isValidRefName(cwd: string, ref: string) {
	if (!ref || ref.startsWith('-')) return false;
	return gitResult(['check-ref-format', `refs/heads/${ref}`], cwd).status === 0;
}

export type Worktree = {
	path: string;
	head?: string;
	branch?: string;
	bare?: boolean;
};

export function listWorktrees(cwd: string): Worktree[] {
	const result = gitResult(['worktree', 'list', '--porcelain'], cwd);
	if (result.status !== 0) return [];

	const worktrees: Worktree[] = [];
	let current: Worktree | undefined;
	for (const line of result.stdout.split(/\r?\n/)) {
		if (line.startsWith('worktree ')) {
			if (current) worktrees.push(current);
			current = { path: path.resolve(line.slice('worktree '.length)) };
			continue;
		}
		if (!current) continue;
		if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim();
		else if (line.startsWith('branch ')) {
			const branch = line.slice('branch '.length).trim();
			current.branch = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
		} else if (line === 'bare') current.bare = true;
	}
	if (current) worktrees.push(current);
	return worktrees;
}

export function isWorktreePathRegistered(cwd: string, worktreePath: string) {
	const resolved = path.resolve(worktreePath);
	return listWorktrees(cwd).some((worktree) => worktree.path === resolved);
}

export function ensureGitIdentity(cwd: string) {
	const name = gitResult(['config', 'user.name'], cwd).stdout.trim();
	const email = gitResult(['config', 'user.email'], cwd).stdout.trim();
	if (!name) git(['config', 'user.name', 'patchlane'], cwd);
	if (!email) git(['config', 'user.email', 'patchlane@localhost'], cwd);
}

export function formatGitFailure(result: ProcessResult, command = 'git') {
	return (
		[result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n') ||
		`${command} exited with status ${result.status}`
	);
}
