import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const cliPath = path.join(repoRoot, "dist", "integration-sync.js");
const promoteCliPath = path.join(repoRoot, "dist", "promote-sync.js");
const mockGhPath = path.join(
  repoRoot,
  "dist-test",
  "tests",
  "support",
  "mock-gh.js",
);

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
  } satisfies RunResult;
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = run("git", args, cwd, env);
  if (result.status !== 0) {
    assert.fail(
      [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") ||
        `git failed: ${args.join(" ")}`,
    );
  }
  return result.stdout.trim();
}

function configureUser(repo: string) {
  git(["config", "user.name", "github-actions[bot]"], repo);
  git(
    [
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ],
    repo,
  );
}

function writeReleasesState(stateDir: string, value: unknown) {
  writeFileSync(
    path.join(stateDir, "releases.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function readOutput(file: string, key: string) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
    if (line.startsWith(`${key}<<`)) {
      const marker = line.split("<<", 2)[1];
      const values: string[] = [];
      for (let j = i + 1; j < lines.length && lines[j] !== marker; j++)
        values.push(lines[j]);
      return values.join("\n");
    }
  }
  return "";
}

function createLauncher(dir: string) {
  const ghPath = path.join(dir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node\nimport { main } from ${JSON.stringify(pathToFileURL(mockGhPath).href)}\nmain(process.argv.slice(2))\n`,
  );
  chmodSync(ghPath, 0o755);
}

function createUpstreamRelease(
  repo: string,
  bare: string,
  tag: string,
  releaseText: string,
  readmeText: string,
) {
  writeFileSync(path.join(repo, "README.md"), `${readmeText}\n`);
  writeFileSync(path.join(repo, "upstream-release.txt"), `${releaseText}\n`);
  git(["add", "README.md", "upstream-release.txt"], repo);
  git(["commit", "-m", `Cut upstream ${tag}`], repo);
  git(["push", "origin", "main"], repo);
  git(["-c", "tag.gpgSign=false", "tag", "-a", tag, "-m", tag], repo);
  git(["push", "origin", tag], repo);
  return bare;
}

function createPatchBranch(
  seed: string,
  branch: string,
  baseRef: string,
  relativePath: string,
  contents: string,
) {
  git(["fetch", "upstream", "--tags", "--prune"], seed);
  git(["checkout", "-B", branch, baseRef], seed);
  mkdirSync(path.join(seed, path.dirname(relativePath)), { recursive: true });
  writeFileSync(path.join(seed, relativePath), `${contents}\n`);
  git(["add", relativePath], seed);
  git(["commit", "-m", `Add ${branch}`], seed);
  git(["push", "-f", "origin", branch], seed);
}

function commitToOriginBranch(
  repo: string,
  branch: string,
  relativePath: string,
  contents: string,
  message: string,
) {
  git(["fetch", "origin", branch], repo);
  git(["checkout", "-B", branch, `origin/${branch}`], repo);
  mkdirSync(path.join(repo, path.dirname(relativePath)), { recursive: true });
  writeFileSync(path.join(repo, relativePath), `${contents}\n`);
  git(["add", relativePath], repo);
  git(["commit", "-m", message], repo);
  git(["push", "origin", branch], repo);
}

function readRemoteFile(repo: string, ref: string, relativePath: string) {
  return git(["show", `${ref}:${relativePath}`], repo);
}

function remoteHasPath(repo: string, ref: string, relativePath: string) {
  return (
    run("git", ["cat-file", "-e", `${ref}:${relativePath}`], repo).status === 0
  );
}

function runSync(
  worktree: string,
  stateDir: string,
  outputFile: string,
  summaryFile: string,
  patchRefs: string,
  upstreamRef: string,
  releaseSelector: string,
  dryRun: boolean,
  upstreamRemoteUrl: string,
) {
  const launcherDir = mkdtempSync(path.join(tmpdir(), "patchlane-gh-"));
  createLauncher(launcherDir);
  const env = {
    ...process.env,
    PATH: `${launcherDir}:${process.env.PATH ?? ""}`,
    FORK_SYNC_GH_STATE_DIR: stateDir,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GH_TOKEN: "integration-token",
    UPSTREAM_OWNER: "example",
    UPSTREAM_REPO: "upstream",
    BASE_BRANCH: "main",
    UPSTREAM_REF: upstreamRef,
    RELEASE_SELECTOR: releaseSelector,
    SYNC_BRANCH: "sync/integration",
    PATCH_REFS: patchRefs,
    DRY_RUN: dryRun ? "true" : "false",
    UPSTREAM_REMOTE_URL: upstreamRemoteUrl,
  };

  const result = run("node", [cliPath], worktree, env);
  rmSync(launcherDir, { force: true, recursive: true });
  return result;
}

function runPromote(
  worktree: string,
  outputFile: string,
  summaryFile: string,
  expectedSha: string,
) {
  const env = {
    ...process.env,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    BASE_BRANCH: "main",
    SYNC_BRANCH: "sync/integration",
    EXPECTED_SYNC_SHA: expectedSha,
  };

  return run("node", [promoteCliPath], worktree, env);
}

test("integration sync CLI rebuilds from releases and branch refs", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "patchlane-"));
  try {
    const stateDir = path.join(tempRoot, "gh-state");
    mkdirSync(stateDir, { recursive: true });

    const upstreamBare = path.join(tempRoot, "upstream.git");
    const forkBare = path.join(tempRoot, "fork.git");
    const upstreamWork = path.join(tempRoot, "upstream-work");
    const forkSeed = path.join(tempRoot, "fork-seed");
    const forkWork = path.join(tempRoot, "fork-work");
    const branchWork = path.join(tempRoot, "branch-work");
    const conflictWork = path.join(tempRoot, "conflict-work");

    git(["init", "--bare", "--initial-branch=main", upstreamBare], tempRoot);
    git(["clone", upstreamBare, upstreamWork], tempRoot);
    configureUser(upstreamWork);
    writeFileSync(path.join(upstreamWork, "README.md"), "# Upstream Project\n");
    git(["add", "README.md"], upstreamWork);
    git(["commit", "-m", "Initial upstream release"], upstreamWork);
    git(["push", "origin", "main"], upstreamWork);
    git(
      ["-c", "tag.gpgSign=false", "tag", "-a", "v1.0.0", "-m", "v1.0.0"],
      upstreamWork,
    );
    git(["push", "origin", "v1.0.0"], upstreamWork);

    git(["init", "--bare", "--initial-branch=main", forkBare], tempRoot);
    git(["clone", upstreamBare, forkSeed], tempRoot);
    configureUser(forkSeed);
    git(["remote", "rename", "origin", "upstream"], forkSeed);
    git(["remote", "add", "origin", forkBare], forkSeed);
    git(["push", "origin", "main"], forkSeed);

    createUpstreamRelease(
      upstreamWork,
      upstreamBare,
      "v1.1.0",
      "v1.1.0",
      "# Upstream Project v1.1.0",
    );
    createPatchBranch(
      forkSeed,
      "patch/product",
      "v1.1.0",
      "PRODUCT.txt",
      "product patch",
    );
    createPatchBranch(
      forkSeed,
      "patch/sync",
      "v1.1.0",
      ".github/workflows/sync-upstream.yml",
      "name: Sync Wrapper",
    );
    createPatchBranch(
      forkSeed,
      "patch/ci",
      "v1.1.0",
      ".github/workflows/ci.yml",
      "name: Fork CI",
    );

    writeReleasesState(stateDir, [
      {
        tag_name: "v1.1.0",
        html_url: "https://example.test/upstream/releases/tag/v1.1.0",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v1.0.0",
        html_url: "https://example.test/upstream/releases/tag/v1.0.0",
        draft: false,
        prerelease: false,
      },
    ]);
    writeFileSync(path.join(stateDir, "prs.json"), "[]\n");

    git(["clone", forkBare, forkWork], tempRoot);
    configureUser(forkWork);

    const run1Out = path.join(tempRoot, "run-1.out");
    const run1Summary = path.join(tempRoot, "run-1.summary");
    const run1 = runSync(
      forkWork,
      stateDir,
      run1Out,
      run1Summary,
      "patch/product, patch/sync, patch/ci",
      "main",
      "latest",
      false,
      upstreamBare,
    );

    assert.equal(
      run1.status,
      0,
      [run1.stderr.trim(), run1.stdout.trim()].filter(Boolean).join("\n"),
    );
    assert.equal(readOutput(run1Out, "status"), "published");
    assert.equal(readOutput(run1Out, "sync_branch"), "sync/integration");
    assert.notEqual(readOutput(run1Out, "sync_sha"), "");
    assert.equal(
      readOutput(run1Out, "applied_refs"),
      "patch/product\npatch/sync\npatch/ci",
    );
    assert.ok(existsSync(path.join(forkWork, "PRODUCT.txt")));
    assert.ok(existsSync(path.join(forkWork, ".github/workflows/ci.yml")));
    assert.ok(
      existsSync(path.join(forkWork, ".github/workflows/sync-upstream.yml")),
    );
    git(["fetch", "origin", "main", "sync/integration"], forkSeed);
    assert.equal(
      git(["rev-parse", "refs/remotes/origin/sync/integration"], forkSeed),
      readOutput(run1Out, "sync_sha"),
    );
    assert.equal(
      readRemoteFile(forkSeed, "refs/remotes/origin/main", "README.md"),
      "# Upstream Project",
    );
    assert.equal(
      remoteHasPath(forkSeed, "refs/remotes/origin/main", "PRODUCT.txt"),
      false,
    );
    assert.equal(
      readRemoteFile(
        forkSeed,
        "refs/remotes/origin/sync/integration",
        "PRODUCT.txt",
      ),
      "product patch",
    );
    assert.equal(readFileSync(path.join(stateDir, "prs.json"), "utf8"), "[]\n");

    const run2Out = path.join(tempRoot, "run-2.out");
    const run2Summary = path.join(tempRoot, "run-2.summary");
    const run2 = runSync(
      forkWork,
      stateDir,
      run2Out,
      run2Summary,
      "patch/product, patch/sync, patch/ci",
      "main",
      "latest",
      false,
      upstreamBare,
    );

    assert.equal(
      run2.status,
      0,
      [run2.stderr.trim(), run2.stdout.trim()].filter(Boolean).join("\n"),
    );
    assert.equal(readOutput(run2Out, "status"), "unchanged");
    assert.notEqual(readOutput(run2Out, "sync_sha"), "");
    git(["fetch", "origin", "main", "sync/integration"], forkSeed);
    assert.equal(
      readOutput(run2Out, "sync_sha"),
      readOutput(run1Out, "sync_sha"),
    );
    assert.equal(
      readRemoteFile(forkSeed, "refs/remotes/origin/main", "README.md"),
      "# Upstream Project",
    );
    assert.equal(readFileSync(path.join(stateDir, "prs.json"), "utf8"), "[]\n");
    assert.match(
      run2.stdout,
      /Skipping push for sync\/integration; rebuilt tree matches origin\/sync\/integration\./,
    );

    writeFileSync(path.join(upstreamWork, "BRANCH.txt"), "# Branch Mode\n");
    git(["add", "BRANCH.txt"], upstreamWork);
    git(["commit", "-m", "Advance upstream main"], upstreamWork);
    git(["push", "origin", "main"], upstreamWork);
    createPatchBranch(
      forkSeed,
      "patch/branch",
      "upstream/main",
      "BRANCH-PATCH.txt",
      "branch patch",
    );

    git(["clone", forkBare, branchWork], tempRoot);
    configureUser(branchWork);
    const run3Out = path.join(tempRoot, "run-3.out");
    const run3Summary = path.join(tempRoot, "run-3.summary");
    const run3 = runSync(
      branchWork,
      stateDir,
      run3Out,
      run3Summary,
      "patch/branch",
      "main",
      "",
      true,
      upstreamBare,
    );

    assert.equal(
      run3.status,
      0,
      [run3.stderr.trim(), run3.stdout.trim()].filter(Boolean).join("\n"),
    );
    assert.equal(readOutput(run3Out, "status"), "dry_run");
    assert.ok(existsSync(path.join(branchWork, "BRANCH.txt")));
    assert.ok(existsSync(path.join(branchWork, "BRANCH-PATCH.txt")));

    createUpstreamRelease(
      upstreamWork,
      upstreamBare,
      "v1.2.0",
      "v1.2.0",
      "# Upstream Project v1.2.0",
    );
    createPatchBranch(
      forkSeed,
      "patch/conflict",
      "v1.1.0",
      "README.md",
      "# Fork Conflict",
    );
    writeReleasesState(stateDir, [
      {
        tag_name: "v1.2.0",
        html_url: "https://example.test/upstream/releases/tag/v1.2.0",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v1.1.0",
        html_url: "https://example.test/upstream/releases/tag/v1.1.0",
        draft: false,
        prerelease: false,
      },
    ]);

    git(["clone", forkBare, conflictWork], tempRoot);
    configureUser(conflictWork);
    const run4Out = path.join(tempRoot, "run-4.out");
    const run4Summary = path.join(tempRoot, "run-4.summary");
    const run4 = runSync(
      conflictWork,
      stateDir,
      run4Out,
      run4Summary,
      "patch/product\npatch/conflict",
      "main",
      "latest",
      true,
      upstreamBare,
    );

    assert.notEqual(run4.status, 0);
    assert.equal(readOutput(run4Out, "failed_bookmark"), "patch/conflict");
    assert.equal(readOutput(run4Out, "applied_refs"), "patch/product");
    assert.equal(readOutput(run4Out, "conflicted_paths"), "README.md");
    assert.equal(readOutput(run4Out, "status"), "conflicted");
    assert.match(readFileSync(run4Summary, "utf8"), /README\.md/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("integration sync CLI handles release selectors and patch edge cases", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "patchlane-"));
  try {
    const stateDir = path.join(tempRoot, "gh-state");
    mkdirSync(stateDir, { recursive: true });

    const upstreamBare = path.join(tempRoot, "upstream.git");
    const forkBare = path.join(tempRoot, "fork.git");
    const upstreamWork = path.join(tempRoot, "upstream-work");
    const forkSeed = path.join(tempRoot, "fork-seed");
    const prereleaseWork = path.join(tempRoot, "prerelease-work");
    const regexWork = path.join(tempRoot, "regex-work");
    const noopWork = path.join(tempRoot, "noop-work");
    const missingWork = path.join(tempRoot, "missing-work");
    const noMatchWork = path.join(tempRoot, "no-match-work");

    git(["init", "--bare", "--initial-branch=main", upstreamBare], tempRoot);
    git(["clone", upstreamBare, upstreamWork], tempRoot);
    configureUser(upstreamWork);
    writeFileSync(path.join(upstreamWork, "README.md"), "# Upstream Project\n");
    git(["add", "README.md"], upstreamWork);
    git(["commit", "-m", "Initial upstream release"], upstreamWork);
    git(["push", "origin", "main"], upstreamWork);
    git(
      ["-c", "tag.gpgSign=false", "tag", "-a", "v1.0.0", "-m", "v1.0.0"],
      upstreamWork,
    );
    git(["push", "origin", "v1.0.0"], upstreamWork);

    git(["init", "--bare", "--initial-branch=main", forkBare], tempRoot);
    git(["clone", upstreamBare, forkSeed], tempRoot);
    configureUser(forkSeed);
    git(["remote", "rename", "origin", "upstream"], forkSeed);
    git(["remote", "add", "origin", forkBare], forkSeed);
    git(["push", "origin", "main"], forkSeed);

    createUpstreamRelease(
      upstreamWork,
      upstreamBare,
      "v1.1.0",
      "v1.1.0",
      "# Upstream Project v1.1.0",
    );
    createPatchBranch(
      forkSeed,
      "patch/noop",
      "v1.0.0",
      "README.md",
      "# Upstream Project v1.1.0",
    );
    createPatchBranch(
      forkSeed,
      "patch/regex",
      "v1.1.0",
      "REGEX.txt",
      "regex patch",
    );
    createUpstreamRelease(
      upstreamWork,
      upstreamBare,
      "v1.2.0-rc.1",
      "v1.2.0-rc.1",
      "# Upstream Project v1.2.0-rc.1",
    );
    createPatchBranch(
      forkSeed,
      "patch/prerelease",
      "v1.2.0-rc.1",
      "RC.txt",
      "prerelease patch",
    );

    writeReleasesState(stateDir, [
      {
        tag_name: "v1.2.0-rc.1",
        html_url: "https://example.test/upstream/releases/tag/v1.2.0-rc.1",
        draft: false,
        prerelease: true,
      },
      {
        tag_name: "v1.1.0",
        html_url: "https://example.test/upstream/releases/tag/v1.1.0",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v1.0.0",
        html_url: "https://example.test/upstream/releases/tag/v1.0.0",
        draft: false,
        prerelease: false,
      },
    ]);
    writeFileSync(path.join(stateDir, "prs.json"), "[]\n");

    git(["clone", forkBare, prereleaseWork], tempRoot);
    configureUser(prereleaseWork);
    const prereleaseOut = path.join(tempRoot, "prerelease.out");
    const prereleaseSummary = path.join(tempRoot, "prerelease.summary");
    const prereleaseRun = runSync(
      prereleaseWork,
      stateDir,
      prereleaseOut,
      prereleaseSummary,
      "patch/prerelease",
      "main",
      "prerelease",
      true,
      upstreamBare,
    );

    assert.equal(
      prereleaseRun.status,
      0,
      [prereleaseRun.stderr.trim(), prereleaseRun.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(readOutput(prereleaseOut, "status"), "dry_run");
    assert.equal(readOutput(prereleaseOut, "applied_refs"), "patch/prerelease");
    assert.ok(existsSync(path.join(prereleaseWork, "RC.txt")));
    assert.match(
      readFileSync(prereleaseSummary, "utf8"),
      /release v1\.2\.0-rc\.1/,
    );

    git(["clone", forkBare, regexWork], tempRoot);
    configureUser(regexWork);
    const regexOut = path.join(tempRoot, "regex.out");
    const regexSummary = path.join(tempRoot, "regex.summary");
    const regexRun = runSync(
      regexWork,
      stateDir,
      regexOut,
      regexSummary,
      "patch/regex",
      "main",
      "^v1\\.1\\.0$",
      true,
      upstreamBare,
    );

    assert.equal(
      regexRun.status,
      0,
      [regexRun.stderr.trim(), regexRun.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(readOutput(regexOut, "status"), "dry_run");
    assert.equal(readOutput(regexOut, "applied_refs"), "patch/regex");
    assert.ok(existsSync(path.join(regexWork, "REGEX.txt")));
    assert.match(readFileSync(regexSummary, "utf8"), /release v1\.1\.0/);

    git(["clone", forkBare, noopWork], tempRoot);
    configureUser(noopWork);
    const noopOut = path.join(tempRoot, "noop.out");
    const noopSummary = path.join(tempRoot, "noop.summary");
    const noopRun = runSync(
      noopWork,
      stateDir,
      noopOut,
      noopSummary,
      "patch/noop",
      "main",
      "^v1\\.1\\.0$",
      true,
      upstreamBare,
    );

    assert.equal(
      noopRun.status,
      0,
      [noopRun.stderr.trim(), noopRun.stdout.trim()].filter(Boolean).join("\n"),
    );
    assert.equal(readOutput(noopOut, "status"), "dry_run");
    assert.equal(readOutput(noopOut, "applied_refs"), "");
    assert.match(
      noopRun.stdout,
      /Skipping patch\/noop; patch produced no staged changes\./,
    );

    git(["clone", forkBare, missingWork], tempRoot);
    configureUser(missingWork);
    const missingOut = path.join(tempRoot, "missing.out");
    const missingSummary = path.join(tempRoot, "missing.summary");
    const missingRun = runSync(
      missingWork,
      stateDir,
      missingOut,
      missingSummary,
      "patch/missing",
      "main",
      "^v1\\.1\\.0$",
      true,
      upstreamBare,
    );

    assert.notEqual(missingRun.status, 0);
    assert.equal(readOutput(missingOut, "failed_bookmark"), "patch/missing");
    assert.equal(readOutput(missingOut, "applied_refs"), "");
    assert.equal(readOutput(missingOut, "status"), "missing_patch");
    assert.match(
      readFileSync(missingSummary, "utf8"),
      /patch ref could not be resolved locally or from `origin`/,
    );

    git(["clone", forkBare, noMatchWork], tempRoot);
    configureUser(noMatchWork);
    const noMatchOut = path.join(tempRoot, "no-match.out");
    const noMatchSummary = path.join(tempRoot, "no-match.summary");
    const noMatchRun = runSync(
      noMatchWork,
      stateDir,
      noMatchOut,
      noMatchSummary,
      "patch/regex",
      "main",
      "^v9\\.",
      true,
      upstreamBare,
    );

    assert.notEqual(noMatchRun.status, 0);
    assert.match(noMatchRun.stderr, /No upstream release matched selector/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("promote sync CLI promotes tested sync branches onto the base branch", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "patchlane-"));
  try {
    const stateDir = path.join(tempRoot, "gh-state");
    mkdirSync(stateDir, { recursive: true });

    const upstreamBare = path.join(tempRoot, "upstream.git");
    const forkBare = path.join(tempRoot, "fork.git");
    const upstreamWork = path.join(tempRoot, "upstream-work");
    const forkSeed = path.join(tempRoot, "fork-seed");
    const firstWork = path.join(tempRoot, "first-work");
    const secondWork = path.join(tempRoot, "second-work");
    const promoteWork = path.join(tempRoot, "promote-work");

    git(["init", "--bare", "--initial-branch=main", upstreamBare], tempRoot);
    git(["clone", upstreamBare, upstreamWork], tempRoot);
    configureUser(upstreamWork);
    writeFileSync(path.join(upstreamWork, "README.md"), "# Upstream Project\n");
    git(["add", "README.md"], upstreamWork);
    git(["commit", "-m", "Initial upstream release"], upstreamWork);
    git(["push", "origin", "main"], upstreamWork);
    git(
      ["-c", "tag.gpgSign=false", "tag", "-a", "v1.0.0", "-m", "v1.0.0"],
      upstreamWork,
    );
    git(["push", "origin", "v1.0.0"], upstreamWork);

    git(["init", "--bare", "--initial-branch=main", forkBare], tempRoot);
    git(["clone", upstreamBare, forkSeed], tempRoot);
    configureUser(forkSeed);
    git(["remote", "rename", "origin", "upstream"], forkSeed);
    git(["remote", "add", "origin", forkBare], forkSeed);
    git(["push", "origin", "main"], forkSeed);

    createUpstreamRelease(
      upstreamWork,
      upstreamBare,
      "v1.1.0",
      "v1.1.0",
      "# Upstream Project v1.1.0",
    );
    createPatchBranch(
      forkSeed,
      "patch/product",
      "v1.1.0",
      "PRODUCT.txt",
      "product patch",
    );
    writeReleasesState(stateDir, [
      {
        tag_name: "v1.1.0",
        html_url: "https://example.test/upstream/releases/tag/v1.1.0",
        draft: false,
        prerelease: false,
      },
    ]);
    writeFileSync(path.join(stateDir, "prs.json"), "[]\n");

    git(["clone", forkBare, firstWork], tempRoot);
    configureUser(firstWork);
    const firstOut = path.join(tempRoot, "first.out");
    const firstSummary = path.join(tempRoot, "first.summary");
    const firstRun = runSync(
      firstWork,
      stateDir,
      firstOut,
      firstSummary,
      "patch/product",
      "main",
      "latest",
      false,
      upstreamBare,
    );

    assert.equal(
      firstRun.status,
      0,
      [firstRun.stderr.trim(), firstRun.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(readOutput(firstOut, "status"), "published");
    const firstSha = readOutput(firstOut, "sync_sha");

    git(["clone", forkBare, promoteWork], tempRoot);
    configureUser(promoteWork);
    const promote1Out = path.join(tempRoot, "promote-1.out");
    const promote1Summary = path.join(tempRoot, "promote-1.summary");
    const promote1 = runPromote(
      promoteWork,
      promote1Out,
      promote1Summary,
      firstSha,
    );

    assert.equal(
      promote1.status,
      0,
      [promote1.stderr.trim(), promote1.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(readOutput(promote1Out, "status"), "promoted");
    assert.equal(readOutput(promote1Out, "promoted_sha"), firstSha);
    git(["fetch", "origin", "main", "sync/integration"], forkSeed);
    assert.equal(
      readRemoteFile(forkSeed, "refs/remotes/origin/main", "PRODUCT.txt"),
      "product patch",
    );

    createUpstreamRelease(
      upstreamWork,
      upstreamBare,
      "v1.2.0",
      "v1.2.0",
      "# Upstream Project v1.2.0",
    );
    createPatchBranch(
      forkSeed,
      "patch/product",
      "v1.2.0",
      "PRODUCT.txt",
      "product patch",
    );
    writeReleasesState(stateDir, [
      {
        tag_name: "v1.2.0",
        html_url: "https://example.test/upstream/releases/tag/v1.2.0",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v1.1.0",
        html_url: "https://example.test/upstream/releases/tag/v1.1.0",
        draft: false,
        prerelease: false,
      },
    ]);

    git(["clone", forkBare, secondWork], tempRoot);
    configureUser(secondWork);
    const secondOut = path.join(tempRoot, "second.out");
    const secondSummary = path.join(tempRoot, "second.summary");
    const secondRun = runSync(
      secondWork,
      stateDir,
      secondOut,
      secondSummary,
      "patch/product",
      "main",
      "latest",
      false,
      upstreamBare,
    );

    assert.equal(
      secondRun.status,
      0,
      [secondRun.stderr.trim(), secondRun.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(readOutput(secondOut, "status"), "published");
    const secondSha = readOutput(secondOut, "sync_sha");

    const promote2Out = path.join(tempRoot, "promote-2.out");
    const promote2Summary = path.join(tempRoot, "promote-2.summary");
    const promote2 = runPromote(
      promoteWork,
      promote2Out,
      promote2Summary,
      secondSha,
    );

    assert.equal(
      promote2.status,
      0,
      [promote2.stderr.trim(), promote2.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(readOutput(promote2Out, "status"), "promoted");
    assert.equal(readOutput(promote2Out, "promoted_sha"), secondSha);
    git(["fetch", "origin", "main", "sync/integration"], forkSeed);
    assert.equal(
      readRemoteFile(forkSeed, "refs/remotes/origin/main", "PRODUCT.txt"),
      "product patch",
    );
    assert.equal(
      readRemoteFile(
        forkSeed,
        "refs/remotes/origin/sync/integration",
        "PRODUCT.txt",
      ),
      "product patch",
    );
    assert.match(readFileSync(secondSummary, "utf8"), /release v1\.2\.0/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("promote sync CLI rejects stale tested SHAs and only promotes the current sync head", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "patchlane-"));
  try {
    const stateDir = path.join(tempRoot, "gh-state");
    mkdirSync(stateDir, { recursive: true });

    const upstreamBare = path.join(tempRoot, "upstream.git");
    const forkBare = path.join(tempRoot, "fork.git");
    const upstreamWork = path.join(tempRoot, "upstream-work");
    const forkSeed = path.join(tempRoot, "fork-seed");
    const firstWork = path.join(tempRoot, "first-work");
    const secondWork = path.join(tempRoot, "second-work");
    const promoteWork = path.join(tempRoot, "promote-work");

    git(["init", "--bare", "--initial-branch=main", upstreamBare], tempRoot);
    git(["clone", upstreamBare, upstreamWork], tempRoot);
    configureUser(upstreamWork);
    writeFileSync(path.join(upstreamWork, "README.md"), "# Upstream Project\n");
    git(["add", "README.md"], upstreamWork);
    git(["commit", "-m", "Initial upstream release"], upstreamWork);
    git(["push", "origin", "main"], upstreamWork);
    git(
      ["-c", "tag.gpgSign=false", "tag", "-a", "v1.0.0", "-m", "v1.0.0"],
      upstreamWork,
    );
    git(["push", "origin", "v1.0.0"], upstreamWork);

    git(["init", "--bare", "--initial-branch=main", forkBare], tempRoot);
    git(["clone", upstreamBare, forkSeed], tempRoot);
    configureUser(forkSeed);
    git(["remote", "rename", "origin", "upstream"], forkSeed);
    git(["remote", "add", "origin", forkBare], forkSeed);
    git(["push", "origin", "main"], forkSeed);

    createUpstreamRelease(
      upstreamWork,
      upstreamBare,
      "v1.1.0",
      "v1.1.0",
      "# Upstream Project v1.1.0",
    );
    createPatchBranch(
      forkSeed,
      "patch/product",
      "v1.1.0",
      "README.md",
      "# Fork Release v1.1.0",
    );
    writeReleasesState(stateDir, [
      {
        tag_name: "v1.1.0",
        html_url: "https://example.test/upstream/releases/tag/v1.1.0",
        draft: false,
        prerelease: false,
      },
    ]);
    writeFileSync(path.join(stateDir, "prs.json"), "[]\n");

    git(["clone", forkBare, firstWork], tempRoot);
    configureUser(firstWork);
    const firstOut = path.join(tempRoot, "first.out");
    const firstSummary = path.join(tempRoot, "first.summary");
    const firstRun = runSync(
      firstWork,
      stateDir,
      firstOut,
      firstSummary,
      "patch/product",
      "main",
      "latest",
      false,
      upstreamBare,
    );

    assert.equal(
      firstRun.status,
      0,
      [firstRun.stderr.trim(), firstRun.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    const firstSha = readOutput(firstOut, "sync_sha");

    git(["clone", forkBare, promoteWork], tempRoot);
    configureUser(promoteWork);
    const promote1Out = path.join(tempRoot, "promote-1.out");
    const promote1Summary = path.join(tempRoot, "promote-1.summary");
    const promote1 = runPromote(
      promoteWork,
      promote1Out,
      promote1Summary,
      firstSha,
    );

    assert.equal(
      promote1.status,
      0,
      [promote1.stderr.trim(), promote1.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    commitToOriginBranch(
      forkSeed,
      "main",
      "README.md",
      "# Base Branch Override",
      "Customize base branch",
    );

    createUpstreamRelease(
      upstreamWork,
      upstreamBare,
      "v1.2.0",
      "v1.2.0",
      "# Upstream Project v1.2.0",
    );
    createPatchBranch(
      forkSeed,
      "patch/product",
      "v1.2.0",
      "README.md",
      "# Fork Release v1.2.0",
    );
    writeReleasesState(stateDir, [
      {
        tag_name: "v1.2.0",
        html_url: "https://example.test/upstream/releases/tag/v1.2.0",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v1.1.0",
        html_url: "https://example.test/upstream/releases/tag/v1.1.0",
        draft: false,
        prerelease: false,
      },
    ]);

    git(["clone", forkBare, secondWork], tempRoot);
    configureUser(secondWork);
    const secondOut = path.join(tempRoot, "second.out");
    const secondSummary = path.join(tempRoot, "second.summary");
    const secondRun = runSync(
      secondWork,
      stateDir,
      secondOut,
      secondSummary,
      "patch/product",
      "main",
      "latest",
      false,
      upstreamBare,
    );

    assert.equal(
      secondRun.status,
      0,
      [secondRun.stderr.trim(), secondRun.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(readOutput(secondOut, "status"), "published");
    const secondSha = readOutput(secondOut, "sync_sha");

    const staleOut = path.join(tempRoot, "promote-stale.out");
    const staleSummary = path.join(tempRoot, "promote-stale.summary");
    const stalePromote = runPromote(
      promoteWork,
      staleOut,
      staleSummary,
      firstSha,
    );

    assert.notEqual(stalePromote.status, 0);
    assert.equal(readOutput(staleOut, "status"), "stale_sync");
    assert.equal(readOutput(staleOut, "promoted_sha"), "");
    git(["fetch", "origin", "main", "sync/integration"], forkSeed);
    assert.equal(
      readRemoteFile(forkSeed, "refs/remotes/origin/main", "README.md"),
      "# Base Branch Override",
    );

    const promote2Out = path.join(tempRoot, "promote-2.out");
    const promote2Summary = path.join(tempRoot, "promote-2.summary");
    const promote2 = runPromote(
      promoteWork,
      promote2Out,
      promote2Summary,
      secondSha,
    );

    assert.equal(
      promote2.status,
      0,
      [promote2.stderr.trim(), promote2.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(readOutput(promote2Out, "status"), "promoted");
    assert.equal(readOutput(promote2Out, "promoted_sha"), secondSha);
    git(["fetch", "origin", "main", "sync/integration"], forkSeed);
    assert.equal(
      readRemoteFile(forkSeed, "refs/remotes/origin/main", "README.md"),
      "# Fork Release v1.2.0",
    );
    assert.equal(
      readRemoteFile(
        forkSeed,
        "refs/remotes/origin/sync/integration",
        "README.md",
      ),
      "# Fork Release v1.2.0",
    );
    assert.match(readFileSync(staleSummary, "utf8"), /Expected tested SHA/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("integration sync CLI applies patches based on older releases when releases diverge", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "patchlane-"));
  try {
    const stateDir = path.join(tempRoot, "gh-state");
    mkdirSync(stateDir, { recursive: true });

    const upstreamBare = path.join(tempRoot, "upstream.git");
    const forkBare = path.join(tempRoot, "fork.git");
    const upstreamWork = path.join(tempRoot, "upstream-work");
    const forkSeed = path.join(tempRoot, "fork-seed");
    const syncWork = path.join(tempRoot, "sync-work");

    git(["init", "--bare", "--initial-branch=main", upstreamBare], tempRoot);
    git(["clone", upstreamBare, upstreamWork], tempRoot);
    configureUser(upstreamWork);
    writeFileSync(path.join(upstreamWork, "README.md"), "# Upstream Project\n");
    git(["add", "README.md"], upstreamWork);
    git(["commit", "-m", "Initial upstream release"], upstreamWork);
    git(["push", "origin", "main"], upstreamWork);
    git(
      ["-c", "tag.gpgSign=false", "tag", "-a", "v1.0.0", "-m", "v1.0.0"],
      upstreamWork,
    );
    git(["push", "origin", "v1.0.0"], upstreamWork);

    git(["init", "--bare", "--initial-branch=main", forkBare], tempRoot);
    git(["clone", upstreamBare, forkSeed], tempRoot);
    configureUser(forkSeed);
    git(["remote", "rename", "origin", "upstream"], forkSeed);
    git(["remote", "add", "origin", forkBare], forkSeed);
    git(["push", "origin", "main"], forkSeed);

    // Create a release branch for v1.1.0 with a version bump
    git(["checkout", "-b", "release/v1.1.0", "main"], upstreamWork);
    writeFileSync(
      path.join(upstreamWork, "version.txt"),
      "version=1.1.0\n",
    );
    git(["add", "version.txt"], upstreamWork);
    git(["commit", "-m", "Release v1.1.0"], upstreamWork);
    git(["push", "origin", "release/v1.1.0"], upstreamWork);
    git(
      ["-c", "tag.gpgSign=false", "tag", "-a", "v1.1.0", "-m", "v1.1.0"],
      upstreamWork,
    );
    git(["push", "origin", "v1.1.0"], upstreamWork);

    // Create a divergent release branch for v1.2.0 with a different version bump
    git(["checkout", "-b", "release/v1.2.0", "main"], upstreamWork);
    writeFileSync(
      path.join(upstreamWork, "version.txt"),
      "version=1.2.0\n",
    );
    git(["add", "version.txt"], upstreamWork);
    git(["commit", "-m", "Release v1.2.0"], upstreamWork);
    git(["push", "origin", "release/v1.2.0"], upstreamWork);
    git(
      ["-c", "tag.gpgSign=false", "tag", "-a", "v1.2.0", "-m", "v1.2.0"],
      upstreamWork,
    );
    git(["push", "origin", "v1.2.0"], upstreamWork);

    // Create a patch based on v1.1.0 that adds a feature
    createPatchBranch(
      forkSeed,
      "patch/feature",
      "v1.1.0",
      "FEATURE.txt",
      "feature patch",
    );

    writeReleasesState(stateDir, [
      {
        tag_name: "v1.2.0",
        html_url: "https://example.test/upstream/releases/tag/v1.2.0",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v1.1.0",
        html_url: "https://example.test/upstream/releases/tag/v1.1.0",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v1.0.0",
        html_url: "https://example.test/upstream/releases/tag/v1.0.0",
        draft: false,
        prerelease: false,
      },
    ]);
    writeFileSync(path.join(stateDir, "prs.json"), "[]\n");

    git(["clone", forkBare, syncWork], tempRoot);
    configureUser(syncWork);
    const syncOut = path.join(tempRoot, "sync.out");
    const syncSummary = path.join(tempRoot, "sync.summary");
    const syncRun = runSync(
      syncWork,
      stateDir,
      syncOut,
      syncSummary,
      "patch/feature",
      "main",
      "latest",
      true,
      upstreamBare,
    );

    assert.equal(
      syncRun.status,
      0,
      [syncRun.stderr.trim(), syncRun.stdout.trim()].filter(Boolean).join("\n"),
    );
    assert.equal(readOutput(syncOut, "status"), "dry_run");
    assert.equal(readOutput(syncOut, "applied_refs"), "patch/feature");
    assert.ok(existsSync(path.join(syncWork, "FEATURE.txt")));
    // version.txt should have v1.2.0, not v1.1.0 (the patch base logic avoids
    // re-applying the v1.1.0 release changes on top of v1.2.0)
    assert.equal(
      readFileSync(path.join(syncWork, "version.txt"), "utf8").trim(),
      "version=1.2.0",
    );
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
