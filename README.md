# Patchlane

**Keep your fork in sync without the merge headaches.**

Patchlane is a pair of reusable GitHub Actions workflows that automate the tedious work of maintaining forked repositories with custom patches. It rebuilds a generated integration branch from upstream, reapplies your patch branches, publishes that branch for CI, and then promotes the exact tested commit onto your fork branch automatically.

---

## The Problem

Maintaining a fork with custom changes is painful:

- **Upstream updates break your patches** – You're constantly resolving the same conflicts
- **No visibility into what broke** – Finding which patch failed is a manual detective hunt
- **Merge history becomes a mess** – Traditional merge-and-resolve approaches pollute your git history
- **No automation** – You're manually rebasing and testing patches every time upstream releases

## The Solution

Patchlane introduces a **patch-queue model** that treats your fork's customizations as an ordered, testable sequence:

```
┌─────────────────────────────────────────────────────────┐
│  Upstream ───────► Integration Branch ◄─────── Patches  │
│     v2.1.0           (auto-rebuilt daily)    patch/ci   │
│                                                patch/   │
│                                                product  │
└─────────────────────────────────────────────────────────┘
```

### How It Works

1. **Start fresh** – Patchlane creates a disposable integration branch from upstream (branch or release tag)
2. **Apply patches in order** – Your configured patch branches are applied sequentially
3. **Fail fast** – If a patch conflicts, the workflow stops immediately and tells you exactly which one failed
4. **Publish the generated branch** – Patchlane force-updates `sync_branch` with the rebuilt result and records its commit SHA
5. **Run CI on `sync_branch`** – Your normal fork CI validates the generated branch
6. **Promote the tested SHA** – A second reusable workflow force-with-lease updates `base_branch` only if `sync_branch` still points at the tested SHA

---

## Key Features

| Feature                          | Benefit                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| **🔄 Automatic rebuilds**        | Schedule daily syncs or trigger manually—your candidate branch stays current    |
| **🎯 Precise failure detection** | Know immediately which patch failed and why, with conflict details              |
| **🏷️ Release tracking**          | Follow `latest`, `prerelease`, or match tags with regex patterns                |
| **🧪 Dry-run mode**              | Test patch application without pushing changes                                  |
| **📦 Clean git history**         | Fresh integration branches built from upstream without accumulating sync merges |
| **⚡ Reusable workflows**        | Separate publish and promote stages for safer automation                        |

---

## Quick Start

### 1. Create Your Patch Branches

Organize your fork-specific changes into logical patch branches:

```bash
# Fork-specific product customizations
git checkout -b patch/product

# Fork-owned workflow files
git checkout -b patch/sync
git checkout -b patch/ci
```

Push these branches to your fork.

### 2. Add the Publish Workflow

Create `.github/workflows/sync-upstream.yml` in your fork:

```yaml
name: Sync Upstream Integration

on:
  schedule:
    - cron: "0 10 * * *" # Daily at 10am
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Test without pushing changes"
        type: boolean
        default: false

permissions:
  contents: write

jobs:
  sync:
    uses: your-org/patchlane/.github/workflows/patchlane.yml@v1
    with:
      upstream_owner: kubernetes
      upstream_repo: kubernetes
      base_branch: main
      sync_branch: sync/integration
      patch_refs: |
        patch/product
        patch/sync
        patch/ci
      implementation_repository: your-org/patchlane
      implementation_ref: v1
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

### 3. Add the Promotion Workflow

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
    uses: your-org/patchlane/.github/workflows/promote.yml@v1
    with:
      base_branch: main
      sync_branch: sync/integration
      expected_sync_sha: ${{ github.event.workflow_run.head_sha }}
      implementation_repository: your-org/patchlane
      implementation_ref: v1
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

Your normal CI workflow must run on `sync/integration` so the promotion workflow receives the tested `head_sha`.

### 4. Run It

Trigger the workflow manually with `dry_run: true` first to verify your patches apply cleanly.

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
| `implementation_repository` | —        | `adampoit/patchlane` | Repository checked out to run Patchlane's Node implementation         |
| `implementation_ref`        | —        | `main`               | Ref checked out for Patchlane's Node implementation                   |

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
| `implementation_repository` | —        | `adampoit/patchlane` | Repository checked out to run Patchlane's Node implementation       |
| `implementation_ref`        | —        | `main`               | Ref checked out for Patchlane's Node implementation                 |

### Promotion Workflow Outputs

| Output         | Description                                     |
| -------------- | ----------------------------------------------- |
| `promoted_sha` | Commit SHA promoted onto `base_branch`          |
| `status`       | `promoted`, `stale_sync`, or `promotion_failed` |

---

## Understanding the Patch Model

### Patch-Queue vs. Merge-and-Resolve

**Traditional approach:** Merge upstream into your fork, resolve conflicts, commit. Over time, your history becomes a tangled web of merge commits and conflict resolutions.

**Patchlane approach:** Treat your customizations as an ordered list of patches applied on top of a clean upstream base. Every sync starts fresh, publishes a generated integration branch, and promotes your fork branch only after CI succeeds on that exact generated commit.

### Best Practices

1. **Keep patches focused** – Each patch branch should address a single concern
2. **Order matters** – Put foundational patches first (e.g., `patch/ci` before `patch/product`)
3. **Store workflows on patches** – Your fork's CI workflows should live on a patch branch, not the promoted base branch
4. **Treat the base branch as generated output** – Avoid direct commits on `base_branch`; put fork-owned changes on `patch/*`
5. **Test locally first** – Use `dry_run: true` to validate before letting automation push

When you pin the reusable workflow with `@v1` or a commit SHA, pass matching `implementation_repository` and `implementation_ref` values so the runtime checkout uses the same Patchlane revision.

For `workflow_dispatch` inputs, prefer comma-separated `patch_refs` values because the GitHub UI handles a single-line text input more reliably than multiline text.

Both formats are supported:

```yaml
patch_refs: patch/product, patch/sync, patch/ci
```

```yaml
patch_refs: |
  patch/product
  patch/sync
  patch/ci
```

Use comma-separated values for manual dispatch inputs, and newline-separated values when a committed YAML block is easier to read.

---

## Repository Structure

```
patchlane/
├── .github/workflows/patchlane.yml    # Reusable publish workflow
├── .github/workflows/promote.yml      # Reusable promotion workflow
├── src/integration-sync.ts            # Publish sync branch logic
├── src/promote-sync.ts                # Tested-SHA promotion logic
├── examples/
│   ├── sync-upstream.yml              # Sample caller workflow
│   ├── promote-tested-sync.yml        # Sample CI-gated promotion workflow
│   └── fork-ci.yml                    # Sample fork-owned CI
└── tests/integration/sync.test.ts     # Integration tests
```

---

## Development

### Local Testing

```bash
npm install
npm test
```

This builds the TypeScript, validates YAML, and runs the integration harness with mocked git operations.

---

## License

MIT
