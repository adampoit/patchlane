# Composed workspaces

Patchlane workspaces provide the complete composed fork while keeping commits assigned to one configured patch lane.

## Create a workspace

From a configured repository worktree:

```bash
npx patchlane workspace create --lane patch/product
```

Patchlane resolves the configured upstream source, fetches and pins every lane, composes them in order, and creates a disposable Git worktree at the generated path. Use `--path` or `--name` to override the destination, and `--config-ref origin/main` when the current branch does not contain `.patchlane.yml`.

The workspace records its inputs under the repository's common Git directory in `patchlane/workspaces/<id>.json`. This metadata is local state and is never committed to a lane.

## Work and inspect

Change to the path printed by `workspace create`, edit normally, commit linearly, and run the repository's normal tests. Inspect the state before editing and before landing:

```bash
npx patchlane workspace status --json
```

All configured lane refs must remain unchanged while the workspace is being developed. A workspace becomes stale when any lane moves; Patchlane does not automatically refresh or rebase it.

## Validate and land

Preview projection and exact recomposition without moving a lane:

```bash
npx patchlane workspace land --dry-run
```

For a successful preview, land locally:

```bash
npx patchlane workspace land
```

Use `--push` only when a remote write is explicitly approved:

```bash
npx patchlane workspace land --push
```

Landing replays the workspace commits onto exactly one target lane, recomposes all lanes using the recorded SHAs, and compares the composed tree with the tested workspace tree. It updates no lane when projection conflicts or the tree comparison fails. Remote pushes use `--force-with-lease` and are never performed by default.

A round-trip mismatch is intentionally diagnostic. Check whether the selected lane is wrong, a later lane overwrites the change, or the workspace contains work for more than one lane. Use separate workspaces for multi-lane changes.

## Remove

A workspace with dirty files or unlanded commits cannot be removed accidentally:

```bash
npx patchlane workspace remove
```

Use `--force` only when deliberately discarding that work. Removal deletes the registered worktree, disposable workspace branch, candidate refs, and local metadata. It does not change configured lane refs.

## Deferred capabilities

Patchlane 0.5.3 supports one target lane and linear history. Multi-lane commit assignment, lane dependency graphs, workspace refresh, ownership policies, automatic lane creation, and synthetic octopus commits remain future work.
