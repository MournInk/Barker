import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Cron } from "croner";
import { BarkDeliveryError, sendBark } from "../lib/bark";
import { calendarDays, previewSchedule, upcomingWeekDetails } from "../lib/cron";
import type { Task, TaskInput } from "../lib/types";

const directory = mkdtempSync(join(tmpdir(), "barker-repairs-"));
process.env.BARKER_DATA_DIR = directory;
process.env.BARKER_PASSWORD = "regression-password-value";
let db: typeof import("../lib/db");
let scheduler: typeof import("../lib/scheduler");
let auth: typeof import("../lib/auth");
before(async () => {
  db = await import("../lib/db"); scheduler = await import("../lib/scheduler"); auth = await import("../lib/auth");
});
beforeEach(() => {
  db.__rawDatabaseForTests().exec("DELETE FROM deliveries; DELETE FROM tasks; DELETE FROM devices; DELETE FROM runtime_state; DELETE FROM api_tokens;");
});
after(() => rmSync(directory, { recursive: true, force: true }));
const created = new Date("2030-01-01T00:00:00Z");
const due = new Date("2030-01-01T01:00:00Z");
const input: TaskInput = { name: "Reminder", startsAt: due.toISOString(), preset: "daily", cron: "0 9 * * *", repeatCount: 10 };

test("newly due tasks progress ahead of a hundred historical backlogs", async () => {
  for (let index = 0; index < 101; index += 1) db.createTask({ ...input, startsAt: "2029-01-01T00:00:00Z", preset: "custom", cron: "* * * * *", repeatCount: null }, new Date("2029-01-01T00:00:00Z"));
  const fresh = db.createTask(input, created);
  await scheduler.enqueueDueOccurrences(due);
  assert.equal(db.getTask(fresh.id)?.queuedCount, 1);
});

test("delivery order follows occurrence time and ordinary settings retain retry timing", async () => {
  const task = db.createTask({ ...input, startsAt: "2030-01-01T00:01:00Z", preset: "custom", cron: "* * * * *", repeatCount: 3 }, created);
  db.queueTaskBatch(task.id, due);
  const first = db.claimDelivery(due)!;
  assert.equal(first.occurrenceAt, "2030-01-01T00:01:00.000Z");
  db.markDeliveryFailed(first.id, first.leaseUntil, 1, "429", due, new Date("2030-01-01T02:00:00Z"));
  const previous = db.readSettingsState();
  const { endpoint, deviceKey } = previous.settings;
  const cooldown = `endpoint:${createHash("sha256").update(`${endpoint}\n${deviceKey}`).digest("hex")}`;
  db.writeRuntimeState(cooldown, "1893463200000");
  db.writeSettings({ ...previous.settings, group: "new-group" }, previous.revision);
  assert.equal(db.readRuntimeState(cooldown), "1893463200000");
  assert.equal(db.listDeliveries({ page: 1, pageSize: 10 }).deliveries.find((item) => item.id === first.id)?.nextAttemptAt, "2030-01-01T02:00:00.000Z");
  assert.equal(db.claimDelivery(due)?.occurrenceAt, "2030-01-01T00:02:00.000Z");
});

test("an enqueue error makes scheduler health fail until a successful cycle", async () => {
  db.createTask(input, created);
  const raw = db.__rawDatabaseForTests();
  raw.exec("CREATE TRIGGER reject_enqueue BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
  try { await scheduler.runSchedulerCycle(due, async () => {}); assert.equal(scheduler.schedulerHealth(), false); }
  finally { raw.exec("DROP TRIGGER reject_enqueue"); }
  await scheduler.runSchedulerCycle(due, async () => {});
  assert.equal(scheduler.schedulerHealth(), true);
});

test("permanent failures wait for correction without losing attempt history", async () => {
  db.createTask(input, created);
  await scheduler.enqueueDueOccurrences(due);
  await scheduler.processOneDelivery(due, async () => { throw new BarkDeliveryError("message rejected", { kind: "permanent", scope: "payload" }); });
  const failed = db.listDeliveries({ page: 1, pageSize: 10 }).deliveries[0];
  assert.equal(failed.manualOnly, true);
  assert.equal(await scheduler.processOneDelivery(new Date(due.getTime() + 3_600_000), async () => assert.fail("must not retry")), false);
  db.editDelivery(failed.id, "Corrected", "fixed", failed.updatedAt, due);
  await scheduler.processOneDelivery(new Date(due.getTime() + 3_600_000), async (_settings, title) => { assert.equal(title, "Corrected"); });
  assert.equal(db.deliveryAttempts(failed.id).length, 2);
});

test("expired pending deliveries cannot be edited", () => {
  const reminder = db.createTask({ ...input, maxLatenessMinutes: 1 }, created);
  db.queueTaskBatch(reminder.id, due);
  const delivery = db.listDeliveries({ page: 1, pageSize: 1 }).deliveries[0];
  assert.throws(() => db.editDelivery(delivery.id, "Edited", "", delivery.updatedAt, new Date(delivery.expiresAt!)), { status: 409 });
  assert.equal(db.listDeliveries({ page: 1, pageSize: 1 }).deliveries[0].taskName, input.name);
});

test("Bark endpoint failures start a cooldown while payload failures leave other messages eligible", async () => {
  const settings = { ...db.readSettings(), deviceKey: "regression-cooldown-device" };
  db.writeSettings(settings);
  const cooldown = `endpoint:${createHash("sha256").update(`${settings.endpoint}\n${settings.deviceKey}`).digest("hex")}`;
  for (const name of ["First outbox entry", "Second outbox entry"]) {
    const reminder = db.createTask({ ...input, name }, created);
    db.queueTaskBatch(reminder.id, due);
  }
  const respond = (httpStatus: number) => (target: typeof settings, title: string, body: string) =>
    sendBark(target, title, body, async () => new Response(null, { status: httpStatus }));
  assert.equal(await scheduler.processOneDelivery(due, respond(413)), true);
  assert.equal(db.readRuntimeState(cooldown), null);
  assert.equal(await scheduler.processOneDelivery(due, respond(503)), true);
  assert.ok(Number(db.readRuntimeState(cooldown)) > due.getTime());
});

test("task-specific devices and options stay attached to queued messages", async () => {
  const device = db.saveDevice({ name: "Work", endpoint: "https://work.example", deviceKey: "work-device-key" });
  const task = db.createTask({ ...input, deviceId: device.id, notification: { group: "work", sound: "bell" } }, created);
  await scheduler.enqueueDueOccurrences(due);
  await scheduler.processOneDelivery(due, async (settings) => {
    assert.equal(settings.endpoint, "https://work.example"); assert.equal(settings.deviceKey, "work-device-key"); assert.equal(settings.group, "work");
  });
  assert.throws(() => db.removeDevice(device.id, device.revision), /仍被/);
  assert.equal(db.getTask(task.id)?.sentCount, 1);
  assert.equal(JSON.stringify(db.listDevices()).includes("work-device-key"), false);
});

test("once, endless, holiday exceptions and weekend make-up dates share worker rules", () => {
  const once = db.createTask({ ...input, preset: "once", repeatCount: 1 }, created);
  db.queueTaskBatch(once.id, due);
  assert.equal(db.getTask(once.id)?.status, "completed");
  const schedule = { ...input, startsAt: "2030-01-04T01:00:00Z", preset: "weekdays" as const, cron: "0 9 * * 1-5", repeatCount: null, skipDates: ["2030-01-04"], includeDates: ["2030-01-05"] };
  const preview = previewSchedule(schedule, created);
  assert.equal(preview[0].toISOString(), "2030-01-05T01:00:00.000Z");
  const task = db.createTask(schedule, created);
  db.queueTaskBatch(task.id, new Date("2030-01-07T01:00:00Z"));
  assert.equal(db.getTask(task.id)?.queuedCount, 2);
  assert.equal(db.getTask(task.id)?.status, "active");
});

test("archived tasks restore and permanent deletion removes payload and attempts", () => {
  const task = db.createTask(input, created);
  db.deleteTask(task.id, due);
  const archived = db.getTask(task.id)!;
  const restored = db.setTaskStatus(task.id, "active", new Date("2030-01-02T00:00:00Z"), archived.revision)!;
  assert.equal(restored.nextRunAt, "2030-01-02T01:00:00.000Z");
  db.deleteTask(task.id, new Date("2030-01-02T00:00:00Z"), restored.revision);
  db.permanentlyDeleteTask(task.id, db.getTask(task.id)!.revision);
  assert.equal(db.getTask(task.id), null);
  assert.equal(db.listDeliveries({ page: 1, pageSize: 10 }).total, 0);
});

test("queue capacity applies backpressure without consuming future occurrences", () => {
  const task = db.createTask({ ...input, startsAt: "2030-01-01T00:00:00Z", preset: "custom", cron: "* * * * *", repeatCount: null }, created);
  const late = new Date("2030-01-03T00:00:00Z");
  for (let index = 0; index < 45; index += 1) db.queueTaskBatch(task.id, late, 25);
  assert.equal(db.getTask(task.id)?.queuedCount, 1000);
  const pending = db.listDeliveries({ page: 1, pageSize: 10 }).deliveries[0];
  db.cancelDelivery(pending.id, late);
  assert.equal(db.queueTaskBatch(task.id, late), 1);
});

test("100 minute schedules jump over clock slots instead of enumerating individual minutes", (context) => {
  const now = new Date("2030-01-01T00:00:00Z");
  const tasks = Array.from({ length: 100 }, (_, index) => ({ id: String(index), status: "active", cron: "* * * * *", timeZone: "Asia/Shanghai", nextRunAt: now.toISOString(), repeatCount: null, queuedCount: 0 } as Task));
  const nextRun = context.mock.method(Cron.prototype, "nextRun");
  const result = upcomingWeekDetails(tasks, now);
  assert.ok(nextRun.mock.callCount() <= tasks.length * 7);
  assert.equal(result.upcomingDays[1].total, 144_000);
  assert.equal(result.upcoming.length, 28);
});

test("forecast backlog respects the request deadline and reports incomplete data", (context) => {
  let tick = 0;
  context.mock.method(performance, "now", () => tick++);
  const task = { id: "backlog", status: "active", cron: "0 9 * * *", timeZone: "Asia/Shanghai", nextRunAt: "2000-01-01T01:00:00Z", repeatCount: 15_000, queuedCount: 0 } as Task;
  const result = upcomingWeekDetails([task], due, { deadline: 10 });
  assert.equal(result.forecastTruncated, true);
  assert.equal(result.upcoming.length, 0);
});

test("display calendars retain local midnight across DST", () => {
  const days = calendarDays(new Date("2026-03-08T08:00:00Z"), "America/New_York");
  assert.equal(days[0].date, "2026-03-08");
  assert.equal(days[0].end - days[0].start, 23 * 3_600_000);
});

test("UI password rotation revokes sessions and tokens, and scoped API tokens are hashed", () => {
  const session = auth.createSessionToken();
  const token = auth.createApiToken("reader", "read", 1);
  assert.equal(auth.requestIsAuthorized(new Request("http://localhost/api/tasks", { headers: { authorization: `Bearer ${token}` } })), true);
  assert.equal(auth.requestIsAuthorized(new Request("http://localhost/api/tasks", { method: "POST", headers: { authorization: `Bearer ${token}` } })), false);
  assert.equal(JSON.stringify(db.securityState()).includes(token), false);
  auth.changePassword("regression-password-value", "new-regression-password", "rotation");
  assert.equal(auth.isValidSessionToken(session), false);
  assert.equal(auth.verifyPassword("new-regression-password", Date.now(), "rotation"), true);
  assert.equal(auth.requestIsAuthorized(new Request("http://localhost/api/tasks", { headers: { authorization: `Bearer ${token}` } })), false);
});
