import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type RunOptions = {
  allowFailure?: boolean;
};

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

function run(command: string, args: string[], options: RunOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    fail(
      [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") ||
        `${command} exited with status ${result.status ?? 1}`,
    );
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function git(args: string[], options: RunOptions = {}) {
  return run("git", args, options);
}

function writeOutput(key: string, value: string) {
  const file = getEnv("GITHUB_OUTPUT");
  if (!file) return;
  appendFileSync(file, `${key}=${value}\n`);
}

function writeSummary(title: string, body: string) {
  const file = getEnv("GITHUB_STEP_SUMMARY");
  if (!file) return;
  appendFileSync(file, `${title}\n\n${body}\n`);
}

function main() {
  const baseBranch = getEnv("BASE_BRANCH", "main");
  const syncBranch = getEnv("SYNC_BRANCH", "sync/integration");
  const expectedSyncSha = requireEnv("EXPECTED_SYNC_SHA");
  const originRemoteName = getEnv("ORIGIN_REMOTE_NAME", "origin");

  git([
    "fetch",
    "--no-tags",
    originRemoteName,
    `+refs/heads/${baseBranch}:refs/remotes/${originRemoteName}/${baseBranch}`,
    `+refs/heads/${syncBranch}:refs/remotes/${originRemoteName}/${syncBranch}`,
  ]);

  const currentSyncSha = git([
    "rev-parse",
    `refs/remotes/${originRemoteName}/${syncBranch}`,
  ]).stdout.trim();

  writeOutput("sync_branch", syncBranch);

  if (currentSyncSha !== expectedSyncSha) {
    writeOutput("promoted_sha", "");
    writeOutput("status", "stale_sync");
    writeSummary(
      "## Integration promotion blocked",
      [
        `- Sync branch: \`${syncBranch}\``,
        `- Expected tested SHA: \`${expectedSyncSha}\``,
        `- Current branch SHA: \`${currentSyncSha}\``,
        "- Reason: the tested commit is no longer the current sync branch head.",
      ].join("\n"),
    );
    fail(
      `Refusing to promote ${syncBranch}; expected tested SHA ${expectedSyncSha}.`,
    );
  }

  const baseLease = git([
    "rev-parse",
    `refs/remotes/${originRemoteName}/${baseBranch}`,
  ]).stdout.trim();
  log(`Promoting ${syncBranch}@${expectedSyncSha} onto ${baseBranch}`);
  const promote = git(
    [
      "push",
      `--force-with-lease=refs/heads/${baseBranch}:${baseLease}`,
      originRemoteName,
      `${expectedSyncSha}:refs/heads/${baseBranch}`,
    ],
    { allowFailure: true },
  );

  if (promote.status !== 0) {
    writeOutput("promoted_sha", "");
    writeOutput("status", "promotion_failed");
    writeSummary(
      "## Integration promotion failed",
      [
        `- Sync branch: \`${syncBranch}\``,
        `- Tested SHA: \`${expectedSyncSha}\``,
        `- Promotion target: \`${baseBranch}\``,
        "- Reason: promotion push to the target branch was rejected.",
      ].join("\n"),
    );
    fail(
      [promote.stderr.trim(), promote.stdout.trim()]
        .filter(Boolean)
        .join("\n") || `Failed to promote ${syncBranch} onto ${baseBranch}.`,
    );
  }

  writeOutput("promoted_sha", expectedSyncSha);
  writeOutput("status", "promoted");
  writeSummary(
    "## Integration promotion completed",
    [
      `- Sync branch: \`${syncBranch}\``,
      `- Promoted SHA: \`${expectedSyncSha}\``,
      `- Promotion target: \`${baseBranch}\``,
    ].join("\n"),
  );
  log("Integration promotion completed with status 'promoted'");
}

main();
