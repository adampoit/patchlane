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

function readPrField(stateDir: string, number: number, field: string) {
  const prs = JSON.parse(
    readFileSync(path.join(stateDir, "prs.json"), "utf8"),
  ) as Array<Record<string, unknown>>;
  const pr = prs.find((item) => item.number === number);
  if (!pr) return "";
  const value = pr[field];
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
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

function runSync(
  worktree: string,
  stateDir: string,
  outputFile: string,
  summaryFile: string,
  patchRefs: string,
  upstreamRef: string,
  releaseSelector: string,
  dryRun: boolean,
  prTitle: string,
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
    GH_REPO: "example/fork",
    UPSTREAM_OWNER: "example",
    UPSTREAM_REPO: "upstream",
    BASE_BRANCH: "main",
    UPSTREAM_REF: upstreamRef,
    RELEASE_SELECTOR: releaseSelector,
    SYNC_BRANCH: "sync/integration",
    PATCH_REFS: patchRefs,
    PR_LABELS: "automated,upstream-sync",
    PR_TITLE_TEMPLATE: prTitle,
    DRY_RUN: dryRun ? "true" : "false",
    UPSTREAM_REMOTE_URL: upstreamRemoteUrl,
  };

  const result = run("node", [cliPath], worktree, env);
  rmSync(launcherDir, { force: true, recursive: true });
  return result;
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
      "patch/product\npatch/sync\npatch/ci",
      "main",
      "latest",
      false,
      "Sync integration branch from {source}",
      upstreamBare,
    );

    assert.equal(
      run1.status,
      0,
      [run1.stderr.trim(), run1.stdout.trim()].filter(Boolean).join("\n"),
    );
    assert.equal(readOutput(run1Out, "status"), "created");
    assert.equal(readOutput(run1Out, "sync_branch"), "sync/integration");
    assert.equal(readOutput(run1Out, "pr_number"), "1");
    assert.equal(
      readPrField(stateDir, 1, "title"),
      "Sync integration branch from release v1.1.0",
    );
    assert.ok(existsSync(path.join(forkWork, "PRODUCT.txt")));
    assert.ok(existsSync(path.join(forkWork, ".github/workflows/ci.yml")));
    assert.ok(
      existsSync(path.join(forkWork, ".github/workflows/sync-upstream.yml")),
    );

    const run2Out = path.join(tempRoot, "run-2.out");
    const run2Summary = path.join(tempRoot, "run-2.summary");
    const run2 = runSync(
      forkWork,
      stateDir,
      run2Out,
      run2Summary,
      "patch/product\npatch/sync\npatch/ci",
      "main",
      "latest",
      false,
      "Refresh integration branch from {source}",
      upstreamBare,
    );

    assert.equal(
      run2.status,
      0,
      [run2.stderr.trim(), run2.stdout.trim()].filter(Boolean).join("\n"),
    );
    assert.equal(readOutput(run2Out, "status"), "updated");
    assert.equal(readOutput(run2Out, "pr_number"), "1");
    assert.equal(
      readPrField(stateDir, 1, "title"),
      "Refresh integration branch from release v1.1.0",
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
      "Sync integration branch from {source}",
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
      "Sync integration branch from {source}",
      upstreamBare,
    );

    assert.notEqual(run4.status, 0);
    assert.equal(readOutput(run4Out, "failed_bookmark"), "patch/conflict");
    assert.equal(readOutput(run4Out, "status"), "conflicted");
    assert.match(readFileSync(run4Summary, "utf8"), /README\.md/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
