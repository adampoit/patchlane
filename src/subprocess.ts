import { runProcess } from './git.js';

export type CommandResult = {
	status: number;
	stdout: string;
	stderr: string;
};

export function run(command: string, args: string[], cwd: string): CommandResult {
	const result = runProcess(command, args, cwd);
	return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function git(args: string[], cwd: string) {
	const result = run('git', args, cwd);
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
	return result.stdout;
}
