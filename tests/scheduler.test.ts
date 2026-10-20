import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

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
