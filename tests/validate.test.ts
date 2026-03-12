import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

for (const file of [
  ".github/workflows/patchlane.yml",
  ".github/workflows/validate.yml",
  "examples/sync-upstream.yml",
  "examples/fork-ci.yml",
]) {
  test(`yaml parses: ${file}`, () => {
    assert.doesNotThrow(() =>
      YAML.parse(readFileSync(path.join(repoRoot, file), "utf8")),
    );
  });
}

test("README references the integration workflow", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /patchlane\.yml@v1/);
  assert.match(readme, /patch\/sync/);
  assert.match(readme, /patch\/ci/);
});
