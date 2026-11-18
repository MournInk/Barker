import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function run(directory: string, code: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    cwd: process.cwd(), env: { ...process.env, BARKER_DATA_DIR: directory }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function createLegacyDatabase(directory: string, failAtMigrationIndex = false): DatabaseSync {
  const legacy = new DatabaseSync(join(directory, "barker.sqlite"));
  legacy.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('default', '{}');
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL, preset TEXT NOT NULL, cron TEXT NOT NULL,
      repeat_count INTEGER, end_date TEXT, sent_count INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT, last_run_at TEXT, last_error TEXT,
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX tasks_due_idx ON tasks(status, next_run_at);
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), occurrence_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL, lease_until TEXT, last_error TEXT,
      created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(task_id, occurrence_at)
    );
    CREATE INDEX deliveries_pending_idx ON deliveries(status, next_attempt_at);
    CREATE INDEX deliveries_task_idx ON deliveries(task_id, created_at DESC);
  `);
  if (failAtMigrationIndex) legacy.exec("CREATE VIEW delivery_attempts AS SELECT 1 AS id;");
  return legacy;
}

test("failed immutable outbox survives process restart and is subsequently delivered", () => {
  const directory = mkdtempSync(join(tmpdir(), "barker-restart-"));
  try {
    const first = run(directory, `
      const db = await import('./lib/db.ts');
      const scheduler = await import('./lib/scheduler.ts');
      const task = db.createTask({ name:'Persistent', description:'Original', startsAt:'2030-11-01T01:00:00Z', preset:'daily', cron:'0 9 * * *', repeatCount:1 }, new Date('2030-10-31T00:00:00Z'));
      await scheduler.enqueueDueOccurrences(new Date('2030-11-01T01:00:00Z'));
      await scheduler.processOneDelivery(new Date('2030-11-01T01:00:00Z'), async () => { throw new Error('offline'); });
      console.log(JSON.stringify({ id: task.id, pending: db.deliverySummary().pending }));
    `);
    assert.equal(first.pending, 1);
    const second = run(directory, `
      const db = await import('./lib/db.ts');
      const scheduler = await import('./lib/scheduler.ts');
      await scheduler.processOneDelivery(new Date('2030-11-01T02:00:00Z'), async (_, title, body) => { if(title !== 'Persistent' || body !== 'Original') throw new Error('payload changed'); });
      console.log(JSON.stringify({ pending: db.deliverySummary().pending, item: db.listDeliveries({ page:1, pageSize:10 }).deliveries[0] }));
    `);
    assert.equal(second.pending, 0);
    assert.equal((second.item as { status: string }).status, "sent");
    assert.equal((second.item as { attempts: number }).attempts, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy outbox migration is atomic, payload-preserving, and idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "barker-migration-"));
  try {
    const legacy = createLegacyDatabase(directory);
    legacy.exec(`
      INSERT INTO tasks (id, name, description, starts_at, preset, cron, status, created_at, updated_at)
        VALUES ('old', 'Legacy name', 'Legacy body', '2020-01-01T00:00:00.000Z', 'once', '0 9 * * *', 'completed', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
      INSERT INTO deliveries (id, task_id, occurrence_at, status, attempts, next_attempt_at, created_at, delivered_at)
        VALUES ('sent', 'old', '2020-01-01T00:00:00.000Z', 'sent', 2, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z'),
          ('pending', 'old', '2020-01-02T00:00:00.000Z', 'pending', 3, '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z', NULL);
    `);
    legacy.close();
    const inspect = `
      const db = await import('./lib/db.ts');
      console.log(JSON.stringify({ items: db.listDeliveries({ page:1, pageSize:10 }).deliveries }));
    `;
    const first = run(directory, inspect);
    const beforeDelivery = first.items as Array<{ id: string; status: string; attempts: number; taskName: string; description: string }>;
    assert.equal(beforeDelivery.find((item) => item.id === "sent")?.attempts, 3);
    assert.equal(beforeDelivery.find((item) => item.id === "pending")?.status, "pending");
    assert.ok(beforeDelivery.every((item) => item.taskName === "Legacy name" && item.description === "Legacy body"));
    const second = run(directory, `
      const db = await import('./lib/db.ts');
      const scheduler = await import('./lib/scheduler.ts');
      let payload;
      await scheduler.processOneDelivery(new Date(), async (_, title, body) => { payload = { title, body }; });
      const items = db.listDeliveries({ page:1, pageSize:10 }).deliveries;
      console.log(JSON.stringify({ items, payload, pending: db.deliverySummary().pending, sentCount: db.getTask('old').sentCount }));
    `);
    const items = second.items as Array<{ id: string; status: string; attempts: number }>;
    assert.deepEqual(second.payload, { title: "Legacy name", body: "Legacy body" });
    assert.equal(items.find((item) => item.id === "sent")?.attempts, 3, "restarting migration must not alter the sent row again");
    assert.equal(items.find((item) => item.id === "pending")?.status, "sent");
    assert.equal(items.find((item) => item.id === "pending")?.attempts, 4);
    assert.equal(second.pending, 0);
    assert.equal(second.sentCount, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed legacy migration rolls back schema changes and row updates", () => {
  const directory = mkdtempSync(join(tmpdir(), "barker-migration-rollback-"));
  try {
    const legacy = createLegacyDatabase(directory, true);
    legacy.exec(`
      INSERT INTO tasks (id, name, description, starts_at, preset, cron, status, created_at, updated_at)
        VALUES ('old', 'Legacy name', 'Legacy body', '2020-01-01T00:00:00.000Z', 'once', '0 9 * * *', 'completed', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
      INSERT INTO deliveries (id, task_id, occurrence_at, status, attempts, next_attempt_at, created_at)
        VALUES ('pending', 'old', '2020-01-02T00:00:00.000Z', 'pending', 3, '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
    `);
    legacy.close();

    const failed = run(directory, `
      try { const db = await import('./lib/db.ts'); db.initializeDatabase(); console.log(JSON.stringify({ error: null })); }
      catch (error) { console.log(JSON.stringify({ error: error.message })); }
    `);
    assert.match(failed.error as string, /views may not be indexed/i);

    const inspect = new DatabaseSync(join(directory, "barker.sqlite"), { readOnly: true });
    try {
      assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 0);
      assert.deepEqual(
        (inspect.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>).map((column) => column.name),
        ["id", "task_id", "occurrence_at", "status", "attempts", "next_attempt_at", "lease_until", "last_error", "created_at", "delivered_at"],
      );
      assert.deepEqual({ ...inspect.prepare("SELECT id, status, attempts, next_attempt_at, created_at FROM deliveries").get() }, {
        id: "pending", status: "pending", attempts: 3, next_attempt_at: "2020-01-02T00:00:00.000Z", created_at: "2020-01-02T00:00:00.000Z",
      });
      assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_state'").get()?.count, 0);
    } finally { inspect.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("partially migrated outbox adds body without overwriting the stored title snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "barker-partial-migration-"));
  try {
    const legacy = new DatabaseSync(join(directory, "barker.sqlite"));
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT, description TEXT, starts_at TEXT, preset TEXT, cron TEXT,
        repeat_count INTEGER, end_date TEXT, sent_count INTEGER DEFAULT 0, next_run_at TEXT, last_run_at TEXT,
        last_error TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), occurrence_at TEXT,
        status TEXT, attempts INTEGER, next_attempt_at TEXT, lease_until TEXT, last_error TEXT, created_at TEXT,
        delivered_at TEXT, title TEXT, UNIQUE(task_id, occurrence_at));
      INSERT INTO tasks (id, name, description, status) VALUES ('partial', 'Current name', 'Current body', 'active');
      INSERT INTO deliveries (id, task_id, occurrence_at, status, attempts, next_attempt_at, created_at, title)
        VALUES ('delivery', 'partial', '2030-01-01T00:00:00Z', 'pending', 0, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z', 'Stored snapshot');
    `);
    legacy.close();
    const result = run(directory, "const db = await import('./lib/db.ts'); console.log(JSON.stringify(db.listDeliveries({ page:1, pageSize:10 }).deliveries[0]));");
    assert.equal(result.taskName, "Stored snapshot");
    assert.equal(result.description, "Current body");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy paused tasks receive a safe pause cursor and queued counter", () => {
  const directory = mkdtempSync(join(tmpdir(), "barker-paused-migration-"));
  try {
    const legacy = new DatabaseSync(join(directory, "barker.sqlite"));
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL,
        preset TEXT NOT NULL, cron TEXT NOT NULL, repeat_count INTEGER, end_date TEXT, sent_count INTEGER DEFAULT 0,
        next_run_at TEXT, last_run_at TEXT, last_error TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), occurrence_at TEXT NOT NULL,
        status TEXT, attempts INTEGER, next_attempt_at TEXT, lease_until TEXT, last_error TEXT, created_at TEXT, delivered_at TEXT,
        UNIQUE(task_id, occurrence_at));
      INSERT INTO tasks (id, name, starts_at, preset, cron, next_run_at, status, created_at, updated_at)
        VALUES ('paused', 'Paused', '2030-01-01T00:00:00Z', 'daily', '0 9 * * *', '2030-01-02T01:00:00Z', 'paused', '2030-01-01T00:00:00Z', '2030-01-03T00:00:00Z');
      INSERT INTO deliveries (id, task_id, occurrence_at, status, attempts, next_attempt_at, created_at)
        VALUES ('old', 'paused', '2030-01-02T01:00:00Z', 'sent', 1, '2030-01-02T01:00:00Z', '2030-01-02T01:00:00Z');
    `);
    legacy.close();
    const result = run(directory, "const db = await import('./lib/db.ts'); console.log(JSON.stringify(db.getTask('paused')));");
    assert.equal(result.pausedAt, "2030-01-03T00:00:00.000Z");
    assert.equal(result.queuedCount, 1);
    assert.equal((result as { revision: number }).revision, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("resuming a legacy pause drains all 220 unqueued occurrences before skipping paused time", () => {
  const directory = mkdtempSync(join(tmpdir(), "barker-legacy-backlog-"));
  try {
    const legacy = new DatabaseSync(join(directory, "barker.sqlite"));
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL,
        preset TEXT NOT NULL, cron TEXT NOT NULL, repeat_count INTEGER, end_date TEXT, sent_count INTEGER NOT NULL DEFAULT 0,
        next_run_at TEXT, last_run_at TEXT, last_error TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), occurrence_at TEXT NOT NULL,
        status TEXT, attempts INTEGER, next_attempt_at TEXT, lease_until TEXT, last_error TEXT, created_at TEXT, delivered_at TEXT,
        title TEXT, body TEXT, UNIQUE(task_id, occurrence_at));
      INSERT INTO tasks (id, name, starts_at, preset, cron, repeat_count, next_run_at, last_run_at, status, created_at, updated_at)
        VALUES ('paused', 'Legacy backlog', '2030-01-01T00:01:00.000Z', 'custom', '* * * * *', 100000,
          '2030-01-01T08:21:00.000Z', '2030-01-01T08:20:00.000Z', 'paused', '2030-01-01T00:00:00.000Z', '2030-01-01T12:00:00.000Z');
      WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 500)
        INSERT INTO deliveries (id, task_id, occurrence_at, status, attempts, next_attempt_at, created_at, title, body)
        SELECT 'delivery-' || value, 'paused', strftime('%Y-%m-%dT%H:%M:%fZ', '2030-01-01', '+' || value || ' minutes'),
          'pending', 0, '2030-01-01T12:00:00.000Z', '2030-01-01T12:00:00.000Z', 'Legacy backlog', '' FROM numbers;
    `);
    legacy.close();
    const result = run(directory, `
      const db = await import('./lib/db.ts');
      const scheduler = await import('./lib/scheduler.ts');
      const resumedAt = new Date('2030-01-01T13:00:01Z');
      db.setTaskStatus('paused', 'active', resumedAt);
      for (let index = 0; index < 100 && db.getTask('paused').pausedAt; index++) await scheduler.enqueueDueOccurrences(resumedAt);
      const raw = db.__rawDatabaseForTests();
      console.log(JSON.stringify({
        prePause: raw.prepare("SELECT COUNT(*) count FROM deliveries WHERE occurrence_at <= '2030-01-01T12:00:00.000Z'").get().count,
        pausedInterval: raw.prepare("SELECT COUNT(*) count FROM deliveries WHERE occurrence_at > '2030-01-01T12:00:00.000Z' AND occurrence_at < '2030-01-01T13:00:01.000Z'").get().count,
        next: db.getTask('paused').nextRunAt,
      }));
    `);
    assert.equal(result.prePause, 720);
    assert.equal(result.pausedInterval, 0);
    assert.equal(result.next, "2030-01-01T13:01:00.000Z");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
