import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backupData, restoreData } from "../scripts/data-tools.mjs";

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "barker-data-tools-"));
  const source = join(root, "source");
  mkdirSync(source);
  const database = new DatabaseSync(join(source, "barker.sqlite"));
  database.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY);
    CREATE TABLE deliveries (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id));
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('default', '{}');
    INSERT INTO tasks VALUES ('task');
    INSERT INTO deliveries VALUES ('delivery', 'task');
    INSERT INTO sessions VALUES ('session');
    INSERT INTO runtime_state VALUES ('scheduler_heartbeat', '1');
  `);
  database.close();
  writeFileSync(join(source, "access-password.txt"), "test-data-tools-password", { mode: 0o644 });
  writeFileSync(join(source, "session-secret.txt"), "test-data-tools-session-secret", { mode: 0o644 });
  return { root, source };
}

test("backup and restore are checksummed, private, and never overwrite data", async () => {
  const { root, source } = fixture();
  const backup = join(root, "backup");
  const restored = join(root, "restored");
  try {
    const result = await backupData(source, backup);
    assert.equal(result.schemaVersion, 2);
    assert.deepEqual(result.files, ["barker.sqlite", "access-password.txt", "session-secret.txt"]);
    assert.equal(statSync(backup).mode & 0o777, 0o700);
    for (const file of ["barker.sqlite", "access-password.txt", "session-secret.txt", "manifest.json"]) assert.equal(statSync(join(backup, file)).mode & 0o777, 0o600);
    await assert.rejects(backupData(source, backup), /already exists/);
    await restoreData(backup, restored);
    assert.equal(statSync(restored).mode & 0o777, 0o700);
    for (const file of ["barker.sqlite", "access-password.txt", "session-secret.txt", "manifest.json"]) assert.equal(statSync(join(restored, file)).mode & 0o777, 0o600);
    const manifest = JSON.parse(readFileSync(join(restored, "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    for (const [name, checksum] of Object.entries(manifest.files)) assert.equal(checksum, digest(join(restored, name)));
    const database = new DatabaseSync(join(restored, "barker.sqlite"), { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) count FROM tasks").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) count FROM deliveries").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) count FROM sessions").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) count FROM runtime_state").get().count, 0);
    database.close();
    await assert.rejects(restoreData(backup, restored), /new data directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restore rejects tampered backup content", async () => {
  const { root, source } = fixture();
  const backup = join(root, "backup");
  try {
    await backupData(source, backup);
    writeFileSync(join(backup, "access-password.txt"), "tampered");
    await assert.rejects(restoreData(backup, join(root, "restored")), /checksum/);
    rmSync(join(root, "restored"), { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restore rejects unexpected files in a valid backup", async () => {
  const { root, source } = fixture();
  const backup = join(root, "backup");
  const target = join(root, "restored");
  try {
    await backupData(source, backup);
    writeFileSync(join(backup, "unexpected.txt"), "extra");
    await assert.rejects(restoreData(backup, target), /unexpected files/);
    assert.equal(existsSync(target), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backup and restore refuse targets nested inside their source", async () => {
  const { root, source } = fixture();
  const backup = join(root, "backup");
  try {
    await assert.rejects(backupData(source, join(source, "backup")), /outside the source/);
    await assert.rejects(backupData(source, join(source, "..cache")), /outside the source/);
    await backupData(source, backup);
    await assert.rejects(restoreData(backup, join(backup, "restored")), /outside the backup/);
    await assert.rejects(restoreData(backup, join(backup, "..cache")), /outside the backup/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backup CLI refuses an existing target", () => {
  const { root, source } = fixture();
  const target = join(root, "backup");
  mkdirSync(target);
  try {
    const result = spawnSync(process.execPath, ["scripts/data-tools.mjs", "backup", target, source], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
    assert.equal(existsSync(join(target, "manifest.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a live WAL database produces a portable backup without sidecars", async () => {
  const { root, source } = fixture();
  const live = new DatabaseSync(join(source, "barker.sqlite"));
  try {
    live.exec("PRAGMA journal_mode=WAL; INSERT INTO tasks VALUES ('uncheckpointed');");
    assert.equal(existsSync(join(source, "barker.sqlite-wal")), true);
    await backupData(source, join(root, "snapshot"));
    for (const suffix of ["-wal", "-shm"]) assert.equal(existsSync(join(root, "snapshot", `barker.sqlite${suffix}`)), false);
    await restoreData(join(root, "snapshot"), join(root, "restore"));
    const restored = new DatabaseSync(join(root, "restore", "barker.sqlite"));
    assert.equal(restored.prepare("SELECT COUNT(*) count FROM tasks").get().count, 2);
    restored.close();
  } finally { live.close(); rmSync(root, { recursive: true, force: true }); }
});
