#!/usr/bin/env node
import cac from "cac";
import { runIntegrationSync } from "./integration-sync.js";
import { runPromoteSync } from "./promote-sync.js";

const cli = cac("patchlane");

function env(name: string, fallback?: string) {
  return process.env[name] || fallback;
}

cli
  .command("sync", "Rebuild integration branch from upstream and patches")
  .option(
    "--upstream-owner <owner>",
    "GitHub owner/org of the upstream repository",
    {
      default: env("UPSTREAM_OWNER"),
    },
  )
  .option("--upstream-repo <repo>", "Upstream repository name", {
    default: env("UPSTREAM_REPO"),
  })
  .option("--patch-refs <refs>", "Comma- or newline-delimited patch branches", {
    default: env("PATCH_REFS"),
  })
  .option("--base-branch <branch>", "Fork branch promoted later", {
    default: env("BASE_BRANCH", "main"),
  })
  .option("--upstream-ref <ref>", "Upstream branch when not using releases", {
    default: env("UPSTREAM_REF"),
  })
  .option(
    "--release-selector <selector>",
    "latest, prerelease, regex, or blank",
    {
      default: env("RELEASE_SELECTOR"),
    },
  )
  .option("--sync-branch <branch>", "Published generated branch name", {
    default: env("SYNC_BRANCH", "sync/integration"),
  })
  .option("--dry-run", "Test patches without pushing", {
    default: env("DRY_RUN") === "true",
  })
  .option("--origin-remote-name <name>", "Name of the origin remote", {
    default: env("ORIGIN_REMOTE_NAME", "origin"),
  })
  .option("--upstream-remote-name <name>", "Name of the upstream remote", {
    default: env("UPSTREAM_REMOTE_NAME", "upstream"),
  })
  .option("--upstream-remote-url <url>", "URL of the upstream remote", {
    default: env("UPSTREAM_REMOTE_URL"),
  })
  .action((args) => {
    if (!args.upstreamOwner) {
      cli.outputHelp();
      process.stderr.write("Error: --upstream-owner is required\n");
      process.exit(1);
    }
    if (!args.upstreamRepo) {
      cli.outputHelp();
      process.stderr.write("Error: --upstream-repo is required\n");
      process.exit(1);
    }
    if (!args.patchRefs) {
      cli.outputHelp();
      process.stderr.write("Error: --patch-refs is required\n");
      process.exit(1);
    }

    runIntegrationSync({
      upstreamOwner: args.upstreamOwner,
      upstreamRepo: args.upstreamRepo,
      patchRefs: args.patchRefs,
      baseBranch: args.baseBranch,
      upstreamRef: args.upstreamRef,
      releaseSelector: args.releaseSelector,
      syncBranch: args.syncBranch,
      dryRun: args.dryRun,
      originRemoteName: args.originRemoteName,
      upstreamRemoteName: args.upstreamRemoteName,
      upstreamRemoteUrl: args.upstreamRemoteUrl,
    });
  });

cli
  .command("promote", "Promote tested sync branch onto base branch")
  .option("--expected-sync-sha <sha>", "Tested commit SHA", {
    default: env("EXPECTED_SYNC_SHA"),
  })
  .option("--base-branch <branch>", "Fork branch to promote to", {
    default: env("BASE_BRANCH", "main"),
  })
  .option("--sync-branch <branch>", "Generated sync branch that passed CI", {
    default: env("SYNC_BRANCH", "sync/integration"),
  })
  .option("--origin-remote-name <name>", "Name of the origin remote", {
    default: env("ORIGIN_REMOTE_NAME", "origin"),
  })
  .action((args) => {
    if (!args.expectedSyncSha) {
      cli.outputHelp();
      process.stderr.write("Error: --expected-sync-sha is required\n");
      process.exit(1);
    }

    runPromoteSync({
      expectedSyncSha: args.expectedSyncSha,
      baseBranch: args.baseBranch,
      syncBranch: args.syncBranch,
      originRemoteName: args.originRemoteName,
    });
  });

cli.help();
cli.parse();
