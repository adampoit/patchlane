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

## Workflow authentication

Patchlane automation needs a token that can push repository contents, update workflow files, and start the downstream workflows triggered by those pushes. Enable issue access when GitHub issue notifications are configured. The built-in `GITHUB_TOKEN` is not suitable because GitHub deliberately suppresses most workflow events caused by it; increasing its workflow permissions does not change that behavior.

The generated workflows use `actions/create-github-app-token` with:

- repository variable `PATCHLANE_APP_CLIENT_ID`
- repository secret `PATCHLANE_APP_PRIVATE_KEY`

The App installation must grant Contents read/write and Workflows write, plus Issues read/write when notifications are enabled. Generated jobs request the required least-privilege permissions explicitly, pass the token to checkout and `gh` as `GH_TOKEN`, and leave the built-in `GITHUB_TOKEN` read-only.

Adapted workflows may use another authentication source selected by the maintainer:

- an action step that exposes a token output;
- a `run` step that writes a token output to `GITHUB_OUTPUT`; or
- an Actions secret containing a suitable GitHub App or user token.

For a step output, checkout must use an expression in the form `${{ steps.<id>.outputs.<name> }}`. For a stored token, it must use `${{ secrets.<name> }}`. Every `patchlane sync`, `promote`, or `notify` step in that job must receive the exact same expression as `GH_TOKEN`. Compound expressions, environment indirection, `github.token`, and `secrets.GITHUB_TOKEN` are not accepted. Authentication implementation details do not belong in `.patchlane.yml`.

Doctor strictly checks credentials and requested permissions when `actions/create-github-app-token` is used directly. For other sources it validates only the token data flow because it cannot determine statically how the token is minted or which capabilities it has. Confirm custom authentication with the first workflow-driven published sync, including its downstream CI run and promotion. See [Manual setup](manual-setup.md) for the generated GitHub App setup.

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

Doctor checks source resolution, remote patch refs, patch bases, composed workflow configuration and policy, CI triggers, authentication-token wiring, permissions, and bootstrap state without changing repository state. For GitHub origins it also attempts to inspect Actions enablement. When a job uses `actions/create-github-app-token` directly, Doctor additionally inspects the names—not values—of the expected repository variable and secret and strictly validates the action's credential and permission inputs. These standard credential metadata checks are skipped when all jobs use custom token sources. Insufficient metadata access is reported as a warning.

GitHub operations resolve the fork from the configured `origin` push URL, independently of `gh repo set-default`. Use `--origin-remote-name <name>` for a differently named push remote or `--repository <owner/repo>` to override repository detection.

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

### Composed workspaces

Use a composed workspace for agent development instead of editing a raw patch branch:

```bash
npx patchlane workspace create --lane patch/product
cd ../project-patch-product
npx patchlane workspace status --json
npx patchlane workspace land --dry-run
npx patchlane workspace land                 # local lane only
npx patchlane workspace land --push          # explicit remote write
npx patchlane workspace remove
```

`workspace create` pins the source and every configured lane in local metadata under the Git common directory. Landing requires clean, linear history, checks that all pinned lane refs are fresh, replays commits onto exactly one lane, recomposes every lane, and requires an exact tree match. Use `--config-ref <ref>` when the current branch does not contain `.patchlane.yml`, and `workspace remove --force` only when intentionally discarding unlanded work.

### Version and agent skills

```bash
npx patchlane --version
npx patchlane agents
```

`agents` installs the skills bundled with the installed Patchlane package, so local package development does not require a matching GitHub tag or network access. Use `--ref=<git-ref>` only when intentionally testing skills from another Patchlane revision; `PATCHLANE_SKILLS_BASE_URL` remains available for a custom skill source.

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
