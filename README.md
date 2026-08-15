# Patchlane

**Keep a customized fork current without merge commits or untested promotions.**

Patchlane rebuilds an integration branch from an upstream release or branch, reapplies focused patch branches, runs your existing CI, and promotes the exact tested commit.

## Quick Start

From a clone of your GitHub fork, install the Patchlane agent skills:

```bash
npx patchlane agents
```

Then ask your coding agent:

> Set up this fork with Patchlane.

The setup skill inspects the repository, asks which upstream release or branch to track, and shows its complete plan before pushing or rewriting branches. It then creates the patch stack, validates it, and guides the first tested promotion.

For agent development after setup, create a complete composed workspace instead of editing a raw lane:

```bash
npx patchlane workspace create --lane patch/product
# work and test in the printed directory
npx patchlane workspace status --json
npx patchlane workspace land --dry-run
```

Prefer to configure it yourself? Follow the [manual setup guide](docs/manual-setup.md). Already using an earlier Patchlane version? Use the [migration guide](docs/migrations.md).

## How It Works

1. Resolve an explicit source such as `release:latest` or `branch:main`.
2. Rebuild `sync/integration` from that source.
3. Replay independently based patch branches in order.
4. Run the fork's existing CI on the generated branch.
5. Promote only the exact SHA that passed CI.

The promoted base and sync branches are generated output. Fork-owned changes belong on `patch/*` branches. For agent development, use a composed workspace so every lane, workflow, test, and local tool is visible while commits remain assignable to one lane.

## Documentation

- [Manual setup](docs/manual-setup.md)
- [Migration guide](docs/migrations.md)
- [Configuration and command reference](docs/configuration.md)
- [Composed workspaces](docs/workspaces.md)

## Development

```bash
nix develop
npm ci
npm test
```

The development shell provides Node.js, GitHub CLI, Git, and Jujutsu.

Model-backed skill evals are opt-in; see [evals/README.md](evals/README.md).

## License

MIT
