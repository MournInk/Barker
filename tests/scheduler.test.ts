import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { BarkDeliveryError } from "../lib/bark";

const directory = mkdtempSync(join(tmpdir(), "barker-scheduler-"));
process.env.BARKER_DATA_DIR = directory;
after(() => rmSync(directory, { recursive: true, force: true }));

let db: typeof import("../lib/db");
let scheduler: typeof import("../lib/scheduler");
before(async () => {
  db = await import("../lib/db");
  scheduler = await import("../lib/scheduler");
});

beforeEach(() => {
  db.__rawDatabaseForTests().exec("DELETE FROM deliveries; DELETE FROM tasks;");
});

function taskInput(repeatCount: number | null = 2) {
  return {
    name: "Morning reminder", description: "A message", startsAt: "2026-10-19T01:30:00.000Z",
    preset: "daily" as const, cron: "30 9 * * *", repeatCount, endDate: null,
  };
}

test("start time is the first allowed minute and old occurrences are not backfilled", () => {
  const task = db.createTask(taskInput(), new Date("2026-10-18T00:00:00Z"));
  assert.equal(task.nextRunAt, "2026-10-19T01:30:00.000Z");
  const late = db.createTask({ ...taskInput(), name: "Late" }, new Date("2026-10-20T02:00:00Z"));
  assert.equal(late.nextRunAt, "2026-10-21T01:30:00.000Z");
});

test("each occurrence is stored, failures retry, and count completes after two sends", async () => {
  const task = db.createTask(taskInput(), new Date("2026-10-18T00:00:00Z"));
  assert.equal(await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z")), 1);
  assert.equal(db.deliverySummary().pending, 1);
  await scheduler.processOneDelivery(new Date("2026-10-19T01:30:00Z"), async () => { throw new Error("offline"); });
  assert.equal(db.deliverySummary().retrying, 1);
  assert.match(db.getTask(task.id)?.lastError ?? "", /offline/);
  await scheduler.processOneDelivery(new Date("2030-10-19T01:30:00Z"), async () => {});
  assert.equal(db.getTask(task.id)?.sentCount, 1);
  assert.equal(await scheduler.enqueueDueOccurrences(new Date("2026-10-20T01:30:00Z")), 1);
  assert.equal(db.getTask(task.id)?.status, "completed");
  assert.equal(db.deliverySummary().pending, 1);
  await scheduler.processOneDelivery(new Date("2030-10-20T01:30:00Z"), async () => {});
  assert.equal(db.getTask(task.id)?.sentCount, 2);
});

test("pause, update and delete preserve pending deliveries", async () => {
  const task = db.createTask(taskInput(3), new Date("2026-10-18T00:00:00Z"));
  db.setTaskStatus(task.id, "paused", new Date("2026-10-18T00:00:00Z"));
  assert.equal(await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z")), 0);
  db.setTaskStatus(task.id, "active", new Date("2026-10-18T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  assert.throws(() => db.deleteTask(task.id, new Date("2026-10-20T00:00:00Z")), /待重试/);
  const updated = db.updateTask(task.id, { ...taskInput(3), name: "Renamed" }, new Date("2026-10-20T00:00:00Z"));
  assert.equal(updated?.name, "Renamed");
  assert.equal(db.deliverySummary().pending, 1);
  await scheduler.processOneDelivery(new Date("2030-10-20T01:30:00Z"), async () => {});
  assert.equal(db.deleteTask(task.id, new Date("2026-10-20T00:00:00Z")), true);
});

test("pausing after the due minute still queues that occurrence", async () => {
  const task = db.createTask(taskInput(3), new Date("2026-10-18T00:00:00Z"));
  db.setTaskStatus(task.id, "paused", new Date("2026-10-19T01:30:00Z"));
  assert.equal(db.deliverySummary().pending, 1);
  assert.equal(db.getTask(task.id)?.status, "paused");
  assert.equal(db.getTask(task.id)?.nextRunAt, "2026-10-20T01:30:00.000Z");
});

test("resuming after missed minutes queues those occurrences before the next future run", () => {
  const task = db.createTask(taskInput(5), new Date("2026-10-18T00:00:00Z"));
  db.setTaskStatus(task.id, "paused", new Date("2026-10-18T12:00:00Z"));
  const resumed = db.setTaskStatus(task.id, "active", new Date("2026-10-21T01:30:00Z"));
  assert.equal(db.deliverySummary().pending, 3);
  assert.equal(resumed?.status, "active");
  assert.equal(resumed?.nextRunAt, "2026-10-22T01:30:00.000Z");
});

test("cutoff date completes scheduling but leaves final delivery queued", async () => {
  const task = db.createTask({ ...taskInput(null), endDate: "2026-10-19" }, new Date("2026-10-18T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  assert.equal(db.getTask(task.id)?.status, "completed");
  assert.equal(db.deliverySummary().pending, 1);
});

test("pausing after several missed runs queues every due reminder", () => {
  const task = db.createTask(taskInput(5), new Date("2026-10-18T00:00:00Z"));
  const paused = db.setTaskStatus(task.id, "paused", new Date("2026-10-21T01:30:00Z"));
  assert.equal(db.deliverySummary().pending, 3);
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.nextRunAt, "2026-10-22T01:30:00.000Z");
});

test("editing after a due run queues it before moving the schedule", () => {
  const task = db.createTask(taskInput(3), new Date("2026-10-18T00:00:00Z"));
  const updated = db.updateTask(task.id, { ...taskInput(3), name: "Updated" }, new Date("2026-10-19T01:30:00Z"));
  assert.equal(updated?.name, "Updated");
  assert.equal(db.deliverySummary().pending, 1);
  assert.equal(updated?.lastRunAt, "2026-10-19T01:30:00.000Z");
});

test("deleting at a due minute cannot discard an unqueued reminder", () => {
  const task = db.createTask(taskInput(3), new Date("2026-10-18T00:00:00Z"));
  assert.throws(() => db.deleteTask(task.id, new Date("2026-10-19T01:30:00Z")), /待重试/);
  assert.ok(db.getTask(task.id));
  assert.equal(db.getTask(task.id)?.nextRunAt, "2026-10-19T01:30:00.000Z");
});

test("pausing at the final occurrence preserves the completed status", () => {
  const task = db.createTask(taskInput(1), new Date("2026-10-18T00:00:00Z"));
  const result = db.setTaskStatus(task.id, "paused", new Date("2026-10-19T01:30:00Z"));
  assert.equal(result?.status, "completed");
  assert.equal(db.deliverySummary().pending, 1);
});

test("sub-minute start time keeps the same day instead of shifting a day", () => {
  const task = db.createTask(
    { ...taskInput(), name: "Sub-minute", startsAt: "2026-10-19T01:30:45.000Z" },
    new Date("2026-10-19T00:00:00Z"),
  );
  assert.equal(task.startsAt, "2026-10-19T01:30:00.000Z");
  assert.equal(task.nextRunAt, "2026-10-19T01:30:00.000Z");
});

test("retry backoff starts at 5s and doubles up to the 1h cap", async () => {
  // Future clock: keeps `completedAt` (max(now, Date.now())) deterministic and
  // avoids the scheduler backfilling four years of occurrences.
  const task = db.createTask(
    { ...taskInput(5), startsAt: "2030-10-19T01:30:00.000Z" },
    new Date("2030-10-18T00:00:00Z"),
  );
  await scheduler.enqueueDueOccurrences(new Date("2030-10-19T01:30:00Z"));
  const delays: number[] = [];
  let now = new Date("2030-10-19T01:30:00Z");
  for (let i = 0; i < 4; i += 1) {
    await scheduler.processOneDelivery(now, async () => { throw new Error("offline"); });
    const row = db.__rawDatabaseForTests().prepare("SELECT next_attempt_at FROM deliveries WHERE task_id = ?").get(task.id) as { next_attempt_at: string };
    const next = new Date(row.next_attempt_at);
    delays.push(Math.round((next.getTime() - now.getTime()) / 1000));
    now = next;
  }
  assert.deepEqual(delays, [5, 10, 20, 40]);
});

test("expired send lease is reclaimed, counted as an attempt, and never double-claimed", async () => {
  const task = db.createTask(taskInput(5), new Date("2026-10-18T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  const first = db.claimDelivery(new Date("2026-10-19T01:30:00Z"));
  assert.ok(first);
  assert.equal(db.claimDelivery(new Date("2026-10-19T01:31:00Z")), null, "lease still held");
  const reclaimed = db.claimDelivery(new Date("2026-10-19T01:32:01Z"));
  assert.equal(reclaimed?.id, first?.id);
  assert.equal(reclaimed?.attempts, 1, "crashed attempt is counted");
  const row = db.__rawDatabaseForTests().prepare("SELECT attempts FROM deliveries WHERE task_id = ?").get(task.id) as { attempts: number };
  assert.equal(row.attempts, 1, "the crashed attempt is recorded");
  assert.equal(db.deliverySummary().pending, 1, "in-flight deliveries stay visible");
});

test("force delete discards deliveries that can never be sent", async () => {
  const task = db.createTask(taskInput(5), new Date("2026-10-18T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  await scheduler.processOneDelivery(new Date("2026-10-19T01:30:00Z"), async () => { throw new Error("HTTP 400"); });
  assert.throws(() => db.deleteTask(task.id, new Date("2026-10-19T02:00:00Z")), /待重试/);
  assert.equal(db.deleteTask(task.id, new Date("2026-10-19T02:00:00Z"), { force: true }), true);
  assert.equal(db.getTask(task.id), null);
  assert.equal(db.deliverySummary().pending, 0);
});

test("corrupt settings fall back to defaults instead of failing every request", () => {
  db.__rawDatabaseForTests().prepare("UPDATE settings SET value = ? WHERE key = 'default'").run("{broken json");
  const settings = db.readSettings();
  assert.equal(settings.endpoint, "https://api.day.app");
  assert.equal(settings.deviceKey, "");
});

test("editing at the exact due minute does not consume a repeat", async () => {
  const task = db.createTask(taskInput(2), new Date("2026-10-18T00:00:00Z"));
  const due = new Date("2026-10-19T01:30:00Z");
  db.updateTask(task.id, taskInput(2), due);
  await scheduler.enqueueDueOccurrences(due);
  assert.equal(db.getTask(task.id)?.status, "active", "conflicting occurrence must not complete the task");
  assert.equal(db.getTask(task.id)?.nextRunAt, "2026-10-20T01:30:00.000Z");
  await scheduler.enqueueDueOccurrences(new Date("2026-10-20T01:30:00Z"));
  assert.equal(db.getTask(task.id)?.status, "completed");
  assert.equal(db.deliverySummary().pending, 2);
});

test("resuming a task with more than 500 missed occurrences is not a dead end", async () => {
  const task = db.createTask(
    { ...taskInput(100_000), name: "Backlog", startsAt: "2026-01-01T00:01:00.000Z", preset: "custom", cron: "* * * * *" },
    new Date("2026-01-01T00:00:00Z"),
  );
  db.setTaskStatus(task.id, "paused", new Date("2026-01-01T00:00:00Z"));
  const resumed = db.setTaskStatus(task.id, "active", new Date("2026-01-01T12:00:00Z"));
  assert.equal(resumed?.status, "active");
  assert.equal(db.deliverySummary().pending, 500, "first chunk queued before returning");
  const more = await scheduler.enqueueDueOccurrences(new Date("2026-01-01T12:00:00Z"));
  assert.equal(more, 220, "the scheduler drains the remainder");
  assert.equal(db.deliverySummary().pending, 720);
});

test("a late worker cannot resurrect a delivery whose lease was reclaimed", async () => {
  const task = db.createTask(taskInput(5), new Date("2026-10-18T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  const first = db.claimDelivery(new Date("2026-10-19T01:30:00Z"));
  assert.ok(first);
  const second = db.claimDelivery(new Date("2026-10-19T01:32:01Z"));
  assert.equal(second?.id, first?.id);
  assert.ok(first && second);
  const statusOf = () => (db.__rawDatabaseForTests().prepare("SELECT status FROM deliveries WHERE id = ?").get(first.id) as { status: string }).status;
  db.markDeliverySent(first.id, first.leaseUntil, new Date("2026-10-19T01:32:02Z"));
  assert.equal(statusOf(), "sending", "stale lease must not mark it sent");
  db.markDeliveryFailed(first.id, first.leaseUntil, 2, "late failure", new Date("2026-10-19T01:32:03Z"));
  assert.equal(statusOf(), "sending", "stale lease must not requeue it either");
  db.markDeliverySent(first.id, second.leaseUntil, new Date("2026-10-19T01:32:04Z"));
  assert.equal(statusOf(), "sent");
  assert.equal(db.getTask(task.id)?.sentCount, 1);
});

test("permanent Bark failures pause the task instead of hammering forever", async () => {
  const task = db.createTask(taskInput(100_000), new Date("2026-10-18T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  let now = new Date("2026-10-19T01:30:00Z");
  for (let i = 0; i < 5; i += 1) {
    await scheduler.processOneDelivery(now, async () => {
      throw new BarkDeliveryError("Bark API 返回 HTTP 404", { kind: "permanent", status: 404 });
    });
    const row = db.__rawDatabaseForTests().prepare("SELECT next_attempt_at FROM deliveries WHERE task_id = ?").get(task.id) as { next_attempt_at: string };
    now = new Date(row.next_attempt_at);
  }
  assert.equal(db.getTask(task.id)?.status, "paused");
  assert.match(db.getTask(task.id)?.lastError ?? "", /404/);
});

test("enqueueing after downtime is bounded per cycle", async () => {
  const backlog = { ...taskInput(100_000), name: "A", startsAt: "2026-01-01T00:01:00.000Z", preset: "custom" as const, cron: "* * * * *" };
  db.createTask(backlog, new Date("2026-01-01T00:00:00Z"));
  db.createTask({ ...backlog, name: "B" }, new Date("2026-01-01T00:00:00Z"));
  const first = await scheduler.enqueueDueOccurrences(new Date("2026-01-01T06:00:00Z"));
  assert.equal(first, 500, "one cycle never blocks on the whole backlog");
  const second = await scheduler.enqueueDueOccurrences(new Date("2026-01-01T06:00:00Z"));
  assert.equal(second, 220);
});
