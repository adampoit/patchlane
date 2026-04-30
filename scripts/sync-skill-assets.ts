import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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
];

for (const [sourceRelativePath, destinationRelativePath] of fileMappings) {
  const sourcePath = path.join(rootDir, sourceRelativePath);
  const destinationPath = path.join(rootDir, destinationRelativePath);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
}
