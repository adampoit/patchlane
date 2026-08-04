---
name: patchlane-workspace
description: Develop Patchlane fork changes in a complete composed workspace, then project linear commits onto one selected patch lane with exact round-trip validation.
---

# Patchlane Composed Workspace

When making a change to a Patchlane fork:

1. Do not edit a raw patch branch unless the user explicitly requests it.
2. From a configured branch, run `patchlane workspace create --lane <lane>`.
3. Work only in the generated workspace.
4. Inspect existing code across all composed lanes before changing behavior.
5. Keep the workspace history linear; do not create merge commits.
6. Commit complete, reviewable changes and run the repository's normal tests.
7. Run `patchlane workspace status --json` before landing.
8. Run `patchlane workspace land --dry-run` and review any conflict or round-trip mismatch.
9. Use an existing configured lane that matches the requested change; do not invent a lane silently.
10. Obtain approval before running `patchlane workspace land --push`.

A workspace includes the complete composed fork: upstream code, every configured patch lane, Patchlane workflows and skills, tests, CI configuration, and development tooling. The selected lane is the only lane that receives commits during landing. Patchlane replays the workspace commits onto that lane, recomposes every lane, and requires the resulting tree to match the tested workspace tree exactly.

## Create

From the repository worktree containing `.patchlane.yml`:

```bash
patchlane workspace create --lane patch/product
```

Use `--config-ref origin/main` when the current branch does not contain `.patchlane.yml`. Use `--path` or `--name` only when a stable custom worktree location or identifier is needed. Change directory to the reported path before editing.

## Land

Before landing:

```bash
patchlane workspace status --json
patchlane workspace land --dry-run
```

Fix dirty files, merge commits, stale lane refs, projection conflicts, and round-trip mismatches rather than bypassing validation. A mismatch commonly means the selected lane is wrong, a later lane overwrites the change, or the workspace contains changes for multiple lanes. Split those changes into separate workspaces when appropriate.

Land locally with:

```bash
patchlane workspace land
```

Remote writes are never implicit. After reviewing the dry run and receiving approval, use:

```bash
patchlane workspace land --push
```

Keep the workspace until the landed lane has been reviewed or upstreamed. Remove it only after confirming there are no unlanded changes:

```bash
patchlane workspace remove
```

Use `workspace remove --force` only when intentionally discarding dirty or unlanded work.
