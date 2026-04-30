import { expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type SkillState = {
  files: Record<string, string>;
};

function expectSuccess(result: RunResult) {
  if (result.status !== 0) {
    throw new Error(
      [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") ||
        `Expected exit status 0, got ${result.status}`,
    );
  }

  expect(result.status).toBe(0);
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status: status ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

async function startSkillsServer(state: SkillState) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const relativePath = requestUrl.pathname.replace(/^\//, "");
    const payload = state.files[relativePath];

    if (payload === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
      return;
    }

    const contentType = relativePath.endsWith(".json")
      ? "application/json"
      : "text/plain; charset=utf-8";
    response.writeHead(200, { "content-type": contentType });
    response.end(payload);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start local skills test server.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("agents command installs and updates managed skills", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "patchlane-agents-"));
  const state: SkillState = {
    files: {
      "manifest.json": `${JSON.stringify(
        {
          version: 1,
          skills: [
            {
              name: "patchlane-fork-setup",
              files: ["SKILL.md", "references/checklist.md"],
            },
            {
              name: "patchlane-sync-patches",
              files: ["SKILL.md"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "patchlane-fork-setup/SKILL.md": "setup skill v1\n",
      "patchlane-fork-setup/references/checklist.md": "checklist v1\n",
      "patchlane-sync-patches/SKILL.md": "sync skill v1\n",
    },
  };

  const server = await startSkillsServer(state);

  try {
    const firstRun = await run("node", [cliPath, "agents"], tempRoot, {
      ...process.env,
      PATCHLANE_SKILLS_BASE_URL: server.baseUrl,
    });

    expectSuccess(firstRun);
    expect(
      readFileSync(
        path.join(tempRoot, ".agents/skills/patchlane-fork-setup/SKILL.md"),
        "utf8",
      ),
    ).toBe("setup skill v1\n");
    expect(
      readFileSync(
        path.join(
          tempRoot,
          ".agents/skills/patchlane-fork-setup/references/checklist.md",
        ),
        "utf8",
      ),
    ).toBe("checklist v1\n");
    expect(
      readFileSync(
        path.join(tempRoot, ".agents/skills/patchlane-sync-patches/SKILL.md"),
        "utf8",
      ),
    ).toBe("sync skill v1\n");

    mkdirSync(path.join(tempRoot, ".agents/skills/custom-skill"), {
      recursive: true,
    });
    writeFileSync(
      path.join(tempRoot, ".agents/skills/custom-skill/SKILL.md"),
      "custom skill\n",
    );

    state.files = {
      "manifest.json": `${JSON.stringify(
        {
          version: 1,
          skills: [
            {
              name: "patchlane-fork-setup",
              files: ["SKILL.md"],
            },
            {
              name: "patchlane-maintenance",
              files: ["SKILL.md"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "patchlane-fork-setup/SKILL.md": "setup skill v2\n",
      "patchlane-maintenance/SKILL.md": "maintenance skill v1\n",
    };

    const secondRun = await run("node", [cliPath, "agents"], tempRoot, {
      ...process.env,
      PATCHLANE_SKILLS_BASE_URL: server.baseUrl,
    });

    expectSuccess(secondRun);
    expect(
      readFileSync(
        path.join(tempRoot, ".agents/skills/patchlane-fork-setup/SKILL.md"),
        "utf8",
      ),
    ).toBe("setup skill v2\n");
    expect(
      existsSync(
        path.join(
          tempRoot,
          ".agents/skills/patchlane-fork-setup/references/checklist.md",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(path.join(tempRoot, ".agents/skills/patchlane-sync-patches")),
    ).toBe(false);
    expect(
      readFileSync(
        path.join(tempRoot, ".agents/skills/patchlane-maintenance/SKILL.md"),
        "utf8",
      ),
    ).toBe("maintenance skill v1\n");
    expect(
      readFileSync(
        path.join(tempRoot, ".agents/skills/custom-skill/SKILL.md"),
        "utf8",
      ),
    ).toBe("custom skill\n");
  } finally {
    await server.close();
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
