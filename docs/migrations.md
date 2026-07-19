# Patchlane Migration Guide

Follow the section for the version you are adopting. Migration notes are listed newest first.

## 0.5

Patchlane 0.5 requires every version-1 `.patchlane.yml` file to define `allowedWorkflows` and updates generated workflows to authenticate with a GitHub App. Patchlane implicitly includes its generated `sync-upstream.yml` and `promote-tested-sync.yml` workflows, so list only repository-specific workflows.

### 1. Inventory the composed workflow tree

Inspect the workflows on the current generated base branch and review the configured patch branches for workflow additions or deletions:

```bash
git fetch origin
git ls-tree -r --name-only origin/main -- .github/workflows
```

Decide which workflows should remain after Patchlane composes the upstream source and every configured patch. Include CI, documentation, maintenance, and local reusable workflows only when they are intentionally retained. Every target referenced through `uses: ./.github/workflows/<file>` must also be present and allowed.

Do not add these generated workflows explicitly; Patchlane allows and requires them automatically:

- `sync-upstream.yml`
- `promote-tested-sync.yml`

### 2. Add the required allowlist

Update `.patchlane.yml` on the patch branch that owns Patchlane configuration, normally `patch/sync`:

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
```

Use `allowedWorkflows: []` when the composed tree should contain only Patchlane's generated workflows. Add patches that delete unwanted upstream workflows rather than allowing them merely because they currently exist.

### 3. Choose workflow authentication

Inspect the existing workflows and choose how the fork should authenticate before replacing or adapting them. The token must be able to push repository contents, update workflow files, and start downstream workflows. Enable issue access when GitHub issue notifications are configured. Do not use `github.token` or `secrets.GITHUB_TOKEN`: pushes made by the built-in `GITHUB_TOKEN` do not start the required downstream workflow runs.

The latest 0.5 workflows use `actions/create-github-app-token`. For this default, create or reuse a GitHub App installed on the fork with Contents read/write and Workflows write, plus Issues read/write when notifications are enabled. Configure its credentials using the standard names:

```bash
FORK=OWNER/REPOSITORY
gh variable set PATCHLANE_APP_CLIENT_ID --repo "$FORK" --body "YOUR_APP_CLIENT_ID"
gh secret set PATCHLANE_APP_PRIVATE_KEY --repo "$FORK" < /path/to/app-private-key.pem
```

Alternatively, preserve an established authentication source or use another source selected by the maintainer. Patchlane accepts a token exposed by an action or `run` step as `${{ steps.<id>.outputs.<name> }}`, or a suitable App or user token stored as `${{ secrets.<name> }}`. Checkout and every Patchlane command in the job must use the exact same expression. Keep the selected source's existing inputs and secret names; do not request a client ID or duplicate private-key secret unless that source requires them.

Update both workflow files to the latest 0.5 structure without overwriting the selected authentication implementation. Doctor validates custom token wiring but cannot inspect how the token is created or which capabilities it has. Confirm the selected authentication with the first workflow-driven published sync, including the downstream CI run and promotion.

### 4. Validate before rollout

After pushing the updated patch refs, validate with Patchlane 0.5:

```bash
npx patchlane@0.5 doctor
npx patchlane@0.5 sync --dry-run
```

Doctor should identify every unexpected or missing workflow by filename. The dry run validates the actual output after all configured patches are replayed without changing the local or remote sync branch.

### 5. Roll out through a tested promotion

Update the Patchlane version selector in the sync and promotion workflows as part of the same configuration patch. From that patch branch, use the latest 0.5 client for the first policy-enforced rebuild and promotion:

```bash
npx patchlane@0.5 bootstrap --wait
```

This validates the allowlist before publishing `sync/integration`, waits for CI on the exact published SHA, revalidates that SHA, and then promotes it. Confirm afterward that the generated base contains the intended workflow set and that scheduled syncs use the new Patchlane version. On the first workflow-driven sync that publishes a new integration SHA, confirm that authentication succeeds, CI runs as a `push` for that SHA, and promotion updates the base branch.

### 6. Optionally enable maintainer notifications

Failure notifications are opt-in. Existing configurations that omit `notifications` keep their current behavior and require no notification-specific migration.

To enable notifications, add the provider configuration to the patch branch that owns `.patchlane.yml`:

```yaml
notifications:
    githubIssues:
        assignees:
            - maintainer
        labels:
            - patchlane
            - automation-failure
        events:
            - sync-failed
            - ci-failed
            - promotion-failed
        closeOnRecovery: true
```

Update both generated workflow files from the 0.5 templates in the same patch:

- `sync-upstream.yml` must request `permission-issues: write` for its App token, report `sync-failed` after a failed sync, and optionally report recovery after success.
- `promote-tested-sync.yml` must request `permission-issues: write` in jobs that report issues, report unsuccessful CI workflow runs, report failed promotions, and optionally report each recovery.

Do not add only the configuration block: existing workflow files do not invoke `patchlane notify`, and `patchlane doctor` reports missing `issues: write` permissions. Keep notification steps on `continue-on-error` so a GitHub API or assignment failure cannot replace the original automation result.

Run `doctor`, then roll the configuration and workflow changes forward through `bootstrap --wait` as described above. Confirm that configured labels exist and that each assignee can be assigned to issues in the fork.

## 0.4

Existing Patchlane forks can migrate without rebuilding their patch strategy or interrupting scheduled syncs. Legacy workflow environment variables remain supported, so migration can be rolled out through the existing sync and promotion flow.

### 1. Translate the existing workflow configuration

Read the current sync workflow and map its environment variables into `.patchlane.yml`:

| Legacy environment variable                         | `.patchlane.yml` field       |
| --------------------------------------------------- | ---------------------------- |
| `UPSTREAM_OWNER` and `UPSTREAM_REPO`                | `upstream: owner/repo`       |
| Non-empty `RELEASE_SELECTOR`                        | `source: release:<selector>` |
| Blank `RELEASE_SELECTOR` plus `UPSTREAM_REF`        | `source: branch:<ref>`       |
| `BASE_BRANCH`                                       | `baseBranch`                 |
| `SYNC_BRANCH`                                       | `syncBranch`                 |
| `PATCH_REFS`                                        | `patchRefs`                  |
| Promotion workflow's `workflow_run.workflows` value | `ciWorkflow`                 |

For example:

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

Do not infer the source from the checked-out branch or a version file. Preserve the source behavior already configured in the workflow unless you intentionally want to change it.

### 2. Update `patch/sync`

Add `.patchlane.yml` to the existing `patch/sync` branch. Adapt the new generated sync and promotion workflows while preserving:

- existing branch names and patch order
- the exact existing CI workflow name
- repository-specific schedules and workflow conventions
- any intentional workflow-dispatch inputs

Avoid `patchlane init --force` for migration unless replacing the existing workflows is intentional. Incremental edits are easier to review and preserve local customization.

Commit and push the updated `patch/sync` branch.

### 3. Validate before rollout

From `patch/sync`, run:

```bash
npx patchlane@0.4 doctor
npx patchlane@0.4 sync --dry-run
```

`doctor` should resolve the same upstream source and patch order as the legacy workflow. Review every warning before publishing.

### 4. Roll the config onto the generated base

If the existing sync and promotion workflows are already active on the generated base, trigger the existing sync workflow. Its legacy environment variables remain compatible with Patchlane 0.4, and the resulting tested promotion will place `.patchlane.yml` and the updated workflows on the base branch.

If the promotion workflow is not yet present on the base branch, use the explicit bootstrap flow instead:

```bash
npx patchlane@0.4 bootstrap
npx patchlane@0.4 bootstrap --wait
```

After promotion, confirm that scheduled syncs load their defaults from `.patchlane.yml`. Legacy environment variables may remain temporarily as per-run overrides, but remove duplicated committed values once the config-backed workflow is active.
