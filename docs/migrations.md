# Patchlane Migration Guide

Follow the section for the version you are adopting. Migration notes are listed newest first.

## vNext

vNext requires every version-1 `.patchlane.yml` file to define `allowedWorkflows`. Patchlane implicitly includes its generated `sync-upstream.yml` and `promote-tested-sync.yml` workflows, so list only repository-specific workflows.

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

### 3. Validate before rollout

After pushing the updated patch refs, validate with the vNext package version selected for the migration:

```bash
npx patchlane@VERSION doctor
npx patchlane@VERSION sync --dry-run
```

Doctor should identify every unexpected or missing workflow by filename. The dry run validates the actual output after all configured patches are replayed without changing the local or remote sync branch.

### 4. Roll out through a tested promotion

Update the pinned Patchlane version in the sync and promotion workflows as part of the same configuration patch. From that patch branch, use the new client for the first policy-enforced rebuild and promotion:

```bash
npx patchlane@VERSION bootstrap --wait
```

This validates the allowlist before publishing `sync/integration`, waits for CI on the exact published SHA, revalidates that SHA, and then promotes it. Confirm afterward that the generated base contains the intended workflow set and that scheduled syncs use the new Patchlane version.

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
npx patchlane@0.4.0 doctor
npx patchlane@0.4.0 sync --dry-run
```

`doctor` should resolve the same upstream source and patch order as the legacy workflow. Review every warning before publishing.

### 4. Roll the config onto the generated base

If the existing sync and promotion workflows are already active on the generated base, trigger the existing sync workflow. Its legacy environment variables remain compatible with Patchlane 0.4, and the resulting tested promotion will place `.patchlane.yml` and the updated workflows on the base branch.

If the promotion workflow is not yet present on the base branch, use the explicit bootstrap flow instead:

```bash
npx patchlane@0.4.0 bootstrap
npx patchlane@0.4.0 bootstrap --wait
```

After promotion, confirm that scheduled syncs load their defaults from `.patchlane.yml`. Legacy environment variables may remain temporarily as per-run overrides, but remove duplicated committed values once the config-backed workflow is active.
