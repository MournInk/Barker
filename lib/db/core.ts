import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SETTINGS } from "../types";
import { initializeStorage, privateFile, runtimeDataDir } from "../storage";

const globalDb = globalThis as typeof globalThis & { barkerDb?: DatabaseSync };
const databaseFile = Buffer.from(`${runtimeDataDir}/barker.sqlite`);
const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
const retryWait = new Int32Array(new SharedArrayBuffer(4));
const CURRENT_SCHEMA_VERSION = 3;
let db: DatabaseSync;
let initialized = false;

export function transaction<T>(callback: () => T): T {
  initializeDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL, preset TEXT NOT NULL, cron TEXT NOT NULL,
      repeat_count INTEGER, end_date TEXT, sent_count INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT, last_run_at TEXT, last_error TEXT,
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), occurrence_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL, lease_until TEXT, last_error TEXT,
      created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(task_id, occurrence_at)
    );
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL, device_key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events(created_at);
    CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
      lease_token TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT NOT NULL, error TEXT
    );
    CREATE INDEX IF NOT EXISTS attempts_delivery_idx ON delivery_attempts(delivery_id, started_at DESC);
  `);
  const addColumn = (table: string, name: string, definition: string): boolean => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    return true;
  };
  const titleAdded = addColumn("deliveries", "title", "TEXT");
  const bodyAdded = addColumn("deliveries", "body", "TEXT");
  if (titleAdded || bodyAdded) {
    db.exec(`UPDATE deliveries SET title = COALESCE(title, (SELECT name FROM tasks WHERE id = task_id)),
      body = COALESCE(body, (SELECT description FROM tasks WHERE id = task_id));
      ${titleAdded ? "UPDATE deliveries SET attempts = attempts + 1 WHERE status = 'sent';" : ""}`);
  }
  if (addColumn("tasks", "queued_count", "INTEGER NOT NULL DEFAULT 0")) {
    db.exec("UPDATE tasks SET queued_count = (SELECT COUNT(*) FROM deliveries WHERE task_id = tasks.id)");
  }
  addColumn("tasks", "revision", "INTEGER NOT NULL DEFAULT 1");
  addColumn("tasks", "time_zone", "TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
  addColumn("tasks", "max_lateness_minutes", "INTEGER");
  if (addColumn("tasks", "paused_at", "TEXT")) db.exec("UPDATE tasks SET paused_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) WHERE status = 'paused'");
  addColumn("tasks", "resume_at", "TEXT");
  addColumn("deliveries", "expires_at", "TEXT");
  addColumn("deliveries", "manual_only", "INTEGER NOT NULL DEFAULT 0");
  addColumn("tasks", "last_queued_at", "TEXT");
  addColumn("tasks", "device_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumn("tasks", "notification", "TEXT NOT NULL DEFAULT '{}'");
  addColumn("tasks", "skip_dates", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("tasks", "include_dates", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("deliveries", "device_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumn("deliveries", "notification", "TEXT NOT NULL DEFAULT '{}'");
  if (addColumn("deliveries", "activity_at", "TEXT")) db.exec("UPDATE deliveries SET activity_at = COALESCE(delivered_at, created_at)");
  db.exec(`
    CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(status, next_run_at);
    CREATE INDEX IF NOT EXISTS tasks_pause_idx ON tasks(paused_at, next_run_at);
    CREATE INDEX IF NOT EXISTS deliveries_pending_idx ON deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS deliveries_pending_occurrence_idx ON deliveries(status, manual_only, next_attempt_at, occurrence_at, created_at, id);
    CREATE INDEX IF NOT EXISTS deliveries_lease_idx ON deliveries(status, lease_until, id);
    CREATE INDEX IF NOT EXISTS deliveries_task_status_idx ON deliveries(task_id, status);
    CREATE INDEX IF NOT EXISTS deliveries_task_error_idx ON deliveries(task_id, activity_at DESC)
      WHERE status IN ('pending', 'sending') AND last_error IS NOT NULL;
    CREATE INDEX IF NOT EXISTS deliveries_activity_idx ON deliveries(activity_at DESC);
    CREATE INDEX IF NOT EXISTS deliveries_sent_idx ON deliveries(status, delivered_at);
    CREATE INDEX IF NOT EXISTS deliveries_expiry_idx ON deliveries(status, expires_at);
  `);
  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  insert.run("default", JSON.stringify(DEFAULT_SETTINGS));
  insert.run("revision", "1");
  db.exec(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION}`);
}

export function initializeDatabase(): void {
  if (initialized) return;
  initializeStorage();
  db = globalDb.barkerDb ?? new DatabaseSync(databaseFile);
  db.exec("PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
  initialized = true;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        db.exec("PRAGMA journal_mode=WAL;");
        const { user_version: existingVersion } = db.prepare("PRAGMA user_version").get() as { user_version: number };
        if (existingVersion > CURRENT_SCHEMA_VERSION) throw new Error(`Database schema ${existingVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`);
        transaction(migrate);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/database is locked|database schema is locked/i.test(error.message) || attempt === 99) throw error;
        Atomics.wait(retryWait, 0, 0, 100);
      }
    }
    globalDb.barkerDb = db;
    for (const suffix of ["", "-wal", "-shm"]) privateFile(`${databaseFile.toString()}${suffix}`);
  } catch (error) {
    initialized = false;
    statements.clear();
    delete globalDb.barkerDb;
    db.close();
    throw error;
  }
}

export function statement(sql: string) {
  initializeDatabase();
  let prepared = statements.get(sql);
  if (!prepared) { prepared = db.prepare(sql); statements.set(sql, prepared); }
  return prepared;
}

export function connection(): DatabaseSync { initializeDatabase(); return db; }
export function dataDirectory(): string { return runtimeDataDir; }
export function databasePath(): string { return databaseFile.toString(); }
