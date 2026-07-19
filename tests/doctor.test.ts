import { describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
	inspectAuthenticatedCommandJob,
	inspectAuthenticatedJob,
	inspectGitHubAutomation,
	runDoctor,
	type DoctorCheck,
} from '../src/doctor.js';
import type { PatchlaneConfig } from '../src/config.js';
import { renderPromotionWorkflow, renderSyncWorkflow } from '../src/workflow-templates.js';

function workflowConfig(ciWorkflow: string): PatchlaneConfig {
	return {
		upstreamOwner: 'example',
		upstreamRepo: 'upstream',
		source: 'branch:main',
		baseBranch: 'main',
		syncBranch: 'sync/integration',
		patchRefs: ['patch/sync'],
		ciWorkflow,
		allowedWorkflows: ['ci.yml'],
	};
}

function git(args: string[], cwd: string) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function configureUser(repo: string) {
	git(['config', 'user.name', 'Patchlane Test'], repo);
	git(['config', 'user.email', 'patchlane@example.test'], repo);
}

const appToken = '${{ steps.patchlane-token.outputs.token }}';

function validTokenWith() {
	return {
		'client-id': '${{ vars.PATCHLANE_APP_CLIENT_ID }}',
		'private-key': '${{ secrets.PATCHLANE_APP_PRIVATE_KEY }}',
		'permission-contents': 'write',
		'permission-workflows': 'write',
		'permission-issues': 'write',
	};
}

function authenticatedJob(
	options: {
		includeTokenStep?: boolean;
		tokenStepId?: string;
		tokenUses?: string;
		tokenWith?: Record<string, unknown>;
		tokenOutputName?: string;
		checkoutToken?: string;
		ghToken?: string;
	} = {},
) {
	const tokenStepId = options.tokenStepId ?? 'patchlane-token';
	const token = `\${{ steps.${tokenStepId}.outputs.${options.tokenOutputName ?? 'token'} }}`;
	return {
		steps: [
			...(options.includeTokenStep === false
				? []
				: [
						{
							id: tokenStepId,
							uses: options.tokenUses ?? 'actions/create-github-app-token@v3',
							with: options.tokenWith ?? validTokenWith(),
						},
					]),
			{
				uses: 'actions/checkout@v4',
				with: { token: options.checkoutToken ?? token },
			},
			{
				run: 'npx patchlane@1.2.3 sync',
				env: { GH_TOKEN: options.ghToken ?? token },
			},
		],
	};
}

function inspectJob(job: Record<string, unknown> | undefined) {
	const checks: DoctorCheck[] = [];
	inspectAuthenticatedJob(
		'.github/workflows/sync-upstream.yml',
		'fork-sync',
		job,
		{ contents: 'write', workflows: true, issues: true },
		checks,
	);
	return checks;
}

type AutomationResponse = { status: number; stdout: string; stderr: string };

function automationRunner(overrides: Partial<Record<'actions' | 'variables' | 'secrets', AutomationResponse>> = {}) {
	const responses = {
		actions: { status: 0, stdout: 'true', stderr: '' },
		variables: { status: 0, stdout: 'PATCHLANE_APP_CLIENT_ID', stderr: '' },
		secrets: { status: 0, stdout: 'PATCHLANE_APP_PRIVATE_KEY', stderr: '' },
		...overrides,
	};
	return (_command: string, args: string[]) => {
		const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
		if (endpoint.endsWith('/actions/permissions')) return responses.actions;
		if (endpoint.includes('/actions/variables')) return responses.variables;
		if (endpoint.includes('/actions/secrets')) return responses.secrets;
		throw new Error(`Unexpected command: ${args.join(' ')}`);
	};
}

describe('inspectAuthenticatedJob', () => {
	test('reports a missing job', () => {
		expect(inspectJob(undefined)).toEqual([
			{
				severity: 'error',
				message: ".github/workflows/sync-upstream.yml must define the 'fork-sync' job.",
			},
		]);
	});

	test('reports a missing token producer step', () => {
		expect(inspectJob(authenticatedJob({ includeTokenStep: false }))).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining("missing token producer step 'patchlane-token'"),
			}),
		);
	});

	test('retains strict validation for a direct token provider', () => {
		expect(inspectJob(authenticatedJob())).toEqual([]);
	});

	test('accepts a custom action when checkout and Patchlane use its token output', () => {
		const checks = inspectJob(
			authenticatedJob({
				tokenStepId: 'custom-auth',
				tokenUses: 'example/custom-auth@v1',
				tokenWith: {},
				tokenOutputName: 'access_token',
			}),
		);
		expect(checks).toEqual([
			{
				severity: 'info',
				message: expect.stringContaining(
					"uses custom token producer action 'example/custom-auth@v1'; its token capabilities cannot be verified statically",
				),
			},
		]);
	});

	test('reports a token output expression without a producer', () => {
		expect(
			inspectJob(
				authenticatedJob({
					includeTokenStep: false,
					checkoutToken: '${{ steps.missing.outputs.token }}',
					ghToken: '${{ steps.missing.outputs.token }}',
				}),
			),
		).toContainEqual(expect.objectContaining({ message: expect.stringContaining("producer step 'missing'") }));
	});

	test('accepts a run step as an opaque token producer', () => {
		const job = authenticatedJob({ tokenOutputName: 'access_token' }) as { steps: Record<string, unknown>[] };
		job.steps[0] = {
			id: 'patchlane-token',
			run: 'echo "access_token=$MINTED_TOKEN" >> "$GITHUB_OUTPUT"',
		};
		expect(inspectJob(job)).toEqual([
			{
				severity: 'info',
				message: expect.stringContaining(
					"uses custom token producer run step 'patchlane-token'; its token capabilities cannot be verified statically",
				),
			},
		]);
	});

	test('reports a token producer without an action or command', () => {
		const job = authenticatedJob() as { steps: Record<string, unknown>[] };
		job.steps[0] = { id: 'patchlane-token', name: 'Missing implementation' };
		expect(inspectJob(job)).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining('must use an action or run a command') }),
		);
	});

	test('accepts a repository secret as the authentication token', () => {
		expect(
			inspectJob(
				authenticatedJob({
					includeTokenStep: false,
					checkoutToken: '${{ secrets.PATCHLANE_TOKEN }}',
					ghToken: '${{ secrets.PATCHLANE_TOKEN }}',
				}),
			),
		).toEqual([
			{
				severity: 'info',
				message: expect.stringContaining("uses Actions secret 'PATCHLANE_TOKEN' as its authentication token"),
			},
		]);
	});

	test.each([
		'${{ github.token }}',
		'${{ secrets.GITHUB_TOKEN }}',
		'${{ secrets.github_token }}',
		'${{ env.PATCHLANE_TOKEN }}',
		'${{ steps.patchlane-token.outputs.token || secrets.PATCHLANE_TOKEN }}',
	])('reports invalid checkout token expression %s', (checkoutToken) => {
		expect(inspectJob(authenticatedJob({ checkoutToken }))).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining('steps.<id>.outputs.<name>') }),
		);
	});

	test('requires the standard token output from the direct App provider', () => {
		expect(inspectJob(authenticatedJob({ tokenOutputName: 'access_token' }))).toEqual([
			expect.objectContaining({ message: expect.stringContaining('must create a Patchlane GitHub App token') }),
		]);
	});

	test.each([
		['client ID', { 'client-id': '${{ vars.WRONG_CLIENT_ID }}' }],
		['private key', { 'private-key': '${{ secrets.WRONG_PRIVATE_KEY }}' }],
		['contents permission', { 'permission-contents': 'read' }],
		['workflows permission', { 'permission-workflows': 'read' }],
		['issues permission', { 'permission-issues': 'read' }],
	])('reports an incorrect App token %s', (_name, override) => {
		const checks = inspectJob(authenticatedJob({ tokenWith: { ...validTokenWith(), ...override } }));
		expect(checks).toEqual([
			expect.objectContaining({ message: expect.stringContaining('must create a Patchlane GitHub App token') }),
		]);
	});

	test('reports a custom token mismatch between checkout and Patchlane', () => {
		expect(
			inspectJob(
				authenticatedJob({
					tokenStepId: 'not-adam',
					tokenUses: 'adampoit/not-adam@v1',
					ghToken: appToken,
				}),
			),
		).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining('must pass the checkout authentication token'),
			}),
		);
	});

	test('reports a Patchlane command without GH_TOKEN', () => {
		expect(inspectJob(authenticatedJob({ ghToken: '${{ github.token }}' }))).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining('must pass the checkout authentication token'),
			}),
		);
	});

	test('checks every Patchlane command in the job', () => {
		const job = authenticatedJob() as { steps: Record<string, unknown>[] };
		job.steps.push({
			run: 'npx patchlane notify --event=sync-failed',
			env: { GH_TOKEN: '${{ steps.other.outputs.token }}' },
		});
		expect(inspectJob(job)).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining('must pass the checkout authentication token'),
			}),
		);
	});
});

describe('inspectAuthenticatedCommandJob', () => {
	function inspectJobs(jobs: Record<string, unknown>) {
		const checks: DoctorCheck[] = [];
		inspectAuthenticatedCommandJob(
			'.github/workflows/sync-upstream.yml',
			{ jobs },
			'sync',
			{ contents: 'write', workflows: true, issues: true },
			checks,
		);
		return checks;
	}

	test('accepts a direct GitHub App action in a custom sync job', () => {
		expect(inspectJobs({ sync: authenticatedJob() })).toEqual([]);
	});

	test('accepts a custom authentication action in a custom sync job', () => {
		expect(
			inspectJobs({
				update: authenticatedJob({
					tokenStepId: 'not-adam',
					tokenUses: 'adampoit/not-adam@v1',
					tokenWith: {},
				}),
			}),
		).toEqual([
			{
				severity: 'info',
				message: expect.stringContaining(
					"job 'update' uses custom token producer action 'adampoit/not-adam@v1'",
				),
			},
		]);
	});

	test('reports a missing sync command job', () => {
		expect(inspectJobs({ build: { steps: [{ run: 'npm test' }] } })).toEqual([
			{
				severity: 'error',
				message: ".github/workflows/sync-upstream.yml must define a job that invokes 'patchlane sync'.",
			},
		]);
	});

	test('reports ambiguous sync command jobs', () => {
		expect(inspectJobs({ first: authenticatedJob(), second: authenticatedJob() })).toEqual([
			{
				severity: 'error',
				message:
					".github/workflows/sync-upstream.yml must define exactly one job that invokes 'patchlane sync'; found 'first', 'second'.",
			},
		]);
	});
});

describe('inspectGitHubAutomation', () => {
	function inspect(overrides: Parameters<typeof automationRunner>[0] = {}) {
		const checks: DoctorCheck[] = [];
		inspectGitHubAutomation('example/fork', '/tmp/fork', checks, automationRunner(overrides));
		return checks;
	}

	test('reports disabled Actions', () => {
		expect(inspect({ actions: { status: 0, stdout: 'false', stderr: '' } })).toContainEqual({
			severity: 'error',
			message: "GitHub Actions is disabled for 'example/fork'.",
		});
	});

	test('reports a missing App client ID variable', () => {
		expect(inspect({ variables: { status: 0, stdout: 'OTHER_VARIABLE', stderr: '' } })).toContainEqual({
			severity: 'error',
			message: "Repository variable 'PATCHLANE_APP_CLIENT_ID' is not configured for 'example/fork'.",
		});
	});

	test('reports a missing App private key secret', () => {
		expect(inspect({ secrets: { status: 0, stdout: 'OTHER_SECRET', stderr: '' } })).toContainEqual({
			severity: 'error',
			message: "Repository secret 'PATCHLANE_APP_PRIVATE_KEY' is not configured for 'example/fork'.",
		});
	});

	test('warns when GitHub metadata APIs are inaccessible', () => {
		const failed = { status: 1, stdout: '', stderr: 'HTTP 403' };
		expect(inspect({ actions: failed, variables: failed, secrets: failed })).toEqual([
			{
				severity: 'warning',
				message: "GitHub Actions enablement could not be inspected for 'example/fork'.",
			},
			{
				severity: 'warning',
				message: "Repository variables could not be inspected for 'example/fork'.",
			},
			{
				severity: 'warning',
				message: "Repository secrets could not be inspected for 'example/fork'.",
			},
		]);
	});

	test('skips standard credential metadata checks for custom token providers', () => {
		const checks: DoctorCheck[] = [];
		const endpoints: string[] = [];
		const runner = (_command: string, args: string[]) => {
			endpoints.push(args.find((arg) => arg.startsWith('repos/')) ?? '');
			return { status: 0, stdout: 'true', stderr: '' };
		};
		inspectGitHubAutomation('example/fork', '/tmp/fork', checks, runner, false);
		expect(checks).toEqual([]);
		expect(endpoints).toEqual(['repos/example/fork/actions/permissions']);
	});
});

test('composes non-overlapping changes to the same workflow from independent patches', () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-doctor-composed-'));
	try {
		const upstreamBare = path.join(tempRoot, 'upstream.git');
		const upstreamWork = path.join(tempRoot, 'upstream-work');
		const forkBare = path.join(tempRoot, 'fork.git');
		const forkWork = path.join(tempRoot, 'fork-work');
		git(['init', '--bare', '--initial-branch=main', upstreamBare], tempRoot);
		git(['clone', upstreamBare, upstreamWork], tempRoot);
		configureUser(upstreamWork);
		const upstreamWorkflowDir = path.join(upstreamWork, '.github', 'workflows');
		mkdirSync(upstreamWorkflowDir, { recursive: true });
		writeFileSync(path.join(upstreamWork, 'README.md'), '# Upstream\n');
		writeFileSync(
			path.join(upstreamWorkflowDir, 'ci.yml'),
			'name: Existing CI\nrun-name: Continuous integration\npermissions:\n  contents: read\nconcurrency:\n  group: continuous-integration\n  cancel-in-progress: true\non:\n  push:\n    branches: [feature]\n',
		);
		git(['add', '.'], upstreamWork);
		git(['commit', '-m', 'Initial upstream'], upstreamWork);
		git(['push', 'origin', 'main'], upstreamWork);

		git(['init', '--bare', '--initial-branch=main', forkBare], tempRoot);
		git(['clone', upstreamBare, forkWork], tempRoot);
		configureUser(forkWork);
		git(['remote', 'rename', 'origin', 'upstream'], forkWork);
		git(['remote', 'add', 'origin', forkBare], forkWork);
		git(['push', 'origin', 'main'], forkWork);

		git(['switch', '-c', 'patch/sync', 'upstream/main'], forkWork);
		const workflowDir = path.join(forkWork, '.github', 'workflows');
		writeFileSync(
			path.join(workflowDir, 'sync-upstream.yml'),
			renderSyncWorkflow(workflowConfig('Product CI'), '1.2.3'),
		);
		writeFileSync(
			path.join(workflowDir, 'promote-tested-sync.yml'),
			renderPromotionWorkflow(workflowConfig('Product CI'), '1.2.3'),
		);
		git(['add', '.github/workflows'], forkWork);
		git(['commit', '-m', 'Add sync workflows'], forkWork);
		git(['push', 'origin', 'patch/sync'], forkWork);

		git(['switch', '-c', 'patch/ci', 'upstream/main'], forkWork);
		writeFileSync(
			path.join(workflowDir, 'ci.yml'),
			'name: Existing CI\nrun-name: Continuous integration\npermissions:\n  contents: read\nconcurrency:\n  group: continuous-integration\n  cancel-in-progress: true\non:\n  push:\n    branches: [main, sync/integration]\n',
		);
		git(['add', '.github/workflows/ci.yml'], forkWork);
		git(['commit', '-m', 'Run CI on integration branches'], forkWork);
		git(['push', 'origin', 'patch/ci'], forkWork);

		git(['switch', '-c', 'patch/product', 'upstream/main'], forkWork);
		writeFileSync(path.join(forkWork, 'PRODUCT.md'), 'Product patch\n');
		git(['add', 'PRODUCT.md'], forkWork);
		git(['commit', '-m', 'Add product patch'], forkWork);
		git(['push', 'origin', 'patch/product'], forkWork);

		git(['switch', '-c', 'patch/product-workflow', 'upstream/main'], forkWork);
		writeFileSync(
			path.join(workflowDir, 'ci.yml'),
			'name: Product CI\nrun-name: Continuous integration\npermissions:\n  contents: read\nconcurrency:\n  group: continuous-integration\n  cancel-in-progress: true\non:\n  push:\n    branches: [feature]\n',
		);
		git(['add', '.github/workflows/ci.yml'], forkWork);
		git(['commit', '-m', 'Rename product CI workflow'], forkWork);
		git(['push', 'origin', 'patch/product-workflow'], forkWork);

		git(['switch', 'patch/sync'], forkWork);
		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			[
				'version: 1',
				'upstream: example/upstream',
				'source: branch:main',
				'patchRefs: [patch/sync, patch/ci, patch/product, patch/product-workflow]',
				'ciWorkflow: Product CI',
				'allowedWorkflows: [ci.yml]',
				'',
			].join('\n'),
		);

		const report = runDoctor({ cwd: forkWork, json: true });
		expect(report.ok).toBe(true);
		expect(report.checks).not.toContainEqual(
			expect.objectContaining({ message: expect.stringContaining('must run on pushes') }),
		);

		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			[
				'version: 1',
				'upstream: example/upstream',
				'source: branch:main',
				'patchRefs: [patch/sync, patch/ci, patch/product, patch/product-workflow]',
				'ciWorkflow: Product CI',
				'allowedWorkflows: [missing.yml]',
				'',
			].join('\n'),
		);
		const deniedReport = runDoctor({ cwd: forkWork, json: true });
		expect(deniedReport.ok).toBe(false);
		expect(deniedReport.checks).toContainEqual(
			expect.objectContaining({ severity: 'error', message: expect.stringContaining('ci.yml') }),
		);
		expect(deniedReport.checks).toContainEqual(
			expect.objectContaining({ severity: 'error', message: expect.stringContaining('missing.yml') }),
		);
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});

test('reports a ready configuration and required bootstrap', () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), 'patchlane-doctor-'));
	try {
		const upstreamBare = path.join(tempRoot, 'upstream.git');
		const upstreamWork = path.join(tempRoot, 'upstream-work');
		const forkBare = path.join(tempRoot, 'fork.git');
		const forkWork = path.join(tempRoot, 'fork-work');
		git(['init', '--bare', '--initial-branch=main', upstreamBare], tempRoot);
		git(['clone', upstreamBare, upstreamWork], tempRoot);
		configureUser(upstreamWork);
		writeFileSync(path.join(upstreamWork, 'README.md'), '# Upstream\n');
		git(['add', 'README.md'], upstreamWork);
		git(['commit', '-m', 'Initial upstream'], upstreamWork);
		git(['push', 'origin', 'main'], upstreamWork);

		git(['init', '--bare', '--initial-branch=main', forkBare], tempRoot);
		git(['clone', upstreamBare, forkWork], tempRoot);
		configureUser(forkWork);
		git(['remote', 'rename', 'origin', 'upstream'], forkWork);
		git(['remote', 'add', 'origin', forkBare], forkWork);
		git(['push', 'origin', 'main'], forkWork);
		git(['switch', '-c', 'patch/sync', 'upstream/main'], forkWork);
		writeFileSync(path.join(forkWork, 'PATCH.md'), 'Patch\n');
		git(['add', 'PATCH.md'], forkWork);
		git(['commit', '-m', 'Add patch'], forkWork);
		git(['push', 'origin', 'patch/sync'], forkWork);
		git(['fetch', 'origin', 'main'], forkWork);

		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			'version: 1\nupstream: example/upstream\nsource: branch:main\npatchRefs: [patch/sync]\nciWorkflow: Existing CI\nallowedWorkflows: [ci.yml]\n',
		);
		const workflowDir = path.join(forkWork, '.github', 'workflows');
		mkdirSync(workflowDir, { recursive: true });
		writeFileSync(
			path.join(workflowDir, 'ci.yml'),
			'name: Existing CI\non:\n  push:\n    branches: [main, sync/integration]\n',
		);
		writeFileSync(
			path.join(workflowDir, 'sync-upstream.yml'),
			renderSyncWorkflow(workflowConfig('Existing CI'), '1.2.3'),
		);
		writeFileSync(
			path.join(workflowDir, 'promote-tested-sync.yml'),
			renderPromotionWorkflow(workflowConfig('Existing CI'), '1.2.3'),
		);

		git(['remote', 'set-url', 'upstream', upstreamBare], forkWork);
		const report = runDoctor({ cwd: forkWork, json: true });
		expect(report.ok).toBe(true);
		expect(report.resolvedSource).toBe('branch main');
		expect(report.checks).toContainEqual(
			expect.objectContaining({ severity: 'info', message: expect.stringContaining("'patch/sync' contains 1") }),
		);
		expect(report.checks).toContainEqual(
			expect.objectContaining({ severity: 'warning', message: expect.stringContaining('Initial bootstrap') }),
		);

		writeFileSync(
			path.join(forkWork, '.patchlane.yml'),
			[
				'version: 1',
				'upstream: example/upstream',
				'source: branch:main',
				'patchRefs: [patch/sync]',
				'ciWorkflow: Existing CI',
				'allowedWorkflows: [ci.yml]',
				'notifications:',
				'  githubIssues:',
				'    events: [sync-failed, ci-failed]',
				'',
			].join('\n'),
		);
		const notificationReport = runDoctor({ cwd: forkWork, json: true });
		expect(notificationReport.ok).toBe(false);
		expect(notificationReport.checks).toContainEqual(
			expect.objectContaining({ severity: 'error', message: expect.stringContaining('issues: write') }),
		);
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
});
