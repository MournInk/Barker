import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "barker-db-init-"));
after(() => rmSync(directory, { recursive: true, force: true }));

function startInitializer(): Promise<{ code: number | null; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "--eval",
      "import('./lib/db.ts').catch((error) => { console.error(error); process.exitCode = 1; });",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BARKER_DATA_DIR: directory },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.on("close", (code) => resolve({ code, error }));
  });
}

test("parallel process startup waits for SQLite schema initialization", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => startInitializer()));
  for (const result of results) assert.equal(result.code, 0, result.error);
});
