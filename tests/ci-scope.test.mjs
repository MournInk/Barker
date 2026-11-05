import assert from "node:assert/strict";
import { test } from "node:test";
import { selectChecks } from "../scripts/ci-scope.mjs";

test("UI-only changes build the app without running backend suites", () => {
  assert.deepEqual(selectChecks(["components/nav.tsx", "app/globals.css"]), { tests: [], source: true, container: false });
});

test("scheduler changes select owning workflows and restart tests", () => {
  assert.deepEqual(selectChecks(["lib/scheduler.ts"]).tests, ["tests/persistence.test.ts", "tests/scheduler.test.ts", "tests/workflow.test.ts"]);
});

test("API changes select contract tests and container smoke", () => {
  const checks = selectChecks(["app/api/tasks/route.ts"]);
  assert.deepEqual(checks.tests, ["tests/api.test.ts", "tests/http.test.ts"]);
  assert.equal(checks.container, true);
});

test("documentation-only changes do not trigger unrelated application checks", () => {
  assert.deepEqual(selectChecks(["README.md", "AGENTS.md"]), { tests: [], source: false, container: false });
});

test("added tests and CI selector changes are checked directly", () => {
  assert.deepEqual(selectChecks(["tests/cron.test.ts", "scripts/ci-scope.mjs"]).tests, ["tests/ci-scope.test.mjs", "tests/cron.test.ts"]);
});
