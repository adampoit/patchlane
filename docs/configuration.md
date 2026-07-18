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
notifications:
    githubIssues:
        assignees: [maintainer]
        labels: [patchlane, automation-failure]
        events: [sync-failed, ci-failed, promotion-failed]
        closeOnRecovery: true
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
| `allowedWorkflows` | yes         | Repository workflow filenames permitted alongside generated ones  |
| `notifications`    | no          | Automation failure notification providers                         |

Patchlane implicitly adds its generated `sync-upstream.yml` and `promote-tested-sync.yml` workflows to the allowlist. Configure only repository-specific workflows such as CI; use an empty list when no additional workflows are expected. Doctor, every sync mode, and promotion reject unexpected or missing workflow files and dangling local reusable-workflow references. Sync validates after all patches are composed and before publishing `syncBranch`; promotion validates the exact `EXPECTED_SYNC_SHA`.

Supported sources:

- `release:latest`
- `release:prerelease`
- `release:<regex>`
- `branch:<ref>`

CLI flags and environment variables override config values for one run. Legacy `UPSTREAM_OWNER`, `UPSTREAM_REPO`, `UPSTREAM_REF`, `RELEASE_SELECTOR`, `BASE_BRANCH`, `SYNC_BRANCH`, and `PATCH_REFS` variables remain supported for migration.

GitHub issue notifications are optional. Patchlane keeps one issue per failure event, updates it on repeated failures, assigns configured users individually, and closes it after a successful run when `closeOnRecovery` is enabled. The generated App tokens request `issues: write` only when they handle an enabled GitHub issue event. Notification API errors are warnings and do not replace the sync, CI, or promotion result.

## GitHub App authentication

The generated workflows require:

- repository variable `PATCHLANE_APP_CLIENT_ID`
- repository secret `PATCHLANE_APP_PRIVATE_KEY`

The App installation must grant Contents read/write and Workflows write. Enable Issues read/write when GitHub issue notifications are configured. Patchlane requests these permissions explicitly when creating each short-lived token, passes the token to checkout and `gh` as `GH_TOKEN`, and leaves the built-in `GITHUB_TOKEN` read-only.

A GitHub App or user token is required for pushes that must start another workflow. GitHub deliberately suppresses most workflow events caused by the built-in `GITHUB_TOKEN`; increasing its workflow permissions does not change that behavior. See [Manual setup](manual-setup.md) for App creation and repository configuration.

## Commands

### Initialize files

```bash
npx patchlane init \
  --upstream=upstream-org/upstream-repo \
  --source=release:latest \
  --patch-refs=patch/sync,patch/ci \
  --ci-workflow="CI" \
  --allowed-workflows=ci.yml
```

This writes `.patchlane.yml`, `.github/workflows/sync-upstream.yml`, and `.github/workflows/promote-tested-sync.yml`. When `--allowed-workflows` is omitted, init adds the detected CI filename (or `fork-ci.yml`) to the configuration. It does not create patch branches or modify existing CI triggers.

### Inspect setup

```bash
npx patchlane doctor
npx patchlane doctor --json
```

Doctor checks source resolution, remote patch refs, patch bases, composed workflow configuration and policy, CI triggers, App-token wiring, permissions, and bootstrap state without changing repository state. For GitHub origins it also attempts to inspect Actions enablement and the names—not values—of the expected repository variable and secret. Insufficient metadata access is reported as a warning.

### Verify workflow authentication

After the generated workflows are present on the base branch, run:

```bash
npx patchlane verify-auth
```

This dispatches `sync-upstream.yml` with `no_push=true`, finds the newly created run, and waits for it to finish. A successful run validates the uploaded App key, installation, requested permissions, API access, authenticated checkout, and Patchlane rebuild without changing a branch. Use `--timeout <seconds>` and `--poll-interval <seconds>` to override the 60-second discovery timeout and 2-second polling interval. The equivalent environment variables are `PATCHLANE_AUTH_TIMEOUT_SECONDS` and `PATCHLANE_AUTH_POLL_INTERVAL_SECONDS`.

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

### Report an automation result

Generated workflows invoke this command automatically:

```bash
npx patchlane notify --event=sync-failed
npx patchlane notify --event=ci-failed
npx patchlane notify --event=promotion-failed
npx patchlane notify --event=sync-failed --recovered
```

The repository defaults to `GITHUB_REPOSITORY` in Actions or the GitHub `origin` remote locally. Structured context can be supplied with flags or the `PATCHLANE_STATUS`, `PATCHLANE_RUN_URL`, `UPSTREAM_SHA`, `SYNC_SHA`, `FAILED_PATCH_REF`, `FAILED_COMMIT`, `CONFLICT_PATHS`, and `APPLIED_PATCH_REFS` environment variables.

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
- `upstream_sha`
- `applied_refs`
- `failed_bookmark`
- `failed_commit`
- `conflicted_paths`

Sync status can be `dry_run`, `no_push`, `published`, `unchanged`, `missing_patch`, `conflicted`, `invalid_patch`, `invalid_patch_base`, or `workflow_policy`.
