import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rules = [
  [/^lib\/auth\.ts$|^app\/api\/session\//, ["auth", "api"]],
  [/^lib\/bark\.ts$|^app\/api\/settings\/test\//, ["bark", "scheduler", "workflow"]],
  [/^lib\/cron\.ts$/, ["cron", "validation", "scheduler", "workflow", "api", "persistence"]],
  [/^lib\/db\.ts$/, ["db-init", "scheduler", "workflow", "api", "persistence"]],
  [/^lib\/types\.ts$/, ["cron", "validation", "scheduler", "workflow", "api"]],
  [/^lib\/validation\.ts$/, ["validation", "api", "workflow"]],
  [/^lib\/http\.ts$|^app\/api\//, ["http", "api"]],
  [/^lib\/scheduler\.ts$|^instrumentation\.ts$/, ["scheduler", "workflow", "persistence"]],
  [/^scripts\/ci-scope\.mjs$|^\.github\/workflows\/ci\.yml$/, ["ci-scope"]],
  [/^scripts\/verify-standalone\.mjs$|^next\.config\.ts$/, ["artifact"]],
  [/^package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$/, ["auth", "bark", "cron", "validation", "http", "db-init", "scheduler", "workflow", "api", "persistence"]],
];

/** Select owning test modules and integration checks; never default to a global suite. */
export function selectChecks(files) {
  const tests = new Set();
  for (const file of files) {
    for (const [pattern, names] of rules) {
      if (pattern.test(file)) names.forEach((name) => tests.add(`tests/${name}.test.${["artifact", "ci-scope"].includes(name) ? "mjs" : "ts"}`));
    }
    if (/^tests\/[^/]+\.test\.(ts|mjs)$/.test(file)) tests.add(file);
  }
  const source = files.some((file) => /^(app\/|components\/|lib\/|scripts\/verify-standalone\.mjs$|instrumentation\.ts$|next\.config\.ts$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig\.json$|postcss\.config\.mjs$|eslint\.config\.mjs$)/.test(file));
  const container = files.some((file) => /^(Dockerfile$|\.dockerignore$|docker-compose\.yml$|scripts\/(container-smoke|verify-standalone)\.mjs$|instrumentation\.ts$|next\.config\.ts$|lib\/(auth|bark|cron|db|http|scheduler|types|validation)\.ts$|app\/api\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)/.test(file));
  return { tests: [...tests].sort(), source, container };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const [baseInput, head, event] = process.argv.slice(2);
  if (!head || !baseInput) throw new Error("A concrete base and head are required");
  git("rev-parse", "--verify", `${head}^{commit}`);
  let base = /^0+$/.test(baseInput) ? "origin/main" : baseInput;
  git("rev-parse", "--verify", `${base}^{commit}`);
  if (event === "pull_request" || /^0+$/.test(baseInput)) base = git("merge-base", base, head);
  const files = git("diff", "--name-only", "--no-renames", "-z", base, head).split("\0").filter(Boolean);
  const checks = selectChecks(files);
  // Deleted test modules still affect owners but cannot be executed themselves.
  const tree = new Set(git("ls-tree", "-r", "--name-only", head).split("\n"));
  checks.tests = checks.tests.filter((file) => tree.has(file));
  console.log(JSON.stringify({ base, head, files, ...checks }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `tests=${JSON.stringify(checks.tests)}\nsource=${checks.source}\ncontainer=${checks.container}\n`);
  }
}
