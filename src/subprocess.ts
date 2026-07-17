import { spawnSync } from 'node:child_process';

export type CommandResult = {
	status: number;
	stdout: string;
	stderr: string;
};

export function run(command: string, args: string[], cwd: string): CommandResult {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function git(args: string[], cwd: string) {
	const result = run('git', args, cwd);
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
	return result.stdout;
}
