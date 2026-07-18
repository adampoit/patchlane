import { expect, test, vi } from 'vitest';
import type { PatchlaneConfig } from '../src/config.js';
import { runNotification } from '../src/notify.js';

type Issue = {
	number: number;
	state: 'open' | 'closed';
	title: string;
	body: string;
	html_url: string;
	labels: string[];
	assignees: string[];
	comments: string[];
};

function config(assignees = ['maintainer']): PatchlaneConfig {
	return {
		upstreamOwner: 'upstream',
		upstreamRepo: 'project',
		source: 'release:latest',
		baseBranch: 'main',
		syncBranch: 'sync/integration',
		patchRefs: ['patch/product'],
		ciWorkflow: 'CI',
		allowedWorkflows: ['ci.yml'],
		notifications: {
			githubIssues: {
				assignees,
				labels: ['patchlane'],
				events: ['sync-failed', 'ci-failed', 'promotion-failed'],
				closeOnRecovery: true,
			},
		},
	};
}

function githubState(invalidAssignee?: string) {
	const issues: Issue[] = [];
	function fields(args: string[]) {
		const result = new Map<string, string[]>();
		for (let index = 0; index < args.length; index++) {
			if (args[index] !== '-f') continue;
			const value = args[++index] ?? '';
			const separator = value.indexOf('=');
			const key = value.slice(0, separator);
			const values = result.get(key) ?? [];
			values.push(value.slice(separator + 1));
			result.set(key, values);
		}
		return result;
	}
	const github = (args: string[]) => {
		const methodIndex = args.indexOf('--method');
		const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1];
		const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
		const input = fields(args);
		if (method === 'GET') return JSON.stringify([issues]);
		if (method === 'POST' && endpoint.endsWith('/issues')) {
			const issue: Issue = {
				number: issues.length + 1,
				state: 'open',
				title: input.get('title')?.[0] ?? '',
				body: input.get('body')?.[0] ?? '',
				html_url: `https://example.test/issues/${issues.length + 1}`,
				labels: [],
				assignees: [],
				comments: [],
			};
			issues.push(issue);
			return JSON.stringify(issue);
		}
		const number = Number(endpoint.match(/issues\/(\d+)/)?.[1]);
		const issue = issues.find((candidate) => candidate.number === number);
		if (!issue) throw new Error(`Issue ${number} not found`);
		if (method === 'PATCH') {
			const state = input.get('state')?.[0];
			if (state === 'open' || state === 'closed') issue.state = state;
			issue.title = input.get('title')?.[0] ?? issue.title;
			issue.body = input.get('body')?.[0] ?? issue.body;
			return JSON.stringify(issue);
		}
		if (endpoint.endsWith('/comments')) {
			issue.comments.push(input.get('body')?.[0] ?? '');
			return '{}';
		}
		if (endpoint.endsWith('/labels')) {
			issue.labels.push(...(input.get('labels[]') ?? []));
			return '{}';
		}
		if (endpoint.endsWith('/assignees')) {
			const assignee = input.get('assignees[]')?.[0] ?? '';
			if (assignee === invalidAssignee) throw new Error('Validation Failed');
			issue.assignees.push(assignee);
			return '{}';
		}
		throw new Error(`Unsupported request: ${args.join(' ')}`);
	};
	return { github, issues };
}

test('creates, assigns, and updates one issue for repeated failures', () => {
	const state = githubState();
	const dependencies = { github: state.github, now: () => new Date('2026-01-02T03:04:05Z') };
	const options = {
		config: config(),
		event: 'sync-failed' as const,
		repository: 'fork/project',
		status: 'conflicted',
		runUrl: 'https://github.com/fork/project/actions/runs/123',
		failedPatchRef: 'patch/product',
		failedCommit: 'abc123',
		conflictPaths: 'src/example.ts',
	};

	expect(runNotification(options, dependencies)).toMatchObject({ status: 'created', issueNumber: 1 });
	expect(state.issues).toHaveLength(1);
	expect(state.issues[0]).toMatchObject({ labels: ['patchlane'], assignees: ['maintainer'] });
	expect(state.issues[0]?.body).toContain('patchlane-notification:fork/project:sync-failed');
	expect(state.issues[0]?.body).toContain('npx patchlane sync --dry-run');

	expect(runNotification(options, dependencies)).toMatchObject({ status: 'updated', issueNumber: 1 });
	expect(state.issues).toHaveLength(1);
	expect(state.issues[0]?.comments[0]).toContain('Failure observed again');
});

test('closes on recovery and reopens the same issue if failure recurs', () => {
	const state = githubState();
	const dependencies = { github: state.github, now: () => new Date('2026-01-02T03:04:05Z') };
	const options = {
		config: config(),
		event: 'ci-failed' as const,
		repository: 'fork/project',
		status: 'failure',
	};

	runNotification(options, dependencies);
	expect(runNotification({ ...options, recovered: true }, dependencies)).toMatchObject({ status: 'closed' });
	expect(state.issues[0]?.state).toBe('closed');
	expect(runNotification(options, dependencies)).toMatchObject({ status: 'reopened' });
	expect(state.issues).toHaveLength(1);
	expect(state.issues[0]?.state).toBe('open');
});

test('keeps the issue when assignment fails and reports notification API failures', () => {
	const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	try {
		const state = githubState('invalid-user');
		const result = runNotification(
			{
				config: config(['valid-user', 'invalid-user']),
				event: 'promotion-failed',
				repository: 'fork/project',
				syncSha: 'abc123',
			},
			{ github: state.github },
		);
		expect(result).toMatchObject({ status: 'created' });
		expect(state.issues[0]?.assignees).toEqual(['valid-user']);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("Could not assign 'invalid-user'"));

		expect(
			runNotification(
				{ config: config(), event: 'sync-failed', repository: 'fork/project' },
				{
					github: () => {
						throw new Error('API unavailable');
					},
				},
			),
		).toEqual({ status: 'failed', error: 'API unavailable' });
	} finally {
		warning.mockRestore();
	}
});
