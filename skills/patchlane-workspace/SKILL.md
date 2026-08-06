---
name: patchlane-workspace
description: Develop Patchlane fork changes in a complete composed workspace, then project linear commits onto one selected patch lane with exact round-trip validation.
---

# Patchlane Composed Workspace

Use three separate authorization boundaries. The user's initial request is not approval to mutate the repository, and approval for one boundary never implies approval for a later one.

## Candidate boundary

1. Inspect the repository and select an existing configured lane that matches the requested change. Do not invent a lane silently.
2. Present a concise plan naming the lane and ask for approval to create, edit, commit, and validate a composed workspace.
3. Before that approval, do not create a workspace, worktree, branch, or commit and do not change files, configured refs, or remotes.
4. After approval, run `patchlane workspace create --lane <lane>` from a configured worktree.
5. Work only in the generated workspace. Do not check out or edit the raw configured lane.
6. Inspect existing code across all composed lanes before changing behavior.
7. Keep history linear, commit complete reviewable changes, and run normal tests.
8. Run `patchlane workspace status --json` and `patchlane workspace land --dry-run`.
9. Fix dirty files, stale lanes, projection conflicts, and round-trip mismatches rather than bypassing validation.
10. Report the candidate commits and validation result. Stop without landing unless the user separately approves local projection.

A workspace includes the complete composed fork: upstream code, every configured patch lane, Patchlane workflows and skills, tests, CI configuration, and development tooling. The selected lane is the only lane that receives commits during landing. Patchlane replays the workspace commits onto that lane, recomposes every lane, and requires the resulting tree to match the tested workspace tree exactly.

## Create

From the repository worktree containing `.patchlane.yml`:

```bash
patchlane workspace create --lane patch/product
```

Use `--config-ref origin/main` when the current branch does not contain `.patchlane.yml`. Use `--path` or `--name` only when a stable custom worktree location or identifier is needed. Change directory to the reported path before editing.

## Local projection boundary

After the dry run, show the target lane and candidate commits and ask for explicit approval to update that local configured lane. Only after this separate approval, land locally with:

```bash
patchlane workspace land
```

Confirm that only the selected local lane changed and that all remote refs remained unchanged.

## Publish boundary

Local projection approval does not authorize publication. Show the exact remote and ref update and obtain another explicit approval before using:

```bash
patchlane workspace land --push
```

Keep the workspace until the landed lane has been reviewed or upstreamed. Removing a workspace is also a mutation: remove it only when requested or included in an approved cleanup plan and after confirming there are no unlanded changes:

```bash
patchlane workspace remove
```

Use `workspace remove --force` only when intentionally discarding dirty or unlanded work.
