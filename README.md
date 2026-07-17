# Patchlane

**Keep a customized fork current without merge commits or untested promotions.**

Patchlane rebuilds an integration branch from an upstream release or branch, reapplies focused patch branches, runs your existing CI, and promotes the exact tested commit.

## Quick Start with an Agent

From a clone of your GitHub fork:

```bash
npx patchlane agents
```

Then ask your coding agent:

> Use the `patchlane-fork-setup` skill to configure this fork. Track `OWNER/REPO` using the latest stable release. Show me the plan before pushing or rewriting branches, then validate and bootstrap it.

The skill inspects the fork, asks you to confirm the upstream source, creates independently based patch branches, adapts the existing CI workflow, and performs the first tested promotion.

Prefer to do it yourself? Follow the short [manual setup walkthrough](docs/manual-setup.md).

## How It Works

1. Resolve an explicit source such as `release:latest` or `branch:main`.
2. Rebuild `sync/integration` from that source.
3. Replay the configured patch branches in order.
4. Run the fork's existing CI on the generated branch.
5. Promote only the exact SHA that passed CI.

The promoted base branch is generated output. Fork-owned changes belong on `patch/*` branches.

## Configuration

`patchlane init` creates `.patchlane.yml` and pinned GitHub workflow files:

```yaml
version: 1
upstream: upstream-org/upstream-repo
source: release:latest
baseBranch: main
syncBranch: sync/integration
patchRefs:
    - patch/sync
    - patch/ci
    - patch/product
ciWorkflow: CI
```

Supported sources:

- `release:latest`
- `release:prerelease`
- `release:<regex>`
- `branch:<ref>`

CLI flags and environment variables can override config values for one run. Legacy `UPSTREAM_REF` and `RELEASE_SELECTOR` settings remain supported.

## Commands

```bash
# Create config and pinned workflow files
npx patchlane init --upstream=upstream-org/upstream-repo --source=release:latest

# Check remotes, source resolution, patch bases, CI triggers, and bootstrap state
npx patchlane doctor
npx patchlane doctor --json

# Validate without changing the working tree or publishing a branch
npx patchlane sync --dry-run

# Validate the initial setup, then publish/wait/promote when ready
npx patchlane bootstrap
npx patchlane bootstrap --publish
npx patchlane bootstrap --wait

# Normal rebuild; publishes sync/integration unless unchanged
npx patchlane sync

# Build the local sync branch but do not publish it
npx patchlane sync --no-push

# Promote an exact tested SHA
npx patchlane promote --expected-sync-sha=<sha>

# Install agent skills matching the installed CLI version
npx patchlane agents
```

`--dry-run` is the safest local validation mode. `--no-push` does not publish, but it does create or reset the local sync branch.

## Initial Bootstrap

Patchlane workflows live on `patch/sync`, so they are not available on the default branch before the first promotion. `patchlane bootstrap` handles this explicitly:

- no flags: validate only
- `--publish`: publish the generated branch and print the exact promotion command
- `--wait`: publish, wait for the configured CI workflow, and promote the successful SHA

After bootstrap, scheduled sync and automatic promotion workflows take over.

## Sync Reference

| Setting / Env Var     | Default            | Description                                       |
| --------------------- | ------------------ | ------------------------------------------------- |
| `upstream`            | required           | GitHub repository in `owner/repo` form            |
| `source`              | required           | Explicit release or branch source                 |
| `patchRefs`           | required           | Ordered independent patch branches                |
| `baseBranch`          | `main`             | Generated branch updated after successful CI      |
| `syncBranch`          | `sync/integration` | Generated branch published for CI                 |
| `ciWorkflow`          | detected by init   | Existing workflow name used by `workflow_run`     |
| `DRY_RUN`             | `false`            | Validate in a detached worktree                   |
| `NO_PUSH`             | `false`            | Build locally without publishing                  |
| `FORCE_PUSH`          | `false`            | Publish even when the generated tree is unchanged |
| `UPSTREAM_REMOTE_URL` | inferred           | Override the upstream Git remote URL              |

GitHub Actions outputs include `status`, `sync_branch`, `sync_sha`, `applied_refs`, `failed_bookmark`, `failed_commit`, and `conflicted_paths`. Status can be `dry_run`, `no_push`, `published`, `unchanged`, `missing_patch`, `conflicted`, `invalid_patch`, or `invalid_patch_base`.

## Best Practices

- Create every patch branch independently from the selected upstream source.
- Keep patches focused and order foundational changes first.
- Preserve the existing CI workflow name and configure `ciWorkflow` to match it.
- Run `patchlane doctor` and `patchlane sync --dry-run` before publishing.
- Treat the promoted base and sync branches as generated output.

## Development

```bash
npm install
npm test
```

## License

MIT
