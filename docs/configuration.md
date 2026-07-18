# Configuration and Command Reference

## `.patchlane.yml`

`patchlane init` creates the repository configuration and pinned GitHub workflow files:

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
allowedWorkflows:
    - ci.yml
    - promote-tested-sync.yml
    - sync-upstream.yml
```

| Field              | Required    | Description                                                       |
| ------------------ | ----------- | ----------------------------------------------------------------- |
| `version`          | yes         | Configuration schema version; currently `1`                       |
| `upstream`         | yes         | GitHub repository in `owner/repo` form                            |
| `source`           | yes         | Explicit release or branch source                                 |
| `baseBranch`       | no          | Generated branch promoted after successful CI; defaults to `main` |
| `syncBranch`       | no          | Generated branch published for CI; defaults to `sync/integration` |
| `patchRefs`        | yes         | Independent patch branches applied in order                       |
| `ciWorkflow`       | recommended | Exact existing CI workflow name used by `workflow_run`            |
| `allowedWorkflows` | no          | Exact workflow filenames permitted in the composed tree           |

When `allowedWorkflows` is configured, doctor, every sync mode, and promotion reject unexpected or missing workflow files and dangling local reusable-workflow references. Sync validates after all patches are composed and before publishing `syncBranch`; promotion validates the exact `EXPECTED_SYNC_SHA`. Omitting the field preserves the existing behavior.

Supported sources:

- `release:latest`
- `release:prerelease`
- `release:<regex>`
- `branch:<ref>`

CLI flags and environment variables override config values for one run. Legacy `UPSTREAM_OWNER`, `UPSTREAM_REPO`, `UPSTREAM_REF`, `RELEASE_SELECTOR`, `BASE_BRANCH`, `SYNC_BRANCH`, and `PATCH_REFS` variables remain supported for migration.

## Commands

### Initialize files

```bash
npx patchlane init \
  --upstream=upstream-org/upstream-repo \
  --source=release:latest \
  --patch-refs=patch/sync,patch/ci \
  --ci-workflow="CI"
```

This writes `.patchlane.yml`, `.github/workflows/sync-upstream.yml`, and `.github/workflows/promote-tested-sync.yml`. It does not create patch branches or modify existing CI triggers.

### Inspect setup

```bash
npx patchlane doctor
npx patchlane doctor --json
```

Doctor checks source resolution, remote patch refs, patch bases, composed workflow configuration and policy, CI triggers, permissions, and bootstrap state without changing repository state.

### Validate or publish a sync

```bash
# Validate in a detached worktree
npx patchlane sync --dry-run

# Build or reset the local sync branch without publishing it
npx patchlane sync --skip-push

# Rebuild and publish the configured sync branch
npx patchlane sync
```

`--no-push` remains as a legacy alias for `--skip-push`.

### Bootstrap the first promotion

```bash
# Validate only
npx patchlane bootstrap

# Validate and publish the generated branch
npx patchlane bootstrap --publish

# Publish, wait for CI, and promote the tested SHA
npx patchlane bootstrap --wait
```

Bootstrap is needed when the promotion workflow is not already present on the generated base branch. Existing Patchlane forks with active sync and promotion workflows can roll configuration changes forward through their normal tested sync flow.

`bootstrap --wait` waits up to 10 minutes for GitHub Actions to expose the exact published SHA and reports progress once per minute. Use `--ci-timeout <seconds>` and `--ci-poll-interval <seconds>` to override the defaults. The equivalent environment variables are `PATCHLANE_CI_TIMEOUT_SECONDS` and `PATCHLANE_CI_POLL_INTERVAL_SECONDS`.

### Promote an exact SHA

```bash
npx patchlane promote --expected-sync-sha=<sha>
```

Promotion verifies that the tested SHA is still the current sync-branch head before updating the generated base branch with force-with-lease.

### Install agent skills

```bash
npx patchlane agents
```

The installer fetches skills matching the installed Patchlane version. Use `--ref=<git-ref>` only when intentionally testing skills from another Patchlane revision.

## Sync environment overrides

| Variable               | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `UPSTREAM_SOURCE`      | Override the configured source                    |
| `PATCH_REFS`           | Override ordered patch refs                       |
| `BASE_BRANCH`          | Override the generated base branch                |
| `SYNC_BRANCH`          | Override the generated sync branch                |
| `DRY_RUN`              | Validate without creating the local sync branch   |
| `NO_PUSH`              | Build locally without publishing                  |
| `FORCE_PUSH`           | Publish even when the generated tree is unchanged |
| `ORIGIN_REMOTE_NAME`   | Override the fork remote name                     |
| `UPSTREAM_REMOTE_NAME` | Override the upstream remote name                 |
| `UPSTREAM_REMOTE_URL`  | Override the inferred upstream URL                |

## GitHub Actions outputs

Patchlane writes these outputs when `GITHUB_OUTPUT` is available:

- `status`
- `sync_branch`
- `sync_sha`
- `applied_refs`
- `failed_bookmark`
- `failed_commit`
- `conflicted_paths`

Sync status can be `dry_run`, `no_push`, `published`, `unchanged`, `missing_patch`, `conflicted`, `invalid_patch`, `invalid_patch_base`, or `workflow_policy`.
