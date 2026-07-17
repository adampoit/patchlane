# Migrating to Patchlane 0.4

Existing Patchlane forks can migrate without rebuilding their patch strategy or interrupting scheduled syncs. Legacy workflow environment variables remain supported, so migration can be rolled out through the existing sync and promotion flow.

## 1. Translate the existing workflow configuration

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

## 2. Update `patch/sync`

Add `.patchlane.yml` to the existing `patch/sync` branch. Adapt the new generated sync and promotion workflows while preserving:

- existing branch names and patch order
- the exact existing CI workflow name
- repository-specific schedules and workflow conventions
- any intentional workflow-dispatch inputs

Avoid `patchlane init --force` for migration unless replacing the existing workflows is intentional. Incremental edits are easier to review and preserve local customization.

Commit and push the updated `patch/sync` branch.

## 3. Validate before rollout

From `patch/sync`, run:

```bash
npx patchlane@0.4.0 doctor
npx patchlane@0.4.0 sync --dry-run
```

`doctor` should resolve the same upstream source and patch order as the legacy workflow. Review every warning before publishing.

## 4. Roll the config onto the generated base

If the existing sync and promotion workflows are already active on the generated base, trigger the existing sync workflow. Its legacy environment variables remain compatible with Patchlane 0.4, and the resulting tested promotion will place `.patchlane.yml` and the updated workflows on the base branch.

If the promotion workflow is not yet present on the base branch, use the explicit bootstrap flow instead:

```bash
npx patchlane@0.4.0 bootstrap
npx patchlane@0.4.0 bootstrap --wait
```

After promotion, confirm that scheduled syncs load their defaults from `.patchlane.yml`. Legacy environment variables may remain temporarily as per-run overrides, but remove duplicated committed values once the config-backed workflow is active.
