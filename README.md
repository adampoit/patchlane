# Patchlane

**Keep your fork in sync without the merge headaches.**

Patchlane is a set of reusable GitHub Actions workflows and an npm CLI that automate maintaining forked repositories with custom patches. It rebuilds an integration branch from upstream, reapplies your patch branches, publishes the result for CI, and then promotes the exact tested commit onto your fork branch automatically.

Install it from npm and run it locally or inside your own workflows:

```bash
npx patchlane sync --upstream-owner=kubernetes --upstream-repo=kubernetes --patch-refs="patch/product,patch/sync"
```

## How It Works

1. **Rebuild** – Patchlane creates a fresh integration branch from an upstream branch or release tag.
2. **Apply patches** – Your configured patch branches are applied sequentially.
3. **Fail fast** – If a patch conflicts, the workflow stops and reports which patch failed and why.
4. **Publish** – The rebuilt branch is force-pushed to `sync_branch` and its commit SHA is recorded.
5. **Run CI** – Your fork's CI runs on `sync_branch` and validates the result.
6. **Promote** – A second reusable workflow force-with-lease updates `base_branch` only if `sync_branch` still points at the tested SHA.

## Quick Start

### Prerequisites

- A forked repository on GitHub.
- `permissions: contents: write` in your workflow so the default `GITHUB_TOKEN` can push branches.

### 1. Create Patch Branches

Organize your fork-specific changes into logical patch branches and push them to your fork:

```bash
git checkout -b patch/product
git checkout -b patch/sync
git checkout -b patch/ci
```

### 2. Add the Sync Workflow

Create `.github/workflows/sync-upstream.yml` in your fork:

```yaml
name: Sync Upstream Integration

on:
  schedule:
    - cron: "0 10 * * *"
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Test without pushing changes"
        type: boolean
        default: true

permissions:
  contents: write

jobs:
  sync:
    uses: your-org/patchlane/.github/workflows/patchlane.yml@main
    with:
      upstream_owner: kubernetes
      upstream_repo: kubernetes
      base_branch: main
      sync_branch: sync/integration
      patch_refs: |
        patch/product
        patch/sync
        patch/ci
      dry_run: ${{ inputs.dry_run || false }}
```

### 3. Add a CI Workflow

Create `.github/workflows/fork-ci.yml` in your fork. **It must run on `sync_branch` pushes** so the promotion workflow receives the tested `head_sha`:

```yaml
name: Fork CI

on:
  pull_request:
  push:
    branches:
      - main
      - sync/integration

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "Replace this with your fork's actual CI checks."
```

### 4. Add the Promotion Workflow

Create `.github/workflows/promote-tested-sync.yml` in your fork:

```yaml
name: Promote Tested Sync Branch

on:
  workflow_run:
    workflows: ["Fork CI"]
    types: [completed]

permissions:
  contents: write

jobs:
  promote:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_branch == 'sync/integration'
    uses: your-org/patchlane/.github/workflows/promote.yml@main
    with:
      base_branch: main
      sync_branch: sync/integration
      expected_sync_sha: ${{ github.event.workflow_run.head_sha }}
```

### 5. Run It

Trigger the sync workflow manually with `dry_run: true` first to verify your patches apply cleanly.

---

## CLI Usage

You can run Patchlane directly via `npx` without cloning the repository:

```bash
# Sync (rebuild integration branch)
npx patchlane sync \
  --upstream-owner=kubernetes \
  --upstream-repo=kubernetes \
  --patch-refs="patch/product,patch/sync,patch/ci" \
  --base-branch=main \
  --sync-branch=sync/integration \
  --dry-run

# Promote (after CI passes)
npx patchlane promote \
  --expected-sync-sha=abc123 \
  --base-branch=main \
  --sync-branch=sync/integration
```

Every CLI flag also falls back to an environment variable of the same name (e.g. `--upstream-owner` → `UPSTREAM_OWNER`). This means existing reusable workflows and local scripts continue to work without changes.

---

## Configuration Reference

### Publish Workflow Inputs

| Input                       | Required | Default              | Description                                                           |
| --------------------------- | -------- | -------------------- | --------------------------------------------------------------------- |
| `upstream_owner`            | ✅       | —                    | GitHub owner/org of the upstream repository                           |
| `upstream_repo`             | ✅       | —                    | Upstream repository name                                              |
| `patch_refs`                | ✅       | —                    | Comma- or newline-delimited list of patch branches (applied in order) |
| `base_branch`               | —        | `main`               | Fork branch later promoted by the promotion workflow                  |
| `upstream_ref`              | —        | `main`               | Upstream branch when not using releases                               |
| `release_selector`          | —        | `latest`             | `latest`, `prerelease`, regex, or blank for `upstream_ref`            |
| `sync_branch`               | —        | `sync/integration`   | Published generated branch name                                       |
| `dry_run`                   | —        | `false`              | Test patches without pushing                                          |
| `implementation_repository` | —        | `adampoit/patchlane` | **Deprecated.** Patchlane is now installed from npm at runtime.       |
| `implementation_ref`        | —        | `main`               | **Deprecated.** Patchlane is now installed from npm at runtime.       |

### Publish Workflow Outputs

| Output             | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `sync_branch`      | The generated branch that was built                      |
| `sync_sha`         | The commit SHA published to `sync_branch`                |
| `failed_bookmark`  | First patch that failed to apply                         |
| `failed_commit`    | Commit at the head of the failed patch                   |
| `conflicted_paths` | Files with conflicts                                     |
| `applied_refs`     | Successfully applied patches                             |
| `status`           | `dry_run`, `published`, `missing_patch`, or `conflicted` |

### Promotion Workflow Inputs

| Input                       | Required | Default              | Description                                                         |
| --------------------------- | -------- | -------------------- | ------------------------------------------------------------------- |
| `base_branch`               | —        | `main`               | Fork branch promoted to the tested sync commit                      |
| `sync_branch`               | —        | `sync/integration`   | Generated branch that already passed CI                             |
| `expected_sync_sha`         | ✅       | —                    | Tested commit SHA that must still be the current `sync_branch` head |
| `implementation_repository` | —        | `adampoit/patchlane` | **Deprecated.** Patchlane is now installed from npm at runtime.     |
| `implementation_ref`        | —        | `main`               | **Deprecated.** Patchlane is now installed from npm at runtime.     |

### Promotion Workflow Outputs

| Output         | Description                                     |
| -------------- | ----------------------------------------------- |
| `promoted_sha` | Commit SHA promoted onto `base_branch`          |
| `status`       | `promoted`, `stale_sync`, or `promotion_failed` |

---

## Patch Format

`patch_refs` accepts comma- or newline-delimited branch names. Use commas for `workflow_dispatch` inputs (the GitHub UI handles single-line text more reliably) and newlines for committed YAML:

```yaml
# Good for workflow_dispatch inputs
patch_refs: patch/product, patch/sync, patch/ci

# Good for committed workflow files
patch_refs: |
  patch/product
  patch/sync
  patch/ci
```

## Best Practices

- **Keep patches focused** – Each patch branch should address a single concern.
- **Order matters** – Put foundational patches first (e.g., `patch/ci` before `patch/product`).
- **Store workflows on patches** – Your fork's CI and sync workflows should live on patch branches, not the promoted base branch.
- **Treat the base branch as generated output** – Avoid direct commits on `base_branch`; put fork-owned changes on `patch/*`.
- **Test locally first** – Use `dry_run: true` to validate before letting automation push.

---

## Development

```bash
npm install
npm test
```

This builds the TypeScript and runs the integration harness with mocked git operations.

### Publishing

Patchlane is published to npm automatically when a GitHub Release is created. Make sure the `NPM_TOKEN` repository secret is configured with a valid npm access token.

## License

MIT
