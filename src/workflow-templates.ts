import type { NotificationEvent, PatchlaneConfig } from './config.js';

export const GITHUB_APP_CLIENT_ID_VARIABLE = 'PATCHLANE_APP_CLIENT_ID';
export const GITHUB_APP_PRIVATE_KEY_SECRET = 'PATCHLANE_APP_PRIVATE_KEY';
export const GITHUB_APP_TOKEN_STEP_ID = 'patchlane-token';

function hasEvent(config: PatchlaneConfig, event: NotificationEvent) {
	return config.notifications?.githubIssues.events.includes(event) ?? false;
}

function closeOnRecovery(config: PatchlaneConfig) {
	return config.notifications?.githubIssues.closeOnRecovery ?? false;
}

function githubTokenPermissions() {
	return `permissions:
  contents: read`;
}

function appTokenStep(options: { contents: 'read' | 'write'; workflows?: boolean; issues?: boolean }) {
	return `      - name: Create Patchlane token
        id: ${GITHUB_APP_TOKEN_STEP_ID}
        uses: actions/create-github-app-token@v3
        with:
          client-id: \${{ vars.${GITHUB_APP_CLIENT_ID_VARIABLE} }}
          private-key: \${{ secrets.${GITHUB_APP_PRIVATE_KEY_SECRET} }}
          permission-contents: ${options.contents}${options.workflows ? '\n          permission-workflows: write' : ''}${options.issues ? '\n          permission-issues: write' : ''}
`;
}

function checkoutStep() {
	return `      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ steps.${GITHUB_APP_TOKEN_STEP_ID}.outputs.token }}
`;
}

function githubTokenEnvironment() {
	return `          GH_TOKEN: \${{ steps.${GITHUB_APP_TOKEN_STEP_ID}.outputs.token }}`;
}

function githubExpressionString(value: string) {
	return value.replaceAll("'", "''");
}

export function renderSyncWorkflow(config: PatchlaneConfig, packageVersion: string) {
	const notifyFailures = hasEvent(config, 'sync-failed');
	const notifyRecovery = notifyFailures && closeOnRecovery(config);
	return `name: Sync Upstream Integration

on:
  schedule:
    - cron: "0 10 * * *"
  workflow_dispatch:
    inputs:
      no_push:
        description: Build the sync branch without publishing it.
        type: boolean
        required: false
        default: false
      source:
        description: Override the configured source, such as release:latest or branch:main.
        type: string
        required: false
        default: ""
      patch_refs:
        description: Override the configured comma-separated patch branches.
        type: string
        required: false
        default: ""

${githubTokenPermissions()}

jobs:
  fork-sync:
    runs-on: ubuntu-latest
    steps:
${appTokenStep({ contents: 'write', workflows: true, issues: notifyFailures })}${checkoutStep()}
      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Run patchlane sync${notifyFailures ? '\n        id: sync' : ''}
        run: npx patchlane@${packageVersion} sync
        env:
${githubTokenEnvironment()}
          UPSTREAM_SOURCE: \${{ inputs.source }}
          PATCH_REFS: \${{ inputs.patch_refs }}
          NO_PUSH: \${{ inputs.no_push || false }}
${
	notifyFailures
		? `
      - name: Notify maintainers of sync failure
        if: failure()
        continue-on-error: true
        run: npx patchlane@${packageVersion} notify --event=sync-failed
        env:
${githubTokenEnvironment()}
          PATCHLANE_STATUS: \${{ steps.sync.outputs.status || 'failed' }}
          UPSTREAM_SHA: \${{ steps.sync.outputs.upstream_sha }}
          SYNC_SHA: \${{ steps.sync.outputs.sync_sha }}
          FAILED_PATCH_REF: \${{ steps.sync.outputs.failed_bookmark }}
          FAILED_COMMIT: \${{ steps.sync.outputs.failed_commit }}
          CONFLICT_PATHS: \${{ steps.sync.outputs.conflicted_paths }}
          APPLIED_PATCH_REFS: \${{ steps.sync.outputs.applied_refs }}
`
		: ''
}${
		notifyRecovery
			? `
      - name: Close recovered sync notification
        if: success()
        continue-on-error: true
        run: npx patchlane@${packageVersion} notify --event=sync-failed --recovered
        env:
${githubTokenEnvironment()}
          PATCHLANE_STATUS: \${{ steps.sync.outputs.status }}
          UPSTREAM_SHA: \${{ steps.sync.outputs.upstream_sha }}
          SYNC_SHA: \${{ steps.sync.outputs.sync_sha }}
`
			: ''
	}`;
}

export function renderPromotionWorkflow(config: PatchlaneConfig, packageVersion: string) {
	const ciWorkflow = config.ciWorkflow ?? 'Fork CI';
	const notifyCi = hasEvent(config, 'ci-failed');
	const notifyPromotion = hasEvent(config, 'promotion-failed');
	const notifyCiRecovery = notifyCi && closeOnRecovery(config);
	const notifyPromotionRecovery = notifyPromotion && closeOnRecovery(config);
	const syncBranch = githubExpressionString(config.syncBranch);
	return `name: Promote Tested Sync Branch

on:
  workflow_run:
    workflows: ["${ciWorkflow.replaceAll('"', '\\"')}"]
    types: [completed]

${githubTokenPermissions()}

jobs:
  promote:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_branch == '${syncBranch}'
    runs-on: ubuntu-latest
    steps:
${appTokenStep({ contents: 'write', workflows: true, issues: notifyCiRecovery || notifyPromotion })}${checkoutStep()}
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
${
	notifyCiRecovery
		? `
      - name: Close recovered CI notification
        continue-on-error: true
        run: npx patchlane@${packageVersion} notify --event=ci-failed --recovered
        env:
${githubTokenEnvironment()}
          PATCHLANE_STATUS: \${{ github.event.workflow_run.conclusion }}
          PATCHLANE_RUN_URL: \${{ github.event.workflow_run.html_url }}
          SYNC_SHA: \${{ github.event.workflow_run.head_sha }}
`
		: ''
}
      - name: Run patchlane promote${notifyPromotion ? '\n        id: promote' : ''}
        run: npx patchlane@${packageVersion} promote
        env:
${githubTokenEnvironment()}
          EXPECTED_SYNC_SHA: \${{ github.event.workflow_run.head_sha }}
${
	notifyPromotion
		? `
      - name: Notify maintainers of promotion failure
        if: failure()
        continue-on-error: true
        run: npx patchlane@${packageVersion} notify --event=promotion-failed
        env:
${githubTokenEnvironment()}
          PATCHLANE_STATUS: \${{ steps.promote.outputs.status || 'failed' }}
          PATCHLANE_RUN_URL: \${{ github.event.workflow_run.html_url }}
          SYNC_SHA: \${{ github.event.workflow_run.head_sha }}
`
		: ''
}${
		notifyPromotionRecovery
			? `
      - name: Close recovered promotion notification
        if: success()
        continue-on-error: true
        run: npx patchlane@${packageVersion} notify --event=promotion-failed --recovered
        env:
${githubTokenEnvironment()}
          PATCHLANE_STATUS: \${{ steps.promote.outputs.status }}
          PATCHLANE_RUN_URL: \${{ github.event.workflow_run.html_url }}
          SYNC_SHA: \${{ github.event.workflow_run.head_sha }}
`
			: ''
	}${
		notifyCi
			? `
  notify-ci-failure:
    if: >-
      github.event.workflow_run.conclusion != 'success' &&
      github.event.workflow_run.head_branch == '${syncBranch}'
    runs-on: ubuntu-latest
    steps:
${appTokenStep({ contents: 'read', issues: true })}${checkoutStep()}
      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Notify maintainers of CI failure
        continue-on-error: true
        run: npx patchlane@${packageVersion} notify --event=ci-failed
        env:
${githubTokenEnvironment()}
          PATCHLANE_STATUS: \${{ github.event.workflow_run.conclusion }}
          PATCHLANE_RUN_URL: \${{ github.event.workflow_run.html_url }}
          SYNC_SHA: \${{ github.event.workflow_run.head_sha }}
`
			: ''
	}`;
}
