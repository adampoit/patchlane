import { spawnSync } from 'node:child_process';
import type { NotificationEvent, PatchlaneConfig } from './config.js';
import { resolveForkRepository } from './github-repository.js';

type GithubIssue = {
	number: number;
	state: 'open' | 'closed';
	title?: string;
	body?: string;
	html_url?: string;
	pull_request?: unknown;
};

type NotificationDependencies = {
	github?: (args: string[]) => string;
	now?: () => Date;
};

export type NotificationOptions = {
	config: PatchlaneConfig;
	event: NotificationEvent;
	recovered?: boolean;
	repository?: string;
	status?: string;
	runUrl?: string;
	cwd?: string;
	originRemoteName?: string;
	upstreamSource?: string;
	upstreamSha?: string;
	syncSha?: string;
	baseBranch?: string;
	syncBranch?: string;
	failedPatchRef?: string;
	failedCommit?: string;
	conflictPaths?: string;
	appliedPatchRefs?: string;
};

export type NotificationResult =
	| { status: 'disabled' | 'not-configured' | 'closed-without-notification' }
	| { status: 'created' | 'updated' | 'reopened' | 'closed'; issueNumber: number; url?: string }
	| { status: 'failed'; error: string };

function runGithub(args: string[]) {
	const result = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			[result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n') ||
				`gh exited with status ${result.status ?? 1}`,
		);
	}
	return result.stdout;
}

function eventName(event: NotificationEvent) {
	return {
		'sync-failed': 'Sync failed',
		'ci-failed': 'CI failed',
		'promotion-failed': 'Promotion failed',
	}[event];
}

function marker(repository: string, event: NotificationEvent) {
	return `<!-- patchlane-notification:${repository}:${event} -->`;
}

function code(value: string) {
	return `\`${value.replaceAll('`', "'")}\``;
}

function values(value?: string) {
	return (value ?? '')
		.split(/\r?\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function issueBody(options: NotificationOptions, repository: string, observedAt: string) {
	const lines = [
		marker(repository, options.event),
		'',
		`## ${eventName(options.event)}`,
		'',
		`- Status: ${code(options.status || 'failed')}`,
		`- Repository: ${code(repository)}`,
		`- Latest observed: ${observedAt}`,
	];
	if (options.runUrl) lines.push(`- Workflow run: ${options.runUrl}`);
	if (options.upstreamSource) lines.push(`- Upstream source: ${code(options.upstreamSource)}`);
	if (options.upstreamSha) lines.push(`- Resolved upstream SHA: ${code(options.upstreamSha)}`);
	if (options.syncSha) lines.push(`- Sync SHA: ${code(options.syncSha)}`);
	if (options.baseBranch) lines.push(`- Base branch: ${code(options.baseBranch)}`);
	if (options.syncBranch) lines.push(`- Sync branch: ${code(options.syncBranch)}`);
	if (options.failedPatchRef) lines.push(`- Failing patch ref: ${code(options.failedPatchRef)}`);
	if (options.failedCommit) lines.push(`- Failing commit: ${code(options.failedCommit)}`);

	const conflicts = values(options.conflictPaths);
	if (conflicts.length) {
		lines.push('', '### Conflict paths', '', ...conflicts.map((path) => `- ${code(path)}`));
	}
	const applied = values(options.appliedPatchRefs);
	if (applied.length) {
		lines.push('', '### Applied patch refs', '', ...applied.map((ref) => `- ${code(ref)}`));
	}

	lines.push('', '### Reproduction', '');
	if (options.event === 'sync-failed') lines.push('```bash', 'npx patchlane sync --dry-run', '```');
	else if (options.event === 'promotion-failed') {
		lines.push('```bash', `npx patchlane promote --expected-sync-sha=${options.syncSha || '<tested-sha>'}`, '```');
	} else {
		lines.push('Re-run the failed CI workflow from the workflow run linked above.');
	}
	return `${lines.join('\n')}\n`;
}

function parseIssuePages(output: string) {
	const parsed = JSON.parse(output) as unknown;
	if (!Array.isArray(parsed)) throw new Error('GitHub returned an invalid issue list.');
	const items = parsed.flatMap((page) => (Array.isArray(page) ? page : [page])) as GithubIssue[];
	return items.filter((issue) => !issue.pull_request);
}

function field(name: string, value: string) {
	return ['-f', `${name}=${value}`];
}

function warn(message: string) {
	process.stderr.write(`Patchlane notification warning: ${message}\n`);
}

export function runNotification(
	options: NotificationOptions,
	dependencies: NotificationDependencies = {},
): NotificationResult {
	const provider = options.config.notifications?.githubIssues;
	if (!provider) return { status: 'not-configured' };
	if (!provider.events.includes(options.event)) return { status: 'disabled' };
	if (options.recovered && !provider.closeOnRecovery) return { status: 'closed-without-notification' };

	let repository: string;
	try {
		repository = resolveForkRepository({
			cwd: options.cwd ?? process.cwd(),
			repository: options.repository,
			originRemoteName: options.originRemoteName ?? process.env.ORIGIN_REMOTE_NAME,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(message);
		return { status: 'failed', error: message };
	}

	const github = dependencies.github ?? runGithub;
	const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
	const issueMarker = marker(repository, options.event);

	try {
		const issues = parseIssuePages(
			github(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=all&per_page=100`]),
		).filter((issue) => issue.body?.includes(issueMarker));
		const openIssue = issues.find((issue) => issue.state === 'open');

		if (options.recovered) {
			if (!openIssue) return { status: 'closed-without-notification' };
			github([
				'api',
				'--method',
				'POST',
				`repos/${repository}/issues/${openIssue.number}/comments`,
				...field(
					'body',
					`Recovered at ${observedAt}.${options.runUrl ? `\n\nWorkflow run: ${options.runUrl}` : ''}`,
				),
			]);
			github([
				'api',
				'--method',
				'PATCH',
				`repos/${repository}/issues/${openIssue.number}`,
				...field('state', 'closed'),
			]);
			return { status: 'closed', issueNumber: openIssue.number, url: openIssue.html_url };
		}

		const title = `[Patchlane] ${eventName(options.event)} in ${repository}`;
		const body = issueBody(options, repository, observedAt);
		let issue = openIssue;
		let status: 'created' | 'updated' | 'reopened';

		if (issue) {
			github([
				'api',
				'--method',
				'PATCH',
				`repos/${repository}/issues/${issue.number}`,
				...field('title', title),
				...field('body', body),
			]);
			github([
				'api',
				'--method',
				'POST',
				`repos/${repository}/issues/${issue.number}/comments`,
				...field(
					'body',
					`Failure observed again at ${observedAt}.${options.runUrl ? `\n\nWorkflow run: ${options.runUrl}` : ''}`,
				),
			]);
			status = 'updated';
		} else {
			issue = issues.find((candidate) => candidate.state === 'closed');
			if (issue) {
				github([
					'api',
					'--method',
					'PATCH',
					`repos/${repository}/issues/${issue.number}`,
					...field('state', 'open'),
					...field('title', title),
					...field('body', body),
				]);
				status = 'reopened';
			} else {
				issue = JSON.parse(
					github([
						'api',
						'--method',
						'POST',
						`repos/${repository}/issues`,
						...field('title', title),
						...field('body', body),
					]),
				) as GithubIssue;
				status = 'created';
			}
		}

		if (provider.labels.length) {
			try {
				github([
					'api',
					'--method',
					'POST',
					`repos/${repository}/issues/${issue.number}/labels`,
					...provider.labels.flatMap((label) => field('labels[]', label)),
				]);
			} catch (error) {
				warn(`Could not apply labels: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const assignee of provider.assignees) {
			try {
				github([
					'api',
					'--method',
					'POST',
					`repos/${repository}/issues/${issue.number}/assignees`,
					...field('assignees[]', assignee),
				]);
			} catch (error) {
				warn(`Could not assign '${assignee}': ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		return { status, issueNumber: issue.number, url: issue.html_url };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(message);
		return { status: 'failed', error: message };
	}
}
