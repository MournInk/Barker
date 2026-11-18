import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "barker-workflow-"));
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

const input = {
  name: "Morning review", description: "Original message", startsAt: "2030-10-19T01:30:00Z",
  preset: "daily" as const, cron: "30 9 * * *", repeatCount: 10, endDate: null,
};
const created = new Date("2030-10-18T00:00:00Z");
const due = new Date("2030-10-19T01:30:00Z");

test("queued messages keep their original payload after a task is edited", async () => {
  const task = db.createTask(input, created);
  await scheduler.enqueueDueOccurrences(due);
  db.updateTask(task.id, { ...input, name: "Renamed", description: "Changed message" }, new Date("2030-10-19T02:00:00Z"));
  const delivery = db.claimDelivery(due);
  assert.equal(delivery?.name, input.name);
  assert.equal(delivery?.description, input.description);
});

test("archive keeps pending messages deliverable and never discards history", async () => {
  const task = db.createTask(input, created);
  await scheduler.enqueueDueOccurrences(due);
  assert.equal(db.deleteTask(task.id, due), true);
  assert.equal(db.getTask(task.id)?.status, "archived");
  assert.equal(db.getTask(task.id)?.nextRunAt, null);
  assert.equal(db.deliverySummary().pending, 1);
  await scheduler.processOneDelivery(due, async () => {});
  assert.equal(db.getTask(task.id)?.sentCount, 1);
  assert.equal(db.deliverySummary().pending, 0);
});

test("pause stops future scheduling, resume skips paused time, pending delivery survives", async () => {
  const task = db.createTask(input, created);
  db.setTaskStatus(task.id, "paused", due);
  assert.equal(db.deliverySummary().pending, 1);
  const resumed = db.setTaskStatus(task.id, "active", new Date("2030-10-23T02:00:00Z"));
  assert.equal(resumed?.nextRunAt, "2030-10-24T01:30:00.000Z");
  assert.equal(db.deliverySummary().pending, 1);
});

test("manual retry makes a failed delivery due immediately without resetting attempts", async () => {
  db.createTask(input, created);
  await scheduler.enqueueDueOccurrences(due);
  await scheduler.processOneDelivery(due, async () => { throw new Error("offline"); });
  const item = db.listDeliveries({ page: 1, pageSize: 20, status: "retrying" }).deliveries[0];
  assert.equal(item.attempts, 1);
  assert.equal(db.retryDelivery(item.id, due), true);
  assert.equal(db.claimDelivery(due)?.attempts, 1);
});

test("downtime is backfilled but bounded; duplicate cycles cannot create duplicate occurrences", async () => {
  const task = db.createTask(input, created);
  const late = new Date("2030-10-22T02:00:00Z");
  assert.equal(await scheduler.enqueueDueOccurrences(late), 4);
  assert.equal(await scheduler.enqueueDueOccurrences(late), 0);
  assert.equal(db.getTask(task.id)?.queuedCount, 4);
});

test("edit preview excludes existing occurrences and respects the remaining count without writing", async () => {
  const task = db.createTask({ ...input, repeatCount: 3 }, created);
  await scheduler.enqueueDueOccurrences(due);
  const preview = db.previewTaskUpdate(task.id, { ...input, repeatCount: 3 }, new Date("2030-10-20T01:30:00Z"));
  assert.deepEqual(preview?.map((date) => date.toISOString()), ["2030-10-21T01:30:00.000Z"]);
  assert.equal(db.getTask(task.id)?.queuedCount, 1, "preview must never enqueue or change data");
  const updated = db.updateTask(task.id, { ...input, repeatCount: 3 }, new Date("2030-10-20T01:30:00Z"));
  assert.equal(updated?.nextRunAt, preview?.[0]?.toISOString());
});

test("lowering a repeat limit can finish a task without discarding pending messages", async () => {
  const task = db.createTask(input, created);
  await scheduler.enqueueDueOccurrences(due);
  assert.deepEqual(db.previewTaskUpdate(task.id, { ...input, repeatCount: 1 }, due), []);
  assert.equal(db.updateTask(task.id, { ...input, repeatCount: 1 }, due)?.status, "completed");
  assert.equal(db.deliverySummary().pending, 1);
});

test("a successful newer message does not hide another message's failure", async () => {
  const task = db.createTask(input, created);
  await scheduler.enqueueDueOccurrences(new Date("2030-10-20T01:30:00Z"));
  const first = db.claimDelivery(new Date("2030-10-20T01:30:00Z"))!;
  db.markDeliveryFailed(first.id, first.leaseUntil, 1, "Earlier message offline", new Date("2030-10-20T01:30:00Z"));
  let newerMessageSent = false;
  await scheduler.processOneDelivery(new Date("2030-10-20T01:30:00Z"), async () => { newerMessageSent = true; });
  assert.equal(newerMessageSent, true);
  assert.equal(db.getTask(task.id)?.sentCount, 1);
  assert.equal(db.getTask(task.id)?.lastError, "Earlier message offline");
});

test("valid JSON with invalid settings fields safely falls back to defaults", () => {
  for (const value of [null, [], { deviceKey: 123 }, { endpoint: "file:///tmp" }]) {
    db.__rawDatabaseForTests().prepare("UPDATE settings SET value = ? WHERE key = 'default'").run(JSON.stringify(value));
    assert.equal(db.readSettings().deviceKey, "");
    assert.equal(db.readSettings().endpoint, "https://api.day.app");
  }
});

test("a corrupt settings revision is repaired instead of producing NaN conflicts", () => {
  const previous = db.settingsRevision();
  db.__rawDatabaseForTests().prepare("UPDATE settings SET value = 'broken' WHERE key = 'revision'").run();
  assert.equal(db.settingsRevision(), 1);
  db.__rawDatabaseForTests().prepare("UPDATE settings SET value = ? WHERE key = 'revision'").run(String(previous));
});

test("writing settings restores a missing revision row instead of creating a permanent stale-version loop", () => {
  const raw = db.__rawDatabaseForTests();
  const previousSettings = raw.prepare("SELECT value FROM settings WHERE key = 'default'").get() as { value: string };
  const previousRevision = db.settingsRevision();
  raw.prepare("DELETE FROM settings WHERE key = 'revision'").run();
  try {
    assert.equal(db.writeSettings(db.readSettings(), 1), 2);
    assert.equal(db.settingsRevision(), 2);
  } finally {
    raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default', ?)").run(previousSettings.value);
    raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('revision', ?)").run(String(previousRevision));
  }
});

test("a slow Bark request does not block materializing newly due reminders", async () => {
  db.createTask(input, created);
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const send = async () => { started(); await blocked; };
  const first = scheduler.runSchedulerCycle(due, send);
  await ready;
  const second = scheduler.runSchedulerCycle(new Date("2030-10-20T01:30:00Z"), send);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(db.listDeliveries({ page: 1, pageSize: 10 }).total, 2);
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

test("cancelling and expiring messages retain history without counting as delivered", async () => {
  const task = db.createTask({ ...input, maxLatenessMinutes: 1 }, created);
  await scheduler.enqueueDueOccurrences(due);
  const first = db.listDeliveries({ page: 1, pageSize: 10 }).deliveries[0];
  assert.equal(db.cancelDelivery(first.id, due), true);
  assert.equal(db.cancelDelivery(first.id, due), false);
  assert.equal(db.claimDelivery(due), null);
  await scheduler.enqueueDueOccurrences(new Date("2030-10-20T01:32:00Z"));
  const listing = db.listDeliveries({ page: 1, pageSize: 10 });
  assert.equal(listing.deliveries.find((item) => item.id === first.id)?.status, "cancelled");
  assert.equal(listing.deliveries.find((item) => item.id !== first.id)?.status, "expired");
  assert.equal(db.getTask(task.id)?.queuedCount, 2);
  assert.equal(db.getTask(task.id)?.sentCount, 0);
});

test("attempt history records failure, lease interruption, and eventual acknowledgement", async () => {
  const task = db.createTask(input, created);
  await scheduler.enqueueDueOccurrences(due);
  const first = db.claimDelivery(due)!;
  db.markDeliveryFailed(first.id, first.leaseUntil, 1, "offline", due);
  const secondAt = new Date(due.getTime() + 5000);
  db.claimDelivery(secondAt);
  const thirdAt = new Date(secondAt.getTime() + 120001);
  const third = db.claimDelivery(thirdAt)!;
  db.markDeliverySent(third.id, third.leaseUntil, thirdAt);
  assert.deepEqual(db.deliveryAttempts(first.id).map((item) => item.outcome), ["sent", "interrupted", "failed"]);
  assert.equal(db.getTask(task.id)?.sentCount, 1);
});

test("history pruning preserves cumulative scheduling budgets and pending messages", async () => {
  const task = db.createTask({ ...input, repeatCount: 3 }, created);
  await scheduler.enqueueDueOccurrences(due);
  const first = db.claimDelivery(due)!;
  db.markDeliverySent(first.id, first.leaseUntil, due);
  await scheduler.enqueueDueOccurrences(new Date("2030-10-20T01:30:00Z"));
  assert.equal(db.pruneHistory("2030-10-21T00:00:00.000Z"), 1);
  assert.equal(db.deliveryAttempts(first.id).length, 0);
  assert.equal(db.deliverySummary().pending, 1);
  assert.equal(db.getTask(task.id)?.sentCount, 1);
  assert.equal(db.getTask(task.id)?.queuedCount, 2);
  await scheduler.enqueueDueOccurrences(new Date("2030-10-21T01:30:00Z"));
  assert.equal(db.getTask(task.id)?.status, "completed");
  assert.equal(db.getTask(task.id)?.queuedCount, 3);
});

test("a bad optional setting preserves the endpoint and device key, including after rotation", () => {
  const valid = { endpoint: "https://bark.test", deviceKey: "legacy/key", title: "Barker", sound: "", group: "", icon: "" };
  db.__rawDatabaseForTests().prepare("UPDATE settings SET value = ? WHERE key = 'default'").run(JSON.stringify({ ...valid, icon: "bad icon" }));
  assert.equal(db.readSettings().endpoint, valid.endpoint);
  assert.equal(db.readSettings().deviceKey, valid.deviceKey);
  assert.equal(db.readSettings().icon, "");
  const task = db.createTask(input, created);
  db.__rawDatabaseForTests().prepare("UPDATE tasks SET last_error = ? WHERE id = ?").run(`upstream exposed ${valid.deviceKey} ${encodeURIComponent(valid.deviceKey)}`, task.id);
  db.writeSettings({ ...valid, deviceKey: "replacement-key" });
  assert.doesNotMatch(db.getTask(task.id)?.lastError ?? "", /legacy/);
});
