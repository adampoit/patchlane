import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const fileMappings = [
  [
    "examples/sync-upstream.yml",
    "skills/patchlane-fork-setup/assets/sync-upstream.yml",
  ],
  ["examples/fork-ci.yml", "skills/patchlane-fork-setup/assets/fork-ci.yml"],
  [
    "examples/promote-tested-sync.yml",
    "skills/patchlane-fork-setup/assets/promote-tested-sync.yml",
  ],
] as const;

test("bundled Patchlane skill assets stay in sync with examples", () => {
  for (const [sourceRelativePath, destinationRelativePath] of fileMappings) {
    assert.equal(
      readFileSync(path.join(repoRoot, destinationRelativePath), "utf8"),
      readFileSync(path.join(repoRoot, sourceRelativePath), "utf8"),
      `${destinationRelativePath} drifted from ${sourceRelativePath}`,
    );
  }
});
