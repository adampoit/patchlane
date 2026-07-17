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

Prefer to configure it yourself? Follow the [manual setup guide](docs/manual-setup.md). Already using an earlier Patchlane workflow? Use the [0.4 migration guide](docs/migrating-to-0.4.md).

## How It Works

1. Resolve an explicit source such as `release:latest` or `branch:main`.
2. Rebuild `sync/integration` from that source.
3. Replay independently based patch branches in order.
4. Run the fork's existing CI on the generated branch.
5. Promote only the exact SHA that passed CI.

The promoted base and sync branches are generated output. Fork-owned changes belong on `patch/*` branches.

## Documentation

- [Manual setup](docs/manual-setup.md)
- [Migrating to Patchlane 0.4](docs/migrating-to-0.4.md)
- [Configuration and command reference](docs/configuration.md)

## Development

```bash
npm install
npm test
```

## License

MIT
