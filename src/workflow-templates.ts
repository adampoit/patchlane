import type { PatchlaneConfig } from './config.js';

export function renderSyncWorkflow(config: PatchlaneConfig, packageVersion: string) {
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

permissions:
  contents: write

jobs:
  fork-sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Run patchlane sync
        run: npx patchlane@${packageVersion} sync
        env:
          UPSTREAM_SOURCE: \${{ inputs.source }}
          PATCH_REFS: \${{ inputs.patch_refs }}
          NO_PUSH: \${{ inputs.no_push || false }}
`;
}

export function renderPromotionWorkflow(config: PatchlaneConfig, packageVersion: string) {
	const ciWorkflow = config.ciWorkflow ?? 'Fork CI';
	return `name: Promote Tested Sync Branch

on:
  workflow_run:
    workflows: ["${ciWorkflow.replaceAll('"', '\\"')}"]
    types: [completed]

permissions:
  contents: write

jobs:
  promote:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_branch == '${config.syncBranch}'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Run patchlane promote
        run: npx patchlane@${packageVersion} promote
        env:
          EXPECTED_SYNC_SHA: \${{ github.event.workflow_run.head_sha }}
`;
}
