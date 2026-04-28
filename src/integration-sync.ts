import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type RunOptions = {
  cwd?: string;
  allowFailure?: boolean;
  encoding?: BufferEncoding | "buffer";
  env?: NodeJS.ProcessEnv;
};

const cwd = process.cwd();

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function log(message: string) {
  process.stdout.write(`${message}\n`);
}

function getEnv(name: string, fallback = "") {
  return process.env[name] ?? fallback;
}

function requireEnv(name: string) {
  const value = getEnv(name);
  if (!value) fail(`Required environment variable '${name}' is not set.`);
  return value;
}

function isTrue(value: string) {
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

function trim(value: string) {
  return value.trim();
}

function parsePatchRefs(value: string) {
  return value
    .split(/\r?\n|,/)
    .map(trim)
    .filter(Boolean);
}

function run(command: string, args: string[], options: RunOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? cwd,
    env: options.env ?? process.env,
    encoding: options.encoding ?? "utf8",
  });

  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const stderr =
      typeof result.stderr === "string"
        ? result.stderr.trim()
        : result.stderr.toString("utf8").trim();
    const stdout =
      typeof result.stdout === "string"
        ? result.stdout.trim()
        : result.stdout.toString("utf8").trim();
    fail(
      [stderr, stdout].filter(Boolean).join("\n") ||
        `${command} exited with status ${result.status ?? 1}`,
    );
  }

  return result;
}

function runText(command: string, args: string[], options: RunOptions = {}) {
  const result = run(command, args, { ...options, encoding: "utf8" });
  return {
    status: result.status ?? 0,
    stdout: result.stdout as string,
    stderr: result.stderr as string,
  };
}

function runBuffer(command: string, args: string[], options: RunOptions = {}) {
  const result = run(command, args, { ...options, encoding: "buffer" });
  return {
    status: result.status ?? 0,
    stdout: result.stdout as Buffer,
    stderr: result.stderr as Buffer,
  };
}

function git(args: string[], options: RunOptions = {}) {
  return runText("git", args, options);
}

function gh(args: string[], options: RunOptions = {}) {
  return runText("gh", args, options);
}

function writeOutput(key: string, value: string) {
  const file = getEnv("GITHUB_OUTPUT");
  if (!file) return;
  if (!value.includes("\n")) {
    appendFileSync(file, `${key}=${value}\n`);
    return;
  }

  const marker = `EOF_${Math.random().toString(16).slice(2)}`;
  appendFileSync(file, `${key}<<${marker}\n${value}\n${marker}\n`);
}

function writeSummary(title: string, body: string, section = "") {
  const file = getEnv("GITHUB_STEP_SUMMARY");
  if (!file) return;
  appendFileSync(file, `${title}\n\n`);
  if (body) appendFileSync(file, `${body}\n\n`);
  if (section) appendFileSync(file, `${section}\n`);
}

function bulletList(items: string[]) {
  return items
    .filter(Boolean)
    .map((item) => `- \`${item}\``)
    .join("\n");
}

function parseJson<T>(value: string) {
  return JSON.parse(value) as T;
}

function resolveRelease(
  upstreamOwner: string,
  upstreamRepo: string,
  releaseSelector: string,
) {
  const pathName = `repos/${upstreamOwner}/${upstreamRepo}`;
  process.stderr.write(
    `Resolving upstream release with selector '${releaseSelector}'\n`,
  );

  if (releaseSelector === "latest") {
    return parseJson<{ tag_name: string; html_url?: string }>(
      gh(["api", `${pathName}/releases/latest`]).stdout,
    );
  }

  const releases = parseJson<
    Array<{
      tag_name: string;
      html_url?: string;
      prerelease?: boolean;
      draft?: boolean;
    }>
  >(gh(["api", "--paginate", `${pathName}/releases?per_page=100`]).stdout);

  const match =
    releaseSelector === "prerelease"
      ? releases.find((release) => !release.draft && !!release.prerelease)
      : releases.find(
          (release) =>
            !release.draft &&
            new RegExp(releaseSelector).test(release.tag_name),
        );

  if (!match)
    fail(`No upstream release matched selector '${releaseSelector}'.`);
  return match;
}

function resolvePatchRef(ref: string, originRemoteName: string) {
  if (
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowFailure: true,
    }).status === 0
  )
    return ref;

  const fetched = git(
    [
      "fetch",
      "--no-tags",
      originRemoteName,
      `+refs/heads/${ref}:refs/remotes/${originRemoteName}/${ref}`,
    ],
    { allowFailure: true },
  );
  if (fetched.status === 0) return `refs/remotes/${originRemoteName}/${ref}`;
  return "";
}

function parseConflictPaths(output: string) {
  return Array.from(
    new Set(
      output
        .split("\n")
        .flatMap((line) => {
          const applied = line.match(
            /^Applied patch to '(.+)' with conflicts\.$/,
          );
          if (applied) return [applied[1]];
          const merge = line.match(/^CONFLICT \(.+\): Merge conflict in (.+)$/);
          if (merge) return [merge[1]];
          const missing = line.match(/^error: (.+): does not exist in index$/);
          if (missing) return [missing[1]];
          return [];
        })
        .filter(Boolean),
    ),
  );
}

function tmpFile(name: string) {
  return path.join(mkdtempSync(path.join(tmpdir(), `${name}-`)), "payload");
}

function configureGitIdentity() {
  const name = git(["config", "user.name"], {
    allowFailure: true,
  }).stdout.trim();
  const email = git(["config", "user.email"], {
    allowFailure: true,
  }).stdout.trim();
  if (!name) {
    git(["config", "user.name", "github-actions[bot]"]);
  }
  if (!email) {
    git([
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ]);
  }
}

export type IntegrationSyncOptions = {
  upstreamOwner: string;
  upstreamRepo: string;
  patchRefs: string;
  baseBranch?: string;
  upstreamRef?: string;
  releaseSelector?: string;
  syncBranch?: string;
  dryRun?: boolean;
  originRemoteName?: string;
  upstreamRemoteName?: string;
  upstreamRemoteUrl?: string;
};

export function runIntegrationSync(options: IntegrationSyncOptions) {
  configureGitIdentity();

  const upstreamOwner = options.upstreamOwner;
  const upstreamRepo = options.upstreamRepo;
  const patchRefsRaw = options.patchRefs;

  const baseBranch = options.baseBranch ?? "main";
  const upstreamRef = options.upstreamRef ?? baseBranch;
  const releaseSelector = options.releaseSelector ?? "";
  const syncBranch = options.syncBranch ?? "sync/integration";
  const dryRun = options.dryRun ?? false;
  const originRemoteName = options.originRemoteName ?? "origin";
  const upstreamRemoteName = options.upstreamRemoteName ?? "upstream";
  const upstreamRemoteUrl =
    options.upstreamRemoteUrl ??
    `https://github.com/${upstreamOwner}/${upstreamRepo}.git`;

  const existingUpstream = git(["remote", "get-url", upstreamRemoteName], {
    allowFailure: true,
  });
  if (existingUpstream.status === 0) {
    git(["remote", "set-url", upstreamRemoteName, upstreamRemoteUrl]);
  } else {
    git(["remote", "add", upstreamRemoteName, upstreamRemoteUrl]);
  }

  git([
    "fetch",
    "--no-tags",
    originRemoteName,
    `+refs/heads/${baseBranch}:refs/remotes/${originRemoteName}/${baseBranch}`,
  ]);
  git(
    [
      "fetch",
      "--no-tags",
      originRemoteName,
      `+refs/heads/${syncBranch}:refs/remotes/${originRemoteName}/${syncBranch}`,
    ],
    { allowFailure: true },
  );
  git([
    "fetch",
    "--no-tags",
    upstreamRemoteName,
    `+refs/heads/*:refs/remotes/${upstreamRemoteName}/*`,
  ]);
  if (releaseSelector)
    git([
      "fetch",
      upstreamRemoteName,
      "--force",
      "--tags",
      "+refs/tags/*:refs/tags/*",
    ]);

  let upstreamBase = `refs/remotes/${upstreamRemoteName}/${upstreamRef}`;
  let sourceLabel = `${upstreamRemoteName}/${upstreamRef}`;
  if (releaseSelector) {
    const release = resolveRelease(
      upstreamOwner,
      upstreamRepo,
      releaseSelector,
    );
    if (!release.tag_name) fail("Failed to resolve an upstream release tag.");
    const tagCommit = git([
      "rev-list",
      "-n",
      "1",
      `refs/tags/${release.tag_name}^{commit}`,
    ]).stdout.trim();
    if (!tagCommit)
      fail(
        `Tag '${release.tag_name}' was not fetched from the upstream remote.`,
      );
    upstreamBase = tagCommit;
    sourceLabel = `release ${release.tag_name}`;
  } else if (
    git(["rev-parse", "--verify", "--quiet", upstreamBase], {
      allowFailure: true,
    }).status !== 0
  ) {
    fail(
      `Upstream ref '${upstreamRef}' was not fetched from ${upstreamRemoteName}.`,
    );
  }

  const patchRefs = parsePatchRefs(patchRefsRaw);
  if (!patchRefs.length)
    fail("PATCH_REFS did not contain any patch branch names.");

  log(`Building ${syncBranch} from ${sourceLabel}`);
  git(["checkout", "-B", syncBranch, upstreamBase]);

  const appliedRefs: string[] = [];

  for (const ref of patchRefs) {
    const resolved = resolvePatchRef(ref, originRemoteName);
    if (!resolved) {
      const body = [
        `- Base: \`${upstreamBase}\``,
        `- Source: \`${sourceLabel}\``,
        `- Failed bookmark: \`${ref}\``,
        `- Reason: patch ref could not be resolved locally or from \`${originRemoteName}\`.`,
      ].join("\n");
      writeOutput("failed_bookmark", ref);
      writeOutput("failed_commit", "");
      writeOutput("conflicted_paths", "");
      writeOutput("applied_refs", appliedRefs.join("\n"));
      writeOutput("sync_branch", syncBranch);
      writeOutput("status", "missing_patch");
      writeSummary("## Integration rebuild failed", body);
      fail(
        `Patch ref '${ref}' could not be resolved locally or from ${originRemoteName}.`,
      );
    }

    const failedCommit = git([
      "rev-parse",
      `${resolved}^{commit}`,
    ]).stdout.trim();

    const isAncestor =
      git(["merge-base", "--is-ancestor", upstreamBase, resolved], {
        allowFailure: true,
      }).status === 0;

    let diffBase = upstreamBase;

    if (!isAncestor) {
      const mergeBase = git(["merge-base", upstreamBase, resolved])
        .stdout.trim();
      const uniqueCommits = git([
        "rev-list",
        "--ancestry-path",
        `${mergeBase}..${resolved}`,
      ]).stdout.trim();

      if (uniqueCommits) {
        const commits = uniqueCommits.split("\n").filter(Boolean);
        const oldestUnique = commits[commits.length - 1]!;
        const tags = git(["tag", "--points-at", oldestUnique], {
          allowFailure: true,
        }).stdout.trim();

        if (tags) {
          // oldestUnique is tagged (likely a release the patch was based on)
          diffBase = oldestUnique;
        } else {
          const parent = git(["rev-parse", `${oldestUnique}^`], {
            allowFailure: true,
          }).stdout.trim();
          if (parent) diffBase = parent;
        }

        log(
          `Patch ${ref} is not based on ${sourceLabel}; using ${diffBase.slice(0, 7)} as patch base`,
        );
      }
    }

    const diff = runBuffer("git", [
      "diff",
      "--binary",
      `${diffBase}...${resolved}`,
    ]);
    if (!diff.stdout.length) {
      log(`Skipping ${ref}; no net diff against ${sourceLabel}.`);
      continue;
    }

    const patchFile = tmpFile("patchlane");
    writeFileSync(patchFile, diff.stdout);

    log(`Applying ${ref}`);
    const apply = git(["apply", "--3way", "--index", patchFile], {
      allowFailure: true,
    });
    const output = [apply.stdout, apply.stderr].filter(Boolean).join("\n");
    if (output) process.stdout.write(`${output.trim()}\n`);
    if (apply.status !== 0) {
      const conflictedPaths = parseConflictPaths(output);
      const body = [
        `- Base: \`${upstreamBase}\``,
        `- Source: \`${sourceLabel}\``,
        `- Failed bookmark: \`${ref}\``,
        `- Failed commit: \`${failedCommit}\``,
      ].join("\n");
      const section = conflictedPaths.length
        ? `### Conflicted paths\n\n${bulletList(conflictedPaths)}`
        : "";
      writeOutput("failed_bookmark", ref);
      writeOutput("failed_commit", failedCommit);
      writeOutput("conflicted_paths", conflictedPaths.join("\n"));
      writeOutput("applied_refs", appliedRefs.join("\n"));
      writeOutput("sync_branch", syncBranch);
      writeOutput("status", "conflicted");
      writeSummary("## Integration rebuild failed", body, section);
      fail(`Failed to apply ${ref}.`);
    }

    rmSync(path.dirname(patchFile), { force: true, recursive: true });
    if (
      git(["diff", "--cached", "--quiet"], { allowFailure: true }).status === 0
    ) {
      log(`Skipping ${ref}; patch produced no staged changes.`);
      continue;
    }

    git(["commit", "-m", `apply ${ref}`]);
    appliedRefs.push(ref);
  }

  writeOutput("failed_bookmark", "");
  writeOutput("failed_commit", "");
  writeOutput("conflicted_paths", "");
  writeOutput("applied_refs", appliedRefs.join("\n"));
  writeOutput("sync_branch", syncBranch);
  const rebuiltSyncSha = git(["rev-parse", "HEAD"]).stdout.trim();
  const remoteSyncRef = `refs/remotes/${originRemoteName}/${syncBranch}`;

  if (dryRun) {
    writeOutput("sync_sha", rebuiltSyncSha);
    writeOutput("status", "dry_run");
    writeSummary(
      "## Integration rebuild completed",
      [
        `- Base: \`${upstreamBase}\``,
        `- Source: \`${sourceLabel}\``,
        `- Output branch: \`${syncBranch}\``,
        `- Promotion target: \`${baseBranch}\``,
        "- Mode: dry run",
      ].join("\n"),
      appliedRefs.length
        ? `### Applied patches\n\n${bulletList(appliedRefs)}`
        : "",
    );
    log("Dry run enabled; skipping push and promotion operations.");
    return;
  }

  const remoteSyncExists =
    git(["rev-parse", "--verify", "--quiet", remoteSyncRef], {
      allowFailure: true,
    }).status === 0;
  if (remoteSyncExists) {
    const rebuiltTree = git([
      "rev-parse",
      `${rebuiltSyncSha}^{tree}`,
    ]).stdout.trim();
    const remoteSyncSha = git(["rev-parse", remoteSyncRef]).stdout.trim();
    const remoteSyncTree = git([
      "rev-parse",
      `${remoteSyncRef}^{tree}`,
    ]).stdout.trim();
    if (rebuiltTree === remoteSyncTree) {
      writeOutput("sync_sha", remoteSyncSha);
      writeOutput("status", "unchanged");
      writeSummary(
        "## Integration rebuild unchanged",
        [
          `- Base: \`${upstreamBase}\``,
          `- Source: \`${sourceLabel}\``,
          `- Output branch: \`${syncBranch}\``,
          `- Promotion target: \`${baseBranch}\``,
          `- Published SHA: \`${remoteSyncSha}\``,
          "- Reason: rebuilt branch tree matches the current published sync branch.",
        ].join("\n"),
        appliedRefs.length
          ? `### Applied patches\n\n${bulletList(appliedRefs)}`
          : "",
      );
      log(
        `Skipping push for ${syncBranch}; rebuilt tree matches ${originRemoteName}/${syncBranch}.`,
      );
      return;
    }
  }

  log(`Pushing ${syncBranch} to ${originRemoteName}`);
  git([
    "push",
    "--force-with-lease",
    "--set-upstream",
    originRemoteName,
    syncBranch,
  ]);

  writeOutput("sync_sha", rebuiltSyncSha);
  writeOutput("status", "published");
  writeSummary(
    "## Integration rebuild published",
    [
      `- Base: \`${upstreamBase}\``,
      `- Source: \`${sourceLabel}\``,
      `- Output branch: \`${syncBranch}\``,
      `- Promotion target: \`${baseBranch}\``,
    ].join("\n"),
    appliedRefs.length
      ? `### Applied patches\n\n${bulletList(appliedRefs)}`
      : "",
  );
  log("Integration sync completed with status 'published'");
}

function main() {
  runIntegrationSync({
    upstreamOwner: requireEnv("UPSTREAM_OWNER"),
    upstreamRepo: requireEnv("UPSTREAM_REPO"),
    patchRefs: requireEnv("PATCH_REFS"),
    baseBranch: getEnv("BASE_BRANCH", "main"),
    upstreamRef: getEnv("UPSTREAM_REF"),
    releaseSelector: getEnv("RELEASE_SELECTOR"),
    syncBranch: getEnv("SYNC_BRANCH", "sync/integration"),
    dryRun: isTrue(getEnv("DRY_RUN", "false")),
    originRemoteName: getEnv("ORIGIN_REMOTE_NAME", "origin"),
    upstreamRemoteName: getEnv("UPSTREAM_REMOTE_NAME", "upstream"),
    upstreamRemoteUrl: getEnv("UPSTREAM_REMOTE_URL"),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
