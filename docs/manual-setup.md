# Manual Setup

This walkthrough configures an existing GitHub fork. You need Node.js 22+, `git`, and an authenticated `gh` CLI.

Already using an earlier Patchlane version? Follow the [migration guide](migrations.md) instead.

## 1. Choose the upstream source

Add the upstream remote if needed:

```bash
git remote add upstream https://github.com/UPSTREAM_OWNER/UPSTREAM_REPO.git
```

For the latest stable release:

```bash
UPSTREAM=UPSTREAM_OWNER/UPSTREAM_REPO
SOURCE=release:latest
SOURCE_REF=$(gh release view --repo "$UPSTREAM" --json tagName --jq .tagName)
git fetch upstream --tags
```

To track a branch instead:

```bash
UPSTREAM=UPSTREAM_OWNER/UPSTREAM_REPO
SOURCE=branch:main
SOURCE_REF=upstream/main
git fetch upstream main
```

Keep `SOURCE_REF` unchanged for the remaining steps. Every patch branch must start independently from this commit.

## 2. Create the Patchlane patch

Find the exact `name:` of the existing CI workflow, then create `patch/sync`:

```bash
git switch -c patch/sync "$SOURCE_REF"

npx patchlane init \
  --upstream="$UPSTREAM" \
  --source="$SOURCE" \
  --patch-refs="patch/sync,patch/ci" \
  --ci-workflow="CI"

git add .patchlane.yml .github/workflows
git commit -m "Add Patchlane sync automation"
git push -u origin patch/sync
```

Replace `CI` with the existing workflow's exact name. Do not rename the workflow just for Patchlane.

## 3. Make CI test generated syncs

Create `patch/ci` from the same source—not from `patch/sync`:

```bash
git switch -c patch/ci "$SOURCE_REF"
```

Update the existing CI workflow so its push branches include both generated branches:

```yaml
on:
    pull_request:
    push:
        branches:
            - main
            - sync/integration
```

Commit and push only that CI adjustment:

```bash
git add .github/workflows
git commit -m "Run fork CI on Patchlane syncs"
git push -u origin patch/ci
```

## 4. Validate

Return to the branch containing `.patchlane.yml`:

```bash
git switch patch/sync
npx patchlane doctor
npx patchlane sync --dry-run
```

`doctor` should have no errors. A bootstrap warning is expected because the workflows are not on the generated base branch yet.

## 5. Bootstrap the first promotion

Validate once more without publishing:

```bash
npx patchlane bootstrap
```

Then publish, wait for CI, and promote the exact successful SHA:

```bash
npx patchlane bootstrap --wait
```

After this succeeds, scheduled syncs and automatic promotions are active.

## Adding product patches

Create each additional patch independently from the same selected source:

```bash
git switch -c patch/product "$SOURCE_REF"
# Make and commit the fork-owned product changes.
git push -u origin patch/product
```

Add it to `patchRefs` in `.patchlane.yml`, usually after `patch/sync` and `patch/ci`, then update `patch/sync` and run `doctor` plus `sync --dry-run` again.
