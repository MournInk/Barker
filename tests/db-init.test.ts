import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "barker-db-init-"));
after(() => rmSync(directory, { recursive: true, force: true }));

function startInitializer(dataDirectory = directory): Promise<{ code: number | null; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "--eval",
      "import('./lib/db.ts').then((db) => { db.initializeDatabase(); process.exit(0); }).catch((error) => { console.error(error); process.exit(1); });",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, BARKER_DATA_DIR: dataDirectory },
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

test("importing server modules creates no database, directories or secrets", () => {
  const missing = join(directory, "import-only");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", "Promise.all([import('./lib/db.ts'), import('./lib/auth.ts'), import('./lib/scheduler.ts')])"], {
    cwd: process.cwd(), env: { ...process.env, BARKER_DATA_DIR: missing }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(missing), false);
});

test("an older application refuses to downgrade a newer database schema", async () => {
  const newerDirectory = mkdtempSync(join(tmpdir(), "barker-newer-schema-"));
  try {
    const database = new DatabaseSync(join(newerDirectory, "barker.sqlite"));
    database.exec("PRAGMA user_version = 99");
    database.close();
    const result = await startInitializer(newerDirectory);
    assert.notEqual(result.code, 0);
    assert.match(result.error, /newer than supported/);
    const inspect = new DatabaseSync(join(newerDirectory, "barker.sqlite"), { readOnly: true });
    assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 99);
    inspect.close();
  } finally {
    rmSync(newerDirectory, { recursive: true, force: true });
  }
});

test("a migration failure leaves a shared connection open", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    const connection = new DatabaseSync(':memory:');
    connection.exec('PRAGMA user_version=99');
    globalThis.barkerDb = connection;
    const { initializeDatabase } = await import('./lib/db.ts');
    assert.throws(initializeDatabase, /newer than supported/);
    assert.equal(globalThis.barkerDb, connection);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 99);
    connection.close();
  `], { env: { ...process.env, BARKER_DATA_DIR: directory }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("startup tightens existing data directory and database permissions", async () => {
  const existing = mkdtempSync(join(tmpdir(), "barker-permissions-"));
  try {
    const path = join(existing, "barker.sqlite");
    const database = new DatabaseSync(path);
    database.close();
    chmodSync(existing, 0o755); chmodSync(path, 0o644);
    const result = await startInitializer(existing);
    assert.equal(result.code, 0, result.error);
    assert.equal(statSync(existing).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(existing, { recursive: true, force: true }); }
});
