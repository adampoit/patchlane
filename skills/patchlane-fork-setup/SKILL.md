---
name: patchlane-fork-setup
description: Set up a GitHub fork to use Patchlane for upstream sync automation. Use when a repository is adopting Patchlane for the first time and the agent needs to verify remotes, choose branch names, create patch branches, add sync and promotion workflows, or guide an initial dry run.
---

# Patchlane Fork Setup

Inspect the fork before changing anything. Confirm the default branch, current remotes, existing workflow files, and whether the repository already keeps fork-owned changes on dedicated `patch/*` branches.

Treat the promoted base branch as generated output. Do not place fork-owned product changes, CI config, or Patchlane workflows directly on the base branch unless the user explicitly wants to break from the normal Patchlane model.

Use the bundled workflow templates in this skill as the default source of truth when adding Patchlane to a fork.

- Read `assets/sync-upstream.yml` before writing the sync workflow. Mirror its `workflow_dispatch` inputs for `dry_run`, `upstream_ref`, `release_selector`, and `patch_refs` unless the fork has a concrete reason to simplify them.
- Read `assets/fork-ci.yml` before wiring CI. Preserve the important trigger shape: normal `pull_request` coverage plus `push` on both the base branch and `sync/integration`.
- Read `assets/promote-tested-sync.yml` before writing promotion logic. Preserve the `workflow_run` trigger on `Fork CI`, the success guard, the `sync/integration` branch check, and `EXPECTED_SYNC_SHA: ${{ github.event.workflow_run.head_sha }}`.
- Treat the example files as templates to adapt, not just loose inspiration. If the fork already has workflows, update them toward the same invariants instead of copying blindly.

Use this workflow:

1. Identify the upstream repository owner, repository name, and the upstream source that should drive syncs.
2. Confirm the fork branch that should receive promoted updates. Default to `main` unless the repository already uses a different base branch.
3. Choose or confirm a sync branch. Default to `sync/integration` unless the repo already has a convention.
4. Group fork-owned changes into focused patch branches. Prefer names like `patch/product`, `patch/ci`, and `patch/sync` instead of one large branch.
5. Ensure the patch branch order is intentional. Foundational workflow or build changes should usually come before product-specific patches.
6. Add or update the sync workflow so it runs `npx patchlane@latest sync` with `UPSTREAM_OWNER`, `UPSTREAM_REPO`, `BASE_BRANCH`, `SYNC_BRANCH`, and ordered `PATCH_REFS`.
7. Add or update fork CI so it runs on pushes to the sync branch as well as normal review events.
8. Add or update the promotion workflow so a successful sync-branch CI run triggers `npx patchlane@latest promote` with `EXPECTED_SYNC_SHA` set from the workflow run payload.
9. Recommend or run an initial dry run before enabling unattended automation.

Bundled template mapping:

- Sync workflow template: `assets/sync-upstream.yml`
- Fork CI template: `assets/fork-ci.yml`
- Promotion workflow template: `assets/promote-tested-sync.yml`
- Typical env block in sync: `UPSTREAM_OWNER`, `UPSTREAM_REPO`, `BASE_BRANCH`, `UPSTREAM_REF`, `RELEASE_SELECTOR`, `SYNC_BRANCH`, `PATCH_REFS`, `DRY_RUN`
- Typical env block in promote: `BASE_BRANCH`, `SYNC_BRANCH`, `EXPECTED_SYNC_SHA`

Apply these checks while working:

- Keep workflow files on patch branches, not on the generated base branch.
- Preserve the repository's existing naming and workflow style when it already has conventions.
- If the repo already has similar automation, update it incrementally instead of replacing everything.
- If the fork has direct commits on the generated base branch, call that out as migration risk before moving Patchlane in.

When editing workflow config, make sure the final setup still expresses these invariants:

- `sync` can rebuild from upstream plus ordered patch branches.
- fork CI runs on the sync branch.
- `promote` only advances the base branch from the tested sync commit.

Finish by summarizing:

- the chosen base branch and sync branch
- the ordered patch branch list
- which workflow files were added or updated
- how to trigger the first dry run
