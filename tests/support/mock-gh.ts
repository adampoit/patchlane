#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type PullRequest = {
  auto_merge: boolean;
  base: string;
  body: string;
  comment?: string;
  head: string;
  labels: string[];
  merge_method: string;
  number: number;
  state: string;
  title: string;
  url: string;
};

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function loadJson<T>(stateDir: string, name: string, fallback: T) {
  const file = path.join(stateDir, name);
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function saveJson(stateDir: string, name: string, value: unknown) {
  writeFileSync(
    path.join(stateDir, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function readBody(file?: string) {
  return file ? readFileSync(file, "utf8") : "";
}

function render(value: unknown, jq?: string) {
  let result = value;
  if (jq === ".url")
    result =
      typeof value === "object" && value
        ? ((value as { url?: string }).url ?? "")
        : "";
  if (jq === ".[0].number")
    result =
      Array.isArray(value) && value.length
        ? (value[0] as { number: number }).number
        : "";

  if (
    typeof result === "string" ||
    typeof result === "number" ||
    typeof result === "boolean"
  ) {
    process.stdout.write(`${result}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function getStateDir() {
  const stateDir = process.env.FORK_SYNC_GH_STATE_DIR;
  if (!stateDir)
    fail("FORK_SYNC_GH_STATE_DIR is required for the mock gh CLI.");
  return stateDir;
}

function listPrs(stateDir: string, argv: string[]) {
  const prs = loadJson<PullRequest[]>(stateDir, "prs.json", []);
  let state = "";
  let head = "";
  let base = "";
  let jq = "";

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--repo" || arg === "--json") {
      i += 2;
      continue;
    }
    if (arg === "--state") {
      state = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--head") {
      head = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--base") {
      base = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--jq") {
      jq = argv[i + 1];
      i += 2;
      continue;
    }
    fail(`Unsupported gh pr list argument: ${arg}`);
  }

  render(
    prs
      .filter((pr) => !state || pr.state === state)
      .filter((pr) => !head || pr.head === head)
      .filter((pr) => !base || pr.base === base)
      .map((pr) => ({
        baseRefName: pr.base,
        headRefName: pr.head,
        number: pr.number,
        state: pr.state,
        url: pr.url,
      })),
    jq || undefined,
  );
}

function editPr(stateDir: string, argv: string[]) {
  const prs = loadJson<PullRequest[]>(stateDir, "prs.json", []);
  const number = Number(argv.shift());
  const pr = prs.find((item) => item.number === number);
  if (!pr) fail(`PR #${number} was not found`);

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--repo") {
      i += 2;
      continue;
    }
    if (arg === "--title") {
      pr.title = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--body-file") {
      pr.body = readBody(argv[i + 1]);
      i += 2;
      continue;
    }
    if (arg === "--add-label") {
      const label = argv[i + 1];
      if (!pr.labels.includes(label)) pr.labels.push(label);
      i += 2;
      continue;
    }
    fail(`Unsupported gh pr edit argument: ${arg}`);
  }

  saveJson(stateDir, "prs.json", prs);
  render(pr.url);
}

function createPr(stateDir: string, argv: string[]) {
  const prs = loadJson<PullRequest[]>(stateDir, "prs.json", []);
  let base = "";
  let head = "";
  let title = "";
  let bodyFile = "";
  const labels: string[] = [];

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--repo") {
      i += 2;
      continue;
    }
    if (arg === "--base") {
      base = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--head") {
      head = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--title") {
      title = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--body-file") {
      bodyFile = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--label") {
      labels.push(argv[i + 1]);
      i += 2;
      continue;
    }
    fail(`Unsupported gh pr create argument: ${arg}`);
  }

  const existing = prs.find(
    (pr) => pr.head === head && pr.base === base && pr.state === "open",
  );
  if (existing) {
    render(existing.url);
    return;
  }

  const pr: PullRequest = {
    auto_merge: false,
    base,
    body: readBody(bodyFile),
    head,
    labels,
    merge_method: "",
    number: Math.max(0, ...prs.map((item) => item.number)) + 1,
    state: "open",
    title,
    url: `https://example.test/pulls/${Math.max(0, ...prs.map((item) => item.number)) + 1}`,
  };

  prs.push(pr);
  saveJson(stateDir, "prs.json", prs);
  render(pr.url);
}

function viewPr(stateDir: string, argv: string[]) {
  const prs = loadJson<PullRequest[]>(stateDir, "prs.json", []);
  const number = Number(argv.shift());
  const pr = prs.find((item) => item.number === number);
  if (!pr) fail(`PR #${number} was not found`);

  let jq = "";
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--repo" || arg === "--json") {
      i += 2;
      continue;
    }
    if (arg === "--jq") {
      jq = argv[i + 1];
      i += 2;
      continue;
    }
    fail(`Unsupported gh pr view argument: ${arg}`);
  }

  render({ url: pr.url }, jq || undefined);
}

function mergePr(stateDir: string, argv: string[]) {
  const prs = loadJson<PullRequest[]>(stateDir, "prs.json", []);
  const number = Number(argv.shift());
  const pr = prs.find((item) => item.number === number);
  if (!pr) fail(`PR #${number} was not found`);

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--repo") {
      i += 2;
      continue;
    }
    if (arg === "--auto") {
      pr.auto_merge = true;
      i += 1;
      continue;
    }
    if (arg === "--merge" || arg === "--squash" || arg === "--rebase") {
      pr.merge_method = arg.slice(2);
      i += 1;
      continue;
    }
    fail(`Unsupported gh pr merge argument: ${arg}`);
  }

  saveJson(stateDir, "prs.json", prs);
  render(pr.url);
}

function closePr(stateDir: string, argv: string[]) {
  const prs = loadJson<PullRequest[]>(stateDir, "prs.json", []);
  const number = Number(argv.shift());
  const pr = prs.find((item) => item.number === number);
  if (!pr) fail(`PR #${number} was not found`);

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === "--repo") {
      i += 2;
      continue;
    }
    if (arg === "--comment") {
      pr.comment = argv[i + 1];
      i += 2;
      continue;
    }
    fail(`Unsupported gh pr close argument: ${arg}`);
  }

  pr.state = "closed";
  saveJson(stateDir, "prs.json", prs);
  render(pr.url);
}

export function main(argv = process.argv.slice(2)) {
  const stateDir = getStateDir();
  const [command, ...rest] = argv;
  if (!command) fail("Expected a gh subcommand");

  if (command === "api") {
    const args = [...rest];
    const paginate = args[0] === "--paginate";
    if (paginate) args.shift();
    const endpoint = args.shift();
    if (!endpoint) fail("Missing API endpoint");

    const releases = loadJson<
      Array<{
        tag_name: string;
        html_url?: string;
        prerelease?: boolean;
        draft?: boolean;
      }>
    >(stateDir, "releases.json", []);
    if (endpoint.endsWith("/releases/latest")) {
      render(releases[0] ?? {});
      return;
    }
    if (endpoint.includes("/releases?per_page=100")) {
      render(releases);
      return;
    }
    fail(`Unsupported gh api endpoint: ${endpoint}`);
  }

  if (command === "pr") {
    const [subcommand, ...prArgs] = rest;
    if (!subcommand) fail("Expected a gh pr subcommand");
    if (subcommand === "list") return listPrs(stateDir, prArgs);
    if (subcommand === "create") return createPr(stateDir, prArgs);
    if (subcommand === "edit") return editPr(stateDir, [...prArgs]);
    if (subcommand === "view") return viewPr(stateDir, [...prArgs]);
    if (subcommand === "merge") return mergePr(stateDir, [...prArgs]);
    if (subcommand === "close") return closePr(stateDir, [...prArgs]);
    fail(`Unsupported gh pr subcommand: ${subcommand}`);
  }

  fail(`Unsupported gh command: ${command}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
