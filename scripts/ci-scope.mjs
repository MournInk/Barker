import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rules = [
  [/^lib\/auth\.ts$|^app\/api\/session\//, ["auth", "api"]],
  [/^lib\/(errors|storage)\.ts$/, ["auth", "bark", "db-init", "scheduler", "workflow", "api", "persistence", "shutdown"]],
  [/^lib\/(ui|resource)\.ts$|^components\/use-resource\.ts$/, ["ui"]],
  [/^app\/(?!api\/)|^components\//, ["ui"]],
  [/^lib\/bark\.ts$|^app\/api\/settings\/test\//, ["bark", "scheduler", "workflow"]],
  [/^lib\/cron\.ts$/, ["cron", "validation", "scheduler", "workflow", "api", "persistence"]],
  [/^lib\/db(?:\.ts|\/)/, ["auth", "db-init", "scheduler", "workflow", "api", "persistence", "shutdown", "data-tools", "repairs"]],
  [/^lib\/types\.ts$/, ["bark", "cron", "validation", "scheduler", "workflow", "api", "ui", "data-tools", "repairs", "db-init", "persistence"]],
  [/^lib\/(contracts|logging)\.ts$/, ["http", "api", "ui", "auth", "repairs"]],
  [/^lib\/validation\.ts$/, ["validation", "api", "workflow"]],
  [/^lib\/http\.ts$|^app\/api\//, ["http", "api"]],
  [/^lib\/scheduler\.ts$|^instrumentation\.ts$/, ["scheduler", "workflow", "persistence", "shutdown"]],
  [/^scripts\/ci-scope\.mjs$|^\.github\/workflows\/ci\.yml$/, ["ci-scope", "release"]],
  [/^scripts\/release-guard\.mjs$|^\.github\/workflows\/release\.yml$/, ["release", "ci-scope"]],
  [/^scripts\/data-tools\.mjs$/, ["data-tools"]],
  [/^scripts\/(runtime-paths|build-preflight)\.mjs$/, ["data-tools", "artifact", "shutdown", "db-init"]],
  [/^scripts\/start-server\.mjs$/, ["scheduler", "workflow", "persistence", "shutdown"]],
  [/^scripts\/browser-server\.mjs$/, ["shutdown"]],
  [/^scripts\/verify-standalone\.mjs$|^next\.config\.ts$/, ["artifact"]],
  [/^package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$/, ["auth", "bark", "cron", "validation", "http", "ui", "db-init", "scheduler", "workflow", "api", "persistence", "release", "data-tools", "shutdown"]],
];

/** Select owning test modules and integration checks; never default to a global suite. */
export function selectChecks(files) {
  const tests = new Set();
  for (const file of files) {
    if (/^lib\//.test(file) && !rules.some(([pattern]) => pattern.test(file))) {
      for (const name of ["api", "scheduler", "workflow", "persistence", "repairs"]) tests.add(`tests/${name}.test.ts`);
    }
    for (const [pattern, names] of rules) {
      if (pattern.test(file)) names.forEach((name) => tests.add(`tests/${name}.test.${["artifact", "ci-scope", "release", "data-tools", "shutdown"].includes(name) ? "mjs" : "ts"}`));
    }
    if (/^tests\/[^/]+\.test\.(ts|mjs)$/.test(file)) tests.add(file);
  }
  const source = files.some((file) => /^(app\/|components\/|lib\/|scripts\/verify-standalone\.mjs$|instrumentation\.ts$|next\.config\.ts$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig\.json$|postcss\.config\.mjs$|eslint\.config\.mjs$)/.test(file));
  const container = files.some((file) => /^(Dockerfile$|\.dockerignore$|docker-compose\.yml$|scripts\/(container-smoke|verify-standalone|start-server|data-tools)\.mjs$|instrumentation\.ts$|next\.config\.ts$|lib\/(auth|bark|cron|db|errors|http|scheduler|storage|types|validation)\.ts$|app\/api\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)/.test(file));
  const browser = files.some((file) => /^(app\/|components\/|lib\/(ui|resource|types)\.ts$|tests\/browser\/|playwright\.config\.ts$|scripts\/browser-server\.mjs$|package\.json$|pnpm-lock\.yaml$)/.test(file));
  return { tests: [...tests].sort(), source, container, browser };
}

export function resolveDiffBase(baseInput, head, event, git) {
  const initialPush = /^0+$/.test(baseInput);
  let base = initialPush ? "origin/main" : baseInput;
  let useMergeBase = initialPush || event === "pull_request" || event === "merge_group";
  const resolves = (revision) => {
    try { git("rev-parse", "--verify", `${revision}^{commit}`); return true; }
    catch { return false; }
  };
  if (!resolves(base)) {
    if (event !== "push") throw new Error(`Diff baseline ${base} is unavailable`);
    base = "origin/main";
    useMergeBase = true;
    if (!resolves(base)) throw new Error("Push baseline is unavailable and origin/main cannot be resolved");
  }
  return useMergeBase ? git("merge-base", base, head) : base;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const [baseInput, head, event] = process.argv.slice(2);
  if (!head || !baseInput) throw new Error("A concrete base and head are required");
  git("rev-parse", "--verify", `${head}^{commit}`);
  const base = resolveDiffBase(baseInput, head, event, git);
  const files = git("diff", "--name-only", "--no-renames", "-z", base, head).split("\0").filter(Boolean);
  const checks = selectChecks(files);
  // Deleted test modules still affect owners but cannot be executed themselves.
  const tree = new Set(git("ls-tree", "-r", "--name-only", head).split("\n"));
  checks.tests = checks.tests.filter((file) => tree.has(file));
  console.log(JSON.stringify({ base, head, files, ...checks }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `tests=${JSON.stringify(checks.tests)}\nsource=${checks.source}\ncontainer=${checks.container}\nbrowser=${checks.browser}\n`);
  }
}
