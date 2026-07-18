import { expect, test } from 'vitest';
import type { PatchlaneConfig } from '../src/config.js';
import { renderPromotionWorkflow, renderSyncWorkflow } from '../src/workflow-templates.js';

const config: PatchlaneConfig = {
	upstreamOwner: 'example',
	upstreamRepo: 'upstream',
	source: 'release:latest',
	baseBranch: 'main',
	syncBranch: 'sync/integration',
	patchRefs: ['patch/product'],
	ciWorkflow: 'Fork CI',
	allowedWorkflows: ['ci.yml'],
	notifications: {
		githubIssues: {
			assignees: ['maintainer'],
			labels: ['patchlane'],
			events: ['sync-failed', 'ci-failed', 'promotion-failed'],
			closeOnRecovery: true,
		},
	},
};

test('renders GitHub App authentication and failure notifications with minimal permissions', () => {
	const sync = renderSyncWorkflow(config, '1.2.3');
	expect(sync).toContain('uses: actions/create-github-app-token@v3');
	expect(sync).toContain('client-id: ${{ vars.PATCHLANE_APP_CLIENT_ID }}');
	expect(sync).toContain('private-key: ${{ secrets.PATCHLANE_APP_PRIVATE_KEY }}');
	expect(sync).toContain('permission-contents: write');
	expect(sync).toContain('permission-workflows: write');
	expect(sync).toContain('permission-issues: write');
	expect(sync).toContain('token: ${{ steps.patchlane-token.outputs.token }}');
	expect(sync).toContain('GH_TOKEN: ${{ steps.patchlane-token.outputs.token }}');
	expect(sync).not.toContain('secrets.GITHUB_TOKEN');
	expect(sync).toContain('if: failure()');
	expect(sync).toContain('notify --event=sync-failed');
	expect(sync).toContain('notify --event=sync-failed --recovered');
	expect(sync).toContain('FAILED_PATCH_REF: ${{ steps.sync.outputs.failed_bookmark }}');

	const promotion = renderPromotionWorkflow(config, '1.2.3');
	expect(promotion.split('uses: actions/create-github-app-token@v3')).toHaveLength(3);
	expect(promotion).toContain('permission-workflows: write');
	expect(promotion).toContain('notify-ci-failure:');
	expect(promotion).toContain("github.event.workflow_run.conclusion != 'success'");
	expect(promotion).toContain('notify --event=ci-failed');
	expect(promotion).toContain('notify --event=promotion-failed');
	expect(promotion).toContain('notify --event=promotion-failed --recovered');
});

test('escapes the sync branch in GitHub Actions expressions', () => {
	const promotion = renderPromotionWorkflow({ ...config, syncBranch: "sync/' || true || 'integration" }, '1.2.3');
	const escapedCondition = "github.event.workflow_run.head_branch == 'sync/'' || true || ''integration'";
	expect(promotion.split(escapedCondition)).toHaveLength(3);
	expect(promotion).not.toContain("head_branch == 'sync/' || true");
});

test('does not add notification permissions or steps when notifications are omitted', () => {
	const withoutNotifications = { ...config, notifications: undefined };
	expect(renderSyncWorkflow(withoutNotifications, '1.2.3')).not.toContain('permission-issues: write');
	expect(renderSyncWorkflow(withoutNotifications, '1.2.3')).not.toContain(' patchlane@1.2.3 notify');
	expect(renderPromotionWorkflow(withoutNotifications, '1.2.3')).not.toContain('permission-issues: write');
	expect(renderPromotionWorkflow(withoutNotifications, '1.2.3')).not.toContain(' patchlane@1.2.3 notify');
});
