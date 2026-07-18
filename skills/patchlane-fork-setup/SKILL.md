---
name: patchlane-fork-setup
description: Set up or migrate a GitHub fork to use Patchlane upstream sync automation. Use when a repository is adopting Patchlane, upgrading legacy workflow configuration, choosing an upstream source, creating patch branches, adding workflows, or bootstrapping the first tested sync.
---

# Patchlane Fork Setup

Inspect the fork before changing anything. Confirm the default branch, remotes, existing workflows, fork-only commits, and existing `patch/*` branches.

Treat the promoted base branch as generated output. Keep fork-owned product changes, Patchlane configuration, agent skills, and workflows on focused patch branches.

## Confirm the plan

Ask the user which upstream source to track. Do not infer this from version files or from whichever branch is currently checked out.

- `release:latest` for the latest stable GitHub release
- `release:prerelease` for the latest prerelease
- `release:<regex>` for matching release tags
- `branch:<ref>` for an upstream development branch

Resolve and show the source tag or branch and commit SHA. Before pushing or rewriting branches, show the complete plan and get confirmation. Include the source, base branch, sync branch, ordered patch refs, existing CI workflow name, GitHub authentication approach, and any force-pushes required.

## Configure GitHub authentication

Treat working GitHub App authentication as a setup prerequisite. The built-in `GITHUB_TOKEN` is not sufficient: GitHub suppresses most workflow events caused by it, so its pushes do not reliably start integration CI or the promotion chain.

1. Inspect existing workflows and repository secret/variable names for an established GitHub App pattern. Ask whether the user wants to reuse that App or create one; do not silently select an identity.
2. Require the App installation to grant Contents read/write and Workflows write. Require Issues read/write only when GitHub issue notifications are enabled. Actions write is not required.
3. Use the standard repository variable `PATCHLANE_APP_CLIENT_ID` and repository secret `PATCHLANE_APP_PRIVATE_KEY`. An existing App identity can be reused through these names even when other workflows wrap it in a custom action.
4. App creation, permission approval, installation, and private-key generation require the user. Never ask them to paste a private key into chat or print it. After explicit approval, the agent may configure a variable and secret from a local key file with `gh variable set` and `gh secret set`.
5. Check deterministically where possible:
    - `gh auth status`
    - `gh api repos/OWNER/REPO/actions/permissions`
    - `gh variable get PATCHLANE_APP_CLIENT_ID --repo OWNER/REPO`
    - `gh secret list --repo OWNER/REPO --json name,updatedAt`
6. Explain that secret metadata proves only that a secret exists. The generated `actions/create-github-app-token` step verifies the installation and requested permissions at runtime.

Include all external repository changes in the plan and obtain confirmation before setting variables, secrets, or dispatching workflows.

## Configure the fork

1. Default the generated base to `main` and the integration branch to `sync/integration` unless the repository uses different conventions.
2. Create each patch branch independently from the resolved upstream source. Never create `patch/sync` from `patch/product`, or another patch branch, unless that dependency is intentional and explicitly allowed.
3. Prefer the order `patch/sync`, `patch/ci`, then product-specific patches. Foundational changes must precede patches that depend on them.
4. Put `.patchlane.yml`, Patchlane workflows, and installed `.agents/skills` on `patch/sync`.
5. Put only the existing CI trigger adjustment on `patch/ci`. Preserve the existing workflow's `name`; configure `ciWorkflow` and the promotion workflow to reference that exact name. Add the CI filename and every other intentionally retained repository workflow to `allowedWorkflows`; Patchlane adds its generated sync and promotion workflows implicitly.
6. Use `npx patchlane init` to generate `.patchlane.yml` and pinned workflow files when practical, then adapt rather than replace existing repository conventions. Preserve the generated GitHub App token creation, explicit permission requests, authenticated checkout, and `GH_TOKEN` wiring.
7. Ensure fork CI covers normal pull requests plus pushes to both the generated base and sync branches.

Use the bundled assets as invariants when adapting workflows:

- `assets/sync-upstream.yml` exposes safe workflow-dispatch overrides and runs sync with write permission.
- `assets/fork-ci.yml` demonstrates the required branch triggers.
- `assets/promote-tested-sync.yml` promotes only a successful sync-branch `workflow_run` and passes its exact `head_sha`.

## Migrate an existing Patchlane fork

Before planning an upgrade, fetch and read the current migration guide from:

`https://raw.githubusercontent.com/adampoit/patchlane/main/docs/migrations.md`

Use the section for the target version, including `vNext` for an unreleased upgrade. Fetch this file dynamically instead of relying on migration details bundled with the installed skill.

If Patchlane workflows or patch branches already exist, migrate incrementally instead of treating the repository as a new installation.

1. Preserve the configured source behavior, branch names, patch order, CI workflow name, schedule, and repository-specific workflow changes unless the user approves changing them.
2. Follow the fetched guide to update `.patchlane.yml` and inventory the intended composed workflow set.
3. Add the config and adapted workflows to the existing `patch/sync` branch. Do not use `patchlane init --force` unless replacing those workflows is intentional.
4. Run `doctor` and `sync --dry-run`, then show the migration plan before pushing rewritten patch branches.
5. Roll the migration forward through the tested sync flow described by the fetched guide.

## Validate and bootstrap

Run `npx patchlane doctor` after creating and pushing the patch branches. Fix all errors and review warnings.

Use `npx patchlane sync --dry-run` for local validation. Do not use local `--no-push` as a substitute: no-push creates or resets the local sync branch, while dry-run leaves the working tree alone.

The workflows do not exist on the default branch before the first promotion. Bootstrap explicitly:

1. Run `npx patchlane bootstrap` to validate without publishing.
2. After user approval, run `npx patchlane bootstrap --publish` and wait for the configured CI workflow.
3. Promote the exact successful SHA printed by bootstrap, or use `npx patchlane bootstrap --wait` to wait and promote automatically.
4. Confirm the generated base is rooted at the selected source.
5. After the workflows are present on the base branch, obtain approval and run `npx patchlane verify-auth`. This dispatches a no-push sync and waits for it, validating the uploaded App key, installation, permissions, API access, checkout, and rebuild without changing branches.
6. On the first App-authenticated published sync, confirm CI ran as a `push` for the exact integration SHA and promotion moved the base branch to that SHA.

After bootstrap, a remote no-push test can be dispatched safely from the default branch.

## Finish

Summarize:

- selected source and resolved tag/branch SHA
- base and sync branches
- ordered patch refs and their bases
- files and workflows added or updated
- doctor and dry-run results
- bootstrap CI and promotion results
- GitHub App metadata and post-bootstrap authentication verification results
