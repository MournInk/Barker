import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/verify-standalone.mjs");

function check(files) {
  const directory = mkdtempSync(join(tmpdir(), "barker-artifact-"));
  try {
    const root = join(directory, ".next/standalone");
    mkdirSync(join(root, "data"), { recursive: true });
    for (const file of files) writeFileSync(join(root, file), "synthetic fixture");
    return spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("standalone verification accepts runtime code without private state", () => {
  assert.equal(check(["server.js"]).status, 0);
});

test("standalone verification rejects databases, WAL, keys and environment files", () => {
  for (const file of ["data/barker.sqlite", "data/barker.sqlite-wal", "data/access-password.txt", "data/session-secret.txt", ".env.local"]) {
    const result = check([file]);
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, /Runtime data must not be included/);
  }
});
