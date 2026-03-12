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

function repoSlugFromRemoteUrl(url: string) {
  return url
    .replace(/\.git$/, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^https?:\/\/github\.com\//, "");
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

function main() {
  const upstreamOwner = requireEnv("UPSTREAM_OWNER");
  const upstreamRepo = requireEnv("UPSTREAM_REPO");
  const patchRefsRaw = requireEnv("PATCH_REFS");

  const baseBranch = getEnv("BASE_BRANCH", "main");
  const upstreamRef = getEnv("UPSTREAM_REF", baseBranch);
  const releaseSelector = getEnv("RELEASE_SELECTOR");
  const syncBranch = getEnv("SYNC_BRANCH", "sync/integration");
  const prLabels = getEnv("PR_LABELS", "upstream-sync");
  const prTitleTemplate = getEnv(
    "PR_TITLE_TEMPLATE",
    "Sync integration branch from {source}",
  );
  const dryRun = isTrue(getEnv("DRY_RUN", "false"));
  const originRemoteName = getEnv("ORIGIN_REMOTE_NAME", "origin");
  const upstreamRemoteName = getEnv("UPSTREAM_REMOTE_NAME", "upstream");
  const upstreamRemoteUrl = getEnv(
    "UPSTREAM_REMOTE_URL",
    `https://github.com/${upstreamOwner}/${upstreamRepo}.git`,
  );

  const existingUpstream = git(["remote", "get-url", upstreamRemoteName], {
    allowFailure: true,
  });
  if (existingUpstream.status === 0) {
    git(["remote", "set-url", upstreamRemoteName, upstreamRemoteUrl]);
  } else {
    git(["remote", "add", upstreamRemoteName, upstreamRemoteUrl]);
  }

  let ghRepo = getEnv("GH_REPO", getEnv("GITHUB_REPOSITORY"));
  if (!ghRepo)
    ghRepo = repoSlugFromRemoteUrl(
      git(["remote", "get-url", originRemoteName]).stdout.trim(),
    );
  if (!ghRepo.includes("/"))
    fail("Failed to determine the fork repository slug for gh commands.");

  git([
    "fetch",
    "--no-tags",
    originRemoteName,
    `+refs/heads/${baseBranch}:refs/remotes/${originRemoteName}/${baseBranch}`,
  ]);
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

  const patchRefs = patchRefsRaw.split(/\r?\n/).map(trim).filter(Boolean);
  if (!patchRefs.length)
    fail("PATCH_REFS did not contain any patch branch names.");

  const prTitle = prTitleTemplate
    .replaceAll("{base_branch}", baseBranch)
    .replaceAll("{upstream}", `${upstreamOwner}/${upstreamRepo}`)
    .replaceAll("{source}", sourceLabel);

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
      writeOutput("pr_number", "");
      writeOutput("pr_url", "");
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
    const diff = runBuffer("git", [
      "diff",
      "--binary",
      `${upstreamBase}...${resolved}`,
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
      writeOutput("pr_number", "");
      writeOutput("pr_url", "");
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

  if (dryRun) {
    writeOutput("pr_number", "");
    writeOutput("pr_url", "");
    writeOutput("status", "dry_run");
    writeSummary(
      "## Integration rebuild completed",
      [
        `- Base: \`${upstreamBase}\``,
        `- Source: \`${sourceLabel}\``,
        `- Output branch: \`${syncBranch}\``,
        "- Mode: dry run",
      ].join("\n"),
      appliedRefs.length
        ? `### Applied patches\n\n${bulletList(appliedRefs)}`
        : "",
    );
    log("Dry run enabled; skipping push and PR operations.");
    return;
  }

  log(`Pushing ${syncBranch} to ${originRemoteName}`);
  git([
    "push",
    "--force-with-lease",
    "--set-upstream",
    originRemoteName,
    syncBranch,
  ]);

  const bodyText = [
    `This PR rebuilds \`${syncBranch}\` from \`${sourceLabel}\` and reapplies the configured fork patches.`,
    "",
    `- Upstream repository: \`${upstreamOwner}/${upstreamRepo}\``,
    `- Base branch: \`${baseBranch}\``,
    `- Source: \`${sourceLabel}\``,
    "- Generated by `Patchlane`",
    "",
    "## Applied patches",
    bulletList(appliedRefs),
  ].join("\n");
  const bodyFile = tmpFile("patchlane-body");
  writeFileSync(bodyFile, bodyText);

  const listArgs = [
    "pr",
    "list",
    "--repo",
    ghRepo,
    "--state",
    "open",
    "--head",
    syncBranch,
    "--base",
    baseBranch,
    "--json",
    "number,url",
  ];
  const existing = parseJson<Array<{ number: number; url: string }>>(
    gh(listArgs).stdout,
  );
  const labels = prLabels.split(",").map(trim).filter(Boolean);

  let prNumber = "";
  let prUrl = "";
  let status = "created";

  if (existing.length) {
    prNumber = String(existing[0].number);
    prUrl = existing[0].url;
    const editArgs = [
      "pr",
      "edit",
      prNumber,
      "--repo",
      ghRepo,
      "--title",
      prTitle,
      "--body-file",
      bodyFile,
    ];
    for (const label of labels) editArgs.push("--add-label", label);
    gh(editArgs);
    status = "updated";
    log(`Updated PR #${prNumber}`);
  } else {
    const createArgs = [
      "pr",
      "create",
      "--repo",
      ghRepo,
      "--base",
      baseBranch,
      "--head",
      syncBranch,
      "--title",
      prTitle,
      "--body-file",
      bodyFile,
    ];
    for (const label of labels) createArgs.push("--label", label);
    gh(createArgs);
    const created = parseJson<Array<{ number: number; url: string }>>(
      gh(listArgs).stdout,
    );
    prNumber = String(created[0]?.number ?? "");
    prUrl = created[0]?.url ?? "";
    log(`Created PR #${prNumber}`);
  }

  writeOutput("pr_number", prNumber);
  writeOutput("pr_url", prUrl);
  writeOutput("status", status);
  writeSummary(
    "## Integration rebuild completed",
    [
      `- Base: \`${upstreamBase}\``,
      `- Source: \`${sourceLabel}\``,
      `- Output branch: \`${syncBranch}\``,
      `- PR: ${prUrl}`,
    ].join("\n"),
    appliedRefs.length
      ? `### Applied patches\n\n${bulletList(appliedRefs)}`
      : "",
  );
  log(`Integration sync completed with status '${status}'`);
}

main();
