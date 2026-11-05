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
    const legacy = new DatabaseSync(join(directory, "barker.sqlite"));
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT, description TEXT, starts_at TEXT, preset TEXT, cron TEXT,
        repeat_count INTEGER, end_date TEXT, sent_count INTEGER DEFAULT 0, next_run_at TEXT, last_run_at TEXT,
        last_error TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), occurrence_at TEXT,
        status TEXT, attempts INTEGER, next_attempt_at TEXT, lease_until TEXT, last_error TEXT, created_at TEXT,
        delivered_at TEXT, UNIQUE(task_id, occurrence_at));
      INSERT INTO tasks (id, name, description, status) VALUES ('old', 'Legacy name', 'Legacy body', 'completed');
      INSERT INTO deliveries (id, task_id, status, attempts) VALUES ('sent', 'old', 'sent', 2), ('pending', 'old', 'pending', 3);
    `);
    legacy.close();
    const inspect = `
      const db = await import('./lib/db.ts');
      console.log(JSON.stringify({ items: db.listDeliveries({ page:1, pageSize:10 }).deliveries }));
    `;
    const first = run(directory, inspect);
    const second = run(directory, inspect);
    assert.deepEqual(first, second);
    const items = first.items as Array<{ status: string; attempts: number; taskName: string; description: string }>;
    assert.equal(items.find((item) => item.status === "sent")?.attempts, 3);
    assert.equal(items.find((item) => item.status === "pending")?.attempts, 3);
    assert.ok(items.every((item) => item.taskName === "Legacy name" && item.description === "Legacy body"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
