# Patchlane

**Keep your fork in sync without the merge headaches.**

Patchlane is a reusable GitHub Actions workflow that automates the tedious work of maintaining forked repositories with custom patches. Stop wrestling with merge conflicts and let Patchlane rebuild your integration branch cleanly—every time.

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
4. **Auto-sync** – When all patches apply cleanly, Patchlane pushes the result and opens/updates a PR

---

## Key Features

| Feature                          | Benefit                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| **🔄 Automatic rebuilds**        | Schedule daily syncs or trigger manually—your integration branch stays current |
| **🎯 Precise failure detection** | Know immediately which patch failed and why, with conflict details             |
| **🏷️ Release tracking**          | Follow `latest`, `prerelease`, or match tags with regex patterns               |
| **🧪 Dry-run mode**              | Test patch application without pushing changes                                 |
| **📦 Clean git history**         | No merge commits—just a fresh integration branch built from upstream           |
| **⚡ Reusable workflow**         | One configuration, use across all your forks                                   |

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

### 2. Add the Caller Workflow

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
  pull-requests: write

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
      pr_labels: automated,upstream-sync
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

### 3. Run It

Trigger the workflow manually with `dry_run: true` first to verify your patches apply cleanly.

---

## Configuration Reference

### Inputs

| Input              | Required | Default                                 | Description                                                    |
| ------------------ | -------- | --------------------------------------- | -------------------------------------------------------------- |
| `upstream_owner`   | ✅       | —                                       | GitHub owner/org of the upstream repository                    |
| `upstream_repo`    | ✅       | —                                       | Upstream repository name                                       |
| `patch_refs`       | ✅       | —                                       | Newline-delimited list of patch branches (applied in order)    |
| `base_branch`      | —        | `main`                                  | Fork branch that receives sync PRs                             |
| `upstream_ref`     | —        | `main`                                  | Upstream branch when not using releases                        |
| `release_selector` | —        | `latest`                                | `latest`, `prerelease`, regex, or blank for `upstream_ref`     |
| `sync_branch`      | —        | `sync/integration`                      | Integration branch name                                        |
| `pr_labels`        | —        | `upstream-sync`                         | Labels added to created PRs                                    |
| `pr_title`         | —        | `Sync integration branch from {source}` | Template with `{base_branch}`, `{upstream}`, `{source}` tokens |
| `dry_run`          | —        | `false`                                 | Test patches without pushing                                   |

### Outputs

| Output                 | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `sync_branch`          | The integration branch that was built                             |
| `pr_number` / `pr_url` | PR details when created/updated                                   |
| `failed_bookmark`      | First patch that failed to apply                                  |
| `failed_commit`        | Commit at the head of the failed patch                            |
| `conflicted_paths`     | Files with conflicts                                              |
| `applied_refs`         | Successfully applied patches                                      |
| `status`               | `dry_run`, `created`, `updated`, `missing_patch`, or `conflicted` |

---

## Understanding the Patch Model

### Patch-Queue vs. Merge-and-Resolve

**Traditional approach:** Merge upstream into your fork, resolve conflicts, commit. Over time, your history becomes a tangled web of merge commits and conflict resolutions.

**Patchlane approach:** Treat your customizations as an ordered list of patches applied on top of a clean upstream base. Every sync starts fresh—no accumulated merge history.

### Best Practices

1. **Keep patches focused** – Each patch branch should address a single concern
2. **Order matters** – Put foundational patches first (e.g., `patch/ci` before `patch/product`)
3. **Store workflows on patches** – Your fork's CI workflows should live on a patch branch, not the base branch
4. **Test locally first** – Use `dry_run: true` to validate before letting automation push

---

## Repository Structure

```
patchlane/
├── .github/workflows/patchlane.yml    # Reusable workflow
├── src/integration-sync.ts            # Core sync logic
├── examples/
│   ├── sync-upstream.yml              # Sample caller workflow
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
