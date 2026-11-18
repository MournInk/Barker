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
  db.__rawDatabaseForTests().exec("DELETE FROM deliveries; DELETE FROM tasks; DELETE FROM runtime_state;");
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

test("pause, edit and archive retain the pending outbox", async () => {
  const task = db.createTask(taskInput(3), new Date("2026-10-18T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  db.setTaskStatus(task.id, "paused", new Date("2026-10-19T02:00:00Z"));
  const updated = db.updateTask(task.id, { ...taskInput(3), name: "Renamed" }, new Date("2026-10-20T00:00:00Z"));
  assert.equal(updated?.name, "Renamed");
  assert.equal(db.deliverySummary().pending, 1);
  assert.equal(db.deleteTask(task.id, new Date("2026-10-20T00:00:00Z")), true);
  assert.equal(db.deliverySummary().pending, 1);
  assert.equal(db.getTask(task.id)?.status, "archived");
});

test("pausing after the due minute still queues that occurrence", async () => {
  const task = db.createTask(taskInput(3), new Date("2026-10-18T00:00:00Z"));
  db.setTaskStatus(task.id, "paused", new Date("2026-10-19T01:30:00Z"));
  assert.equal(db.deliverySummary().pending, 1);
  assert.equal(db.getTask(task.id)?.status, "paused");
  assert.equal(db.getTask(task.id)?.nextRunAt, "2026-10-20T01:30:00.000Z");
});

test("resuming skips the paused interval instead of sending a burst", () => {
  const task = db.createTask(taskInput(5), new Date("2026-10-18T00:00:00Z"));
  db.setTaskStatus(task.id, "paused", new Date("2026-10-18T12:00:00Z"));
  const resumed = db.setTaskStatus(task.id, "active", new Date("2026-10-21T02:00:00Z"));
  assert.equal(db.deliverySummary().pending, 0);
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

test("archiving at a due minute materializes the unqueued reminder", () => {
  const task = db.createTask(taskInput(3), new Date("2026-10-18T00:00:00Z"));
  assert.equal(db.deleteTask(task.id, new Date("2026-10-19T01:30:00Z")), true);
  assert.equal(db.getTask(task.id)?.status, "archived");
  assert.equal(db.deliverySummary().pending, 1);
  assert.equal(db.setTaskStatus(task.id, "active")?.status, "active");
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

test("archive cannot discard even a permanently failed delivery", async () => {
  const task = db.createTask(taskInput(5), new Date("2026-10-18T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  await scheduler.processOneDelivery(new Date("2026-10-19T01:30:00Z"), async () => { throw new Error("HTTP 400"); });
  assert.equal(db.deleteTask(task.id, new Date("2026-10-19T02:00:00Z")), true);
  assert.equal(db.getTask(task.id)?.status, "archived");
  assert.equal(db.deliverySummary().pending, 1);
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

test("large backlog pause records its cutoff and drains without discarding occurrences", async () => {
  const task = db.createTask(
    { ...taskInput(100_000), startsAt: "2026-01-01T00:01:00Z", preset: "custom", cron: "* * * * *" },
    new Date("2026-01-01T00:00:00Z"),
  );
  const late = new Date("2026-01-01T12:00:00Z");
  const paused = db.setTaskStatus(task.id, "paused", late);
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.pausedAt, late.toISOString());
  for (let cycle = 0; cycle < 100 && db.deliverySummary().pending < 720; cycle += 1) await scheduler.enqueueDueOccurrences(late);
  assert.equal(db.deliverySummary().pending, 720, "all pre-pause reminders survive");
});

test("repausing or archiving after resume preserves both pause boundaries", async () => {
  const start = new Date("2030-01-01T00:00:00.000Z");
  const firstPause = new Date("2030-01-01T00:55:00.000Z");
  const resume = new Date("2030-01-01T12:00:01.000Z");
  const secondPause = new Date("2030-01-01T12:30:00.000Z");
  const pausedTask = db.createTask(
    { name: "Paused", description: "", startsAt: "2030-01-01T00:01:00.000Z", preset: "custom", cron: "* * * * *", repeatCount: 1000, endDate: null },
    start,
  );
  db.setTaskStatus(pausedTask.id, "paused", firstPause);
  db.setTaskStatus(pausedTask.id, "active", resume);
  db.setTaskStatus(pausedTask.id, "paused", secondPause);
  for (let cycle = 0; cycle < 100 && db.deliverySummary().pending < 85; cycle += 1) await scheduler.enqueueDueOccurrences(secondPause);
  assert.equal(db.deliverySummary().pending, 85, "reminders while active are retained without filling the paused interval");

  db.__rawDatabaseForTests().exec("DELETE FROM deliveries");
  const archivedTask = db.createTask(
    { name: "Archived", description: "", startsAt: "2030-01-01T00:01:00.000Z", preset: "custom", cron: "* * * * *", repeatCount: 1000, endDate: null },
    start,
  );
  db.setTaskStatus(archivedTask.id, "paused", firstPause);
  db.setTaskStatus(archivedTask.id, "active", resume);
  db.deleteTask(archivedTask.id, secondPause);
  for (let cycle = 0; cycle < 100 && db.deliverySummary().pending < 85; cycle += 1) await scheduler.enqueueDueOccurrences(secondPause);
  assert.equal(db.deliverySummary().pending, 85, "archive uses the resumed interval as its cutoff");
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

test("permanent Bark failures keep retrying while later occurrences continue to queue", async () => {
  const task = db.createTask({ ...taskInput(100), startsAt: "2030-10-19T01:30:00Z" }, new Date("2030-10-18T00:00:00Z"));
  let now = new Date("2030-10-19T01:30:00Z");
  await scheduler.enqueueDueOccurrences(now);
  await scheduler.enqueueDueOccurrences(new Date("2030-10-20T01:30:00Z"));
  assert.equal(db.getTask(task.id)?.queuedCount, 2);
  assert.equal(db.deliverySummary().pending, 2);
  for (let i = 0; i < 12; i += 1) {
    await scheduler.processOneDelivery(now, async () => { throw new BarkDeliveryError("Bark API 返回 HTTP 404", { kind: "permanent" }); });
    const row = db.__rawDatabaseForTests().prepare("SELECT next_attempt_at FROM deliveries WHERE task_id = ?").get(task.id) as { next_attempt_at: string };
    const next = new Date(Math.max(Date.parse(row.next_attempt_at), now.getTime() + 60_000));
    assert.ok(next.getTime() - now.getTime() <= 3_600_000);
    now = next;
  }
  assert.equal(db.getTask(task.id)?.status, "active");
  assert.equal(db.deliverySummary().pending, 2);
  assert.match(db.getTask(task.id)?.lastError ?? "", /404/);
});

test("endpoint cooldown does not postpone configured message expiration", async () => {
  const task = db.createTask(
    { ...taskInput(5), startsAt: "2030-10-19T01:30:00.000Z", maxLatenessMinutes: 1 },
    new Date("2030-10-18T00:00:00Z"),
  );
  const due = new Date("2030-10-19T01:30:00Z");
  await scheduler.enqueueDueOccurrences(due);
  await scheduler.processOneDelivery(due, async () => {
    throw new BarkDeliveryError("rate limited", { kind: "transient", retryAt: new Date("2030-10-19T03:00:00Z") });
  });
  let deliveries = 0;
  const processed = await scheduler.processOneDelivery(new Date("2030-10-19T01:32:00Z"), async () => { deliveries += 1; });
  assert.equal(processed, false);
  assert.equal(deliveries, 0);
  const item = db.listDeliveries({ page: 1, pageSize: 10 }).deliveries.find((delivery) => delivery.taskId === task.id);
  assert.equal(item?.status, "expired");
});

test("enqueueing after downtime is bounded per cycle", async () => {
  const backlog = { ...taskInput(100_000), name: "A", startsAt: "2026-01-01T00:01:00.000Z", preset: "custom" as const, cron: "* * * * *" };
  db.createTask(backlog, new Date("2026-01-01T00:00:00Z"));
  db.createTask({ ...backlog, name: "B" }, new Date("2026-01-01T00:00:00Z"));
  const first = await scheduler.enqueueDueOccurrences(new Date("2026-01-01T06:00:00Z"));
  assert.ok(first > 0 && first <= 500, "one cycle is bounded by both count and time");
  for (let cycle = 0; cycle < 100 && db.deliverySummary().pending < 720; cycle += 1) await scheduler.enqueueDueOccurrences(new Date("2026-01-01T06:00:00Z"));
  assert.equal(db.deliverySummary().pending, 720);
});

test("an elapsed batch setup budget still advances one due occurrence", () => {
  const task = db.createTask({ ...taskInput(60), startsAt: "2030-01-01T00:01:00Z", preset: "custom", cron: "* * * * *" }, new Date("2030-01-01T00:00:00Z"));
  assert.equal(db.queueTaskBatch(task.id, new Date("2030-01-01T01:00:00Z"), 25, performance.now() - 1), 1);
  assert.equal(db.getTask(task.id)?.queuedCount, 1);
  assert.equal(db.getTask(task.id)?.nextRunAt, "2030-01-01T00:02:00.000Z");
});

test("an unusable stored cron is isolated without blocking healthy schedules", async () => {
  const broken = db.createTask(taskInput(5), new Date("2026-10-18T00:00:00Z"));
  const healthy = db.createTask({ ...taskInput(5), name: "Healthy" }, new Date("2026-10-18T00:00:00Z"));
  const raw = db.__rawDatabaseForTests();
  raw.prepare("UPDATE tasks SET cron = ?, next_run_at = ? WHERE id = ?").run("0 0 31 2 *", "2026-10-19T00:00:00.000Z", broken.id);
  raw.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ?").run("2026-10-19T01:30:00.000Z", healthy.id);
  const count = await scheduler.enqueueDueOccurrences(new Date("2026-10-19T01:30:00Z"));
  assert.equal(count, 1);
  assert.equal(db.getTask(healthy.id)?.queuedCount, 1);
  assert.equal(db.getTask(broken.id)?.status, "paused");
  assert.match(db.getTask(broken.id)?.lastError ?? "", /排期无效/);
});

test("delivery workers keep concurrency at four and stop after twenty messages", async () => {
  const now = new Date("2030-01-01T01:00:00Z");
  db.createTask({ ...taskInput(60), startsAt: "2030-01-01T00:01:00Z", preset: "custom", cron: "* * * * *" }, new Date("2030-01-01T00:00:00Z"));
  let active = 0;
  let maximum = 0;
  let sent = 0;
  await scheduler.runSchedulerCycle(now, async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1; sent += 1;
  });
  assert.equal(sent, 20);
  assert.equal(maximum, 4);
});

test("a persistence failure keeps the cycle open until every in-flight worker finishes", { timeout: 10_000 }, async () => {
  const now = new Date("2030-01-01T01:00:00Z");
  db.createTask({ ...taskInput(4), startsAt: "2030-01-01T00:01:00Z", preset: "custom", cron: "* * * * *" }, new Date("2030-01-01T00:00:00Z"));
  const raw = db.__rawDatabaseForTests();
  const releases: Array<() => void> = [];
  const waiting = Array.from({ length: 4 }, () => new Promise<void>((resolve) => { releases.push(resolve); }));
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let calls = 0;
  let finished = false;
  const operation = scheduler.runSchedulerCycle(now, async () => {
    const index = calls++;
    if (calls === 4) ready();
    await waiting[index];
  });
  void operation.then(() => { finished = true; });
  try {
    await started;
    raw.exec("PRAGMA query_only=ON");
    releases[0]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "one failed persistence must not release the cycle or its shutdown waiters");
    raw.exec("PRAGMA query_only=OFF");
    releases.slice(1).forEach((release) => release());
    await operation;
    assert.equal(db.dashboardStats(now).stats.totalSent, 3);
    const recovered = db.claimDelivery(new Date(now.getTime() + 121_000));
    assert.ok(recovered, "the unpersisted acknowledgement must remain recoverable through its lease");
    assert.equal(recovered.attempts, 1);
    db.markDeliverySent(recovered.id, recovered.leaseUntil, new Date(now.getTime() + 121_000));
    assert.equal(db.dashboardStats(now).stats.totalSent, 4);
  } finally {
    raw.exec("PRAGMA query_only=OFF");
    releases.forEach((release) => release());
    await operation;
  }
});

test("concurrent failures cannot shorten another worker's Retry-After", async () => {
  const now = new Date("2030-01-01T01:00:00Z");
  db.createTask({ ...taskInput(4), startsAt: "2030-01-01T00:01:00Z", preset: "custom", cron: "* * * * *" }, new Date("2030-01-01T00:00:00Z"));
  await scheduler.enqueueDueOccurrences(now);
  let calls = 0;
  let release!: () => void;
  const firstFailed = new Promise<void>((resolve) => { release = resolve; });
  const deliver = async () => {
    const index = calls++;
    if (index === 0) {
      release(); throw new BarkDeliveryError("rate limited", { retryAt: new Date("2030-01-01T02:00:00Z") });
    }
    await firstFailed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw new BarkDeliveryError("network failure");
  };
  await Promise.all([scheduler.processOneDelivery(now, deliver), scheduler.processOneDelivery(now, deliver)]);
  assert.equal(calls, 2);
  assert.equal(await scheduler.processOneDelivery(new Date("2030-01-01T01:01:00Z"), async () => { calls += 1; }), false);
  assert.equal(calls, 2);
});

test("enqueue yields promptly even with one hundred thousand historical messages", async () => {
  const task = db.createTask({ ...taskInput(null), startsAt: "2030-01-01T00:01:00Z", preset: "custom", cron: "* * * * *", endDate: "2030-12-31" }, new Date("2030-01-01T00:00:00Z"));
  db.__rawDatabaseForTests().prepare(`WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 100000)
    INSERT INTO deliveries (id, task_id, occurrence_at, status, attempts, next_attempt_at, created_at, delivered_at, title, body, activity_at)
    SELECT 'history-' || value, ?, strftime('%Y-%m-%dT%H:%M:%fZ', '2029-01-01', '+' || value || ' minutes'), 'sent', 1,
      '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z', 'History', '', '2029-01-01T00:00:00.000Z' FROM numbers`).run(task.id);
  db.__rawDatabaseForTests().prepare("UPDATE tasks SET queued_count = 100000, sent_count = 100000 WHERE id = ?").run(task.id);
  const started = performance.now();
  const yielded = new Promise<number>((resolve) => setImmediate(() => resolve(performance.now() - started)));
  const queued = scheduler.enqueueDueOccurrences(new Date("2030-01-02T00:00:00Z"));
  assert.ok(await yielded < 1000, "history size must not hold the event loop for seconds");
  assert.ok(await queued > 0);
});
