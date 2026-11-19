import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDiffBase, selectChecks } from "../scripts/ci-scope.mjs";

test("missing push baselines fall back to the current main merge base", () => {
  const git = (...args) => {
    if (args[0] === "merge-base") return `${args[1]}..${args[2]}`;
    const revision = args[2].replace(/\^\{commit\}$/, "");
    if (!new Set(["origin/main", "head"]).has(revision)) throw new Error(`unknown revision ${revision}`);
    return revision;
  };
  assert.equal(resolveDiffBase("removed-sha", "head", "push", git), "origin/main..head");
  assert.throws(() => resolveDiffBase("removed-sha", "head", "pull_request", git), /baseline removed-sha is unavailable/);
});

test("database changes verify backups and new server modules receive owning checks", () => {
  assert.ok(selectChecks(["lib/db.ts"]).tests.includes("tests/data-tools.test.mjs"));
  assert.ok(selectChecks(["lib/new-module.ts"]).tests.includes("tests/api.test.ts"));
});

test("UI-only changes build the app without running backend suites", () => {
  assert.deepEqual(selectChecks(["components/nav.tsx", "app/globals.css"]), { tests: ["tests/ui.test.ts"], source: true, container: false, browser: true });
});

test("scheduler changes select owning workflows and restart tests", () => {
  assert.deepEqual(selectChecks(["lib/scheduler.ts"]), {
    tests: ["tests/persistence.test.ts", "tests/scheduler.test.ts", "tests/shutdown.test.mjs", "tests/workflow.test.ts"],
    source: true,
    container: true,
    browser: false,
  });
});

test("API changes select contract tests and container smoke", () => {
  const checks = selectChecks(["app/api/tasks/route.ts"]);
  assert.deepEqual(checks.tests, ["tests/api.test.ts", "tests/http.test.ts"]);
  assert.equal(checks.source, true);
  assert.equal(checks.container, true);
});

test("shared types select every importing test owner", () => {
  assert.deepEqual(selectChecks(["lib/types.ts"]), {
    tests: ["tests/api.test.ts", "tests/bark.test.ts", "tests/cron.test.ts", "tests/data-tools.test.mjs", "tests/db-init.test.ts", "tests/persistence.test.ts", "tests/repairs.test.ts", "tests/scheduler.test.ts", "tests/ui.test.ts", "tests/validation.test.ts", "tests/workflow.test.ts"],
    source: true,
    container: true,
    browser: true,
  });
});

test("documentation-only changes do not trigger unrelated application checks", () => {
  assert.deepEqual(selectChecks(["README.md", "AGENTS.md"]), { tests: [], source: false, container: false, browser: false });
});

test("release workflow changes trigger release and selector tests", () => {
  assert.deepEqual(selectChecks([".github/workflows/release.yml"]).tests, ["tests/ci-scope.test.mjs", "tests/release.test.mjs"]);
});

test("runtime storage and browser launch changes trigger their end-to-end checks", () => {
  assert.equal(selectChecks(["lib/storage.ts"]).container, true);
  assert.equal(selectChecks(["scripts/browser-server.mjs"]).browser, true);
  assert.deepEqual(selectChecks(["scripts/browser-server.mjs"]).tests, ["tests/shutdown.test.mjs"]);
});

test("build and runtime helpers select production builds and container smoke", () => {
  for (const file of ["scripts/runtime-paths.mjs", "scripts/build-preflight.mjs", "lib/db/core.ts", "lib/logging.ts"]) {
    const checks = selectChecks([file]);
    assert.equal(checks.source, true, file);
    assert.equal(checks.container, true, file);
  }
  for (const file of ["lib/contracts.ts", "proxy.ts", "next.config.ts"]) {
    const checks = selectChecks([file]);
    assert.equal(checks.container, true, file);
    assert.equal(checks.browser, true, file);
  }
});

test("added tests and CI selector changes are checked directly", () => {
  assert.deepEqual(selectChecks(["tests/cron.test.ts", "scripts/ci-scope.mjs"]).tests, ["tests/ci-scope.test.mjs", "tests/cron.test.ts", "tests/release.test.mjs"]);
});
