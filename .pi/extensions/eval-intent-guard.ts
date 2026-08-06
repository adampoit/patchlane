import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isToolCallEventType, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);
const PROTECTED_DIRECTORIES = ['evals/intents', 'evals/user-driver'] as const;
const READ_ONLY_COMMANDS = new Set([
	'[',
	'cat',
	'cmp',
	'diff',
	'file',
	'find',
	'grep',
	'head',
	'ls',
	'pwd',
	'readlink',
	'realpath',
	'rg',
	'stat',
	'tail',
	'test',
	'wc',
]);
const READ_ONLY_GIT_COMMANDS = new Set([
	'cat-file',
	'diff',
	'grep',
	'log',
	'ls-files',
	'ls-tree',
	'rev-parse',
	'show',
	'show-ref',
	'status',
]);
const BROAD_GIT_MUTATIONS = new Set(['am', 'apply', 'cherry-pick', 'merge', 'pull', 'rebase', 'revert', 'switch']);
const BLOCK_REASON =
	'Eval intent and user-driver policy are protected contracts; change worker skills, assertions, or runner logic instead.';

export type GitFileQuery = (args: string[]) => Promise<{ stdout: string; stderr?: string; code?: number | null }>;

function lexicalPath(filePath: string, cwd: string) {
	const withoutAt = filePath.startsWith('@') ? filePath.slice(1) : filePath;
	return path.resolve(cwd, withoutAt);
}

export function normalizeToolPath(filePath: string, cwd: string) {
	const absolute = lexicalPath(filePath, cwd);
	let existing = absolute;
	const suffix: string[] = [];
	while (true) {
		try {
			return path.join(realpathSync.native(existing), ...suffix.reverse());
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return absolute;
			suffix.push(path.basename(existing));
			existing = parent;
		}
	}
}

function isWithin(candidate: string, directory: string) {
	const relative = path.relative(directory, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isProtectedPath(filePath: string, repositoryRoot: string, cwd = repositoryRoot) {
	const candidate = normalizeToolPath(filePath, cwd);
	return PROTECTED_DIRECTORIES.some((directory) => isWithin(candidate, normalizeToolPath(directory, repositoryRoot)));
}

function splitShellSegments(command: string) {
	return command
		.split(/(?:&&|\|\||[;\n]|(?<!\|)\|(?!\|))/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function shellWords(command: string) {
	return (command.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) ?? []).map((word) =>
		word.replace(/^['"]|['"]$/g, '').replace(/[;,]+$/g, ''),
	);
}

function commandAndArguments(segment: string) {
	const words = shellWords(segment);
	while (words[0]?.includes('=') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
	if (words[0] === 'command' || words[0] === 'builtin') words.shift();
	return { command: path.basename(words[0] ?? ''), args: words.slice(1) };
}

function gitSubcommand(args: string[]) {
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === '-C' || argument === '--git-dir' || argument === '--work-tree') {
			index++;
			continue;
		}
		if (!argument.startsWith('-')) return { name: argument, args: args.slice(index + 1) };
	}
	return { name: '', args: [] };
}

export function isReadOnlyShellCommand(command: string) {
	if (!command.trim() || /(?:^|[^<])>{1,2}|>\|/.test(command) || /`|\$\(/.test(command)) return false;
	return splitShellSegments(command).every((segment) => {
		const parsed = commandAndArguments(segment);
		if (parsed.command === 'git') return READ_ONLY_GIT_COMMANDS.has(gitSubcommand(parsed.args).name);
		if (!READ_ONLY_COMMANDS.has(parsed.command)) return false;
		if (parsed.command === 'find' && parsed.args.some((arg) => /^-(?:delete|exec|execdir|fls|fprint)/.test(arg))) {
			return false;
		}
		return true;
	});
}

function commandMentionsProtectedPath(command: string, repositoryRoot: string, cwd: string) {
	if (/(?:^|[\s'"=])(?:\.\.\/|\.\/|\/)?evals\/(?:intents|user-driver)(?:\/|[\s'";]|$)/.test(command)) {
		return true;
	}
	return shellWords(command).some((word) => {
		const cleaned = word.replace(/^(?:>|>>|<)/, '').replace(/[;,)]+$/g, '');
		return cleaned ? isProtectedPath(cleaned, repositoryRoot, cwd) : false;
	});
}

async function defaultGitQuery(repositoryRoot: string, args: string[]) {
	try {
		const result = await execFileAsync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' });
		return { stdout: result.stdout, stderr: result.stderr, code: 0 };
	} catch (error) {
		const result = error as { stdout?: string; stderr?: string; code?: number };
		return { stdout: result.stdout ?? '', stderr: result.stderr, code: result.code };
	}
}

async function protectedGitFiles(repositoryRoot: string, args: string[], query?: GitFileQuery): Promise<string[]> {
	const result = query ? await query(args) : await defaultGitQuery(repositoryRoot, args);
	if (result.code && result.code !== 0) throw new Error(result.stderr || 'could not inspect protected Git state');
	return result.stdout
		.split('\n')
		.map((file) => file.trim())
		.filter(Boolean);
}

export function stagedProtectedFiles(repositoryRoot: string, query?: GitFileQuery) {
	return protectedGitFiles(
		repositoryRoot,
		['diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB', '--', ...PROTECTED_DIRECTORIES],
		query,
	);
}

export function changedProtectedFiles(repositoryRoot: string, query?: GitFileQuery) {
	return protectedGitFiles(
		repositoryRoot,
		['status', '--porcelain=v1', '--untracked-files=all', '--', ...PROTECTED_DIRECTORIES],
		query,
	);
}

function gitOperations(command: string) {
	return splitShellSegments(command)
		.map(commandAndArguments)
		.filter((parsed) => parsed.command === 'git')
		.map((parsed) => gitSubcommand(parsed.args));
}

function jjCommits(command: string) {
	return splitShellSegments(command).some((segment) => {
		const parsed = commandAndArguments(segment);
		return (
			parsed.command === 'jj' &&
			['commit', 'new', 'squash'].includes(parsed.args.find((arg) => !arg.startsWith('-')) ?? '')
		);
	});
}

function pathScopeMayIncludeProtected(args: string[], repositoryRoot: string, cwd: string) {
	const pathArguments = args.filter((arg) => arg !== '--' && !arg.startsWith('-'));
	return pathArguments.some((argument) => {
		if (argument === '.' || argument === ':/' || argument === ':/evals') return true;
		const scope = normalizeToolPath(argument, cwd);
		return PROTECTED_DIRECTORIES.some((directory) => isWithin(normalizeToolPath(directory, repositoryRoot), scope));
	});
}

function isBroadStage(args: string[], repositoryRoot: string, cwd: string) {
	return (
		args.some((arg) => arg === '-A' || arg === '--all' || arg === '-u' || arg === '--update') ||
		pathScopeMayIncludeProtected(args, repositoryRoot, cwd)
	);
}

export async function shellBlockReason(
	command: string,
	repositoryRoot: string,
	cwd: string,
	query?: GitFileQuery,
): Promise<string | undefined> {
	if (commandMentionsProtectedPath(command, repositoryRoot, cwd) && !isReadOnlyShellCommand(command)) {
		return BLOCK_REASON;
	}

	const operations = gitOperations(command);
	if (
		operations.some(
			({ name, args }) =>
				BROAD_GIT_MUTATIONS.has(name) ||
				(name === 'reset' && (args.includes('--hard') || !args.includes('--'))) ||
				(name === 'checkout' && !args.includes('--')),
		)
	) {
		return BLOCK_REASON;
	}

	if (
		operations.some(
			({ name, args }) =>
				['checkout', 'mv', 'reset', 'restore'].includes(name) &&
				pathScopeMayIncludeProtected(args, repositoryRoot, cwd),
		)
	) {
		return BLOCK_REASON;
	}

	const commits = operations.some(({ name }) => name === 'commit');
	if (commits && (await stagedProtectedFiles(repositoryRoot, query)).length) return BLOCK_REASON;
	if (
		operations.some(
			({ name, args }) => name === 'commit' && pathScopeMayIncludeProtected(args, repositoryRoot, cwd),
		) &&
		(await changedProtectedFiles(repositoryRoot, query)).length
	) {
		return BLOCK_REASON;
	}
	if (
		operations.some(({ name, args }) => name === 'commit' && (args.includes('-a') || args.includes('--all'))) &&
		(await changedProtectedFiles(repositoryRoot, query)).length
	) {
		return BLOCK_REASON;
	}
	if (
		operations.some(({ name, args }) => ['add', 'rm'].includes(name) && isBroadStage(args, repositoryRoot, cwd)) &&
		(await changedProtectedFiles(repositoryRoot, query)).length
	) {
		return BLOCK_REASON;
	}
	if (jjCommits(command) && (await changedProtectedFiles(repositoryRoot, query)).length) return BLOCK_REASON;
	return undefined;
}

export function registerEvalIntentGuard(pi: ExtensionAPI, repositoryRoot: string) {
	const query: GitFileQuery = async (args) => {
		const result = await pi.exec('git', ['-C', repositoryRoot, ...args]);
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};

	pi.on('tool_call', async (event, ctx) => {
		if (isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
			if (isProtectedPath(event.input.path, repositoryRoot, ctx.cwd)) {
				return { block: true, reason: BLOCK_REASON };
			}
			return undefined;
		}
		if (isToolCallEventType('bash', event)) {
			const reason = await shellBlockReason(event.input.command, repositoryRoot, ctx.cwd, query);
			if (reason) return { block: true, reason };
		}
		return undefined;
	});
}

export default function evalIntentGuard(pi: ExtensionAPI) {
	registerEvalIntentGuard(pi, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
}
