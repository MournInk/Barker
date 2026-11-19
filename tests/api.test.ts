import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "barker-api-"));
process.env.BARKER_DATA_DIR = directory;
process.env.BARKER_PASSWORD = "api-test-password-1234";
let auth: typeof import("../lib/auth");
let tasks: typeof import("../app/api/tasks/route");
let task: typeof import("../app/api/tasks/[id]/route");
let settings: typeof import("../app/api/settings/route");
let deliveries: typeof import("../app/api/deliveries/route");
let preview: typeof import("../app/api/tasks/preview/route");
let overview: typeof import("../app/api/overview/route");
let session: typeof import("../app/api/session/route");
let database: typeof import("../lib/db");
let health: typeof import("../app/api/health/route");
let cancellation: typeof import("../app/api/deliveries/[id]/cancel/route");
let attempts: typeof import("../app/api/deliveries/[id]/attempts/route");
let deliveryRetry: typeof import("../app/api/deliveries/[id]/retry/route");
let audit: typeof import("../app/api/audit/route");
let devices: typeof import("../app/api/devices/route");
let security: typeof import("../app/api/security/route");
let upcoming: typeof import("../app/api/upcoming/route");
before(async () => {
  auth = await import("../lib/auth"); tasks = await import("../app/api/tasks/route"); task = await import("../app/api/tasks/[id]/route");
  settings = await import("../app/api/settings/route"); deliveries = await import("../app/api/deliveries/route");
  preview = await import("../app/api/tasks/preview/route"); overview = await import("../app/api/overview/route"); session = await import("../app/api/session/route");
  database = await import("../lib/db");
  health = await import("../app/api/health/route");
  cancellation = await import("../app/api/deliveries/[id]/cancel/route");
  attempts = await import("../app/api/deliveries/[id]/attempts/route");
  deliveryRetry = await import("../app/api/deliveries/[id]/retry/route");
  audit = await import("../app/api/audit/route"); devices = await import("../app/api/devices/route");
  security = await import("../app/api/security/route"); upcoming = await import("../app/api/upcoming/route");
});
after(() => rmSync(directory, { recursive: true, force: true }));

function request(path: string, method = "GET", body?: unknown, authorized = true, extraHeaders: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, { method, headers: { host: "localhost:3000", "content-type": "application/json", ...(authorized ? { cookie: `barker_session=${auth.createSessionToken()}` } : {}), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const input = { name: "API reminder", description: "First line\nSecond line", startsAt: "2030-11-05T09:00:00+08:00", preset: "weekdays" as const, cron: "0 9 * * 1-5", repeatCount: 3, endDate: null };

test("all workspace data endpoints reject unauthorized reads and mutations", async () => {
  for (const handler of [tasks.GET, settings.GET, deliveries.GET, overview.GET]) assert.equal((await handler(request("/api", "GET", undefined, false))).status, 401);
  assert.equal((await tasks.POST(request("/api/tasks", "POST", input, false))).status, 401);
  assert.equal((await settings.PUT(request("/api/settings", "PUT", {}, false))).status, 401);
});

test("password login sets an HttpOnly session and logout clears it", async () => {
  const response = await session.POST(request("/api/session", "POST", { password: "api-test-password-1234" }, false));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Lax/);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const logout = await session.DELETE(request("/api/session", "DELETE", undefined, false, { cookie }));
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await (await session.GET(request("/api/session", "GET", undefined, false, { cookie }))).json()).authenticated, false);
});

test("repeated wrong logins lock out further guesses including correct passwords", async () => {
  let failed: Response | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) failed = await session.POST(request("/api/session", "POST", { password: "wrong password" }, false));
  assert.equal(failed?.status, 429);
  assert.ok(Number(failed?.headers.get("retry-after")) > 0);
  const correct = await session.POST(request("/api/session", "POST", { password: "api-test-password-1234" }, false));
  assert.equal(correct.status, 429);
  const change = await security.POST(request("/api/security", "POST", { action: "password", current: "api-test-password-1234", next: "new-api-test-password" }));
  assert.equal(change.status, 429);
  assert.ok(Number(change.headers.get("retry-after")) > 0);
});

test("settings roundtrip never returns the device key and empty edits preserve it", async () => {
  const value = { endpoint: "https://example.test", deviceKey: "secret-device-key", title: "Barker", sound: "", group: "Barker", icon: "" };
  const revision = database.settingsRevision();
  assert.equal((await settings.PUT(request("/api/settings", "PUT", { ...value, revision }))).status, 200);
  assert.equal((await settings.PUT(request("/api/settings", "PUT", { ...value, revision: revision + 1, deviceKey: "", group: "Personal" }))).status, 200);
  const payload = await (await settings.GET(request("/api/settings"))).json();
  assert.equal(payload.deviceKeyConfigured, true);
  assert.equal(payload.settings.group, "Personal");
  assert.equal(JSON.stringify(payload).includes("secret-device-key"), false);
  assert.equal(payload.settings.deviceKey, undefined);
});

test("create, preview, pause, edit and archive form a complete authenticated workflow", async (testContext) => {
  testContext.mock.timers.enable({ apis: ["Date"], now: new Date(input.startsAt) });
  const previewResponse = await preview.POST(request("/api/tasks/preview", "POST", input));
  assert.equal(previewResponse.status, 200);
  const dates = (await previewResponse.json()).dates;
  assert.equal(dates.length, 3);
  const created = await tasks.POST(request("/api/tasks", "POST", input));
  assert.equal(created.status, 201);
  const entity = (await created.json()).task;
  assert.equal(entity.nextRunAt, dates[0]);
  const context = { params: Promise.resolve({ id: entity.id }) };
  assert.equal((await task.PATCH(request(`/api/tasks/${entity.id}`, "PATCH", { status: "paused", revision: entity.revision }), context)).status, 200);
  assert.equal((await task.PUT(request(`/api/tasks/${entity.id}`, "PUT", { ...input, name: "Updated", revision: entity.revision + 1 }), context)).status, 200);
  assert.equal((await task.DELETE(request(`/api/tasks/${entity.id}`, "DELETE", undefined, true, { "if-match": String(entity.revision + 2) }), context)).status, 200);
  const listing = await (await tasks.GET(request("/api/tasks?status=archived&page=1"))).json();
  assert.equal(listing.tasks[0].name, "Updated");
  assert.equal(listing.tasks[0].status, "archived");
});

test("settings reject stale revisions and endpoint changes without a new key", async () => {
  const previous = database.readSettings();
  const revision = database.settingsRevision();
  assert.equal((await settings.PUT(request("/api/settings", "PUT", { ...previous, revision: revision - 1 }))).status, 409);
  assert.equal((await settings.PUT(request("/api/settings", "PUT", { ...previous, deviceKey: "", endpoint: "https://other.test", revision }))).status, 400);
  assert.equal(database.readSettings().endpoint, previous.endpoint);
});

test("settings can explicitly remove a stored device key without changing the endpoint", async () => {
  const previous = database.readSettings();
  const revision = database.settingsRevision();
  assert.equal((await settings.PUT(request("/api/settings", "PUT", { ...previous, deviceKey: "", clearDeviceKey: true, revision }))).status, 200);
  assert.equal(database.readSettings().deviceKey, "");
  const next = database.settingsRevision();
  assert.equal((await settings.PUT(request("/api/settings", "PUT", { ...previous, deviceKey: "replacement-device-key", revision: next }))).status, 200);
  assert.equal(database.readSettings().deviceKey, "replacement-device-key");
});

test("task mutation requires revisions and idempotent creation does not duplicate a request", async () => {
  const key = "idempotent-task-creation-key";
  const first = await tasks.POST(request("/api/tasks", "POST", input, true, { "idempotency-key": key }));
  const second = await tasks.POST(request("/api/tasks", "POST", input, true, { "idempotency-key": key }));
  const entity = (await first.json()).task;
  assert.equal((await second.json()).task.id, entity.id);
  assert.equal((await tasks.POST(request("/api/tasks", "POST", { ...input, name: "Different" }, true, { "idempotency-key": key }))).status, 409);
  const context = { params: Promise.resolve({ id: entity.id }) };
  assert.equal((await task.PATCH(request(`/api/tasks/${entity.id}`, "PATCH", { status: "paused" }), context)).status, 428);
  assert.equal((await task.PATCH(request(`/api/tasks/${entity.id}`, "PATCH", { status: "paused", revision: 999 }), context)).status, 409);
});

test("database write failures log once with a request ID and return a sanitized 500", async (context) => {
  const logged = context.mock.method(console, "error", () => {});
  const raw = database.__rawDatabaseForTests();
  const authenticatedRequest = request("/api/tasks", "POST", input);
  raw.exec("PRAGMA query_only=ON");
  try {
    const response = await tasks.POST(authenticatedRequest);
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(await response.json()), /readonly|sqlite|SQLITE/i);
    assert.equal(logged.mock.callCount(), 1);
    const record = JSON.parse(String(logged.mock.calls[0].arguments[0]));
    assert.equal(record.event, "api.failed");
    assert.equal(record.requestId, response.headers.get("x-request-id"));
  } finally { raw.exec("PRAGMA query_only=OFF"); }
});

test("invalid pagination, dates, limits, and nonexistent task IDs return errors", async () => {
  assert.equal((await tasks.GET(request("/api/tasks?page=Infinity"))).status, 400);
  assert.equal((await deliveries.GET(request("/api/deliveries?pageSize=100000"))).status, 400);
  assert.equal((await tasks.POST(request("/api/tasks", "POST", { ...input, repeatCount: 0 }))).status, 400);
  assert.equal((await preview.POST(request("/api/tasks/preview", "POST", { ...input, endDate: "2020-01-01", repeatCount: null }))).status, 400);
  assert.equal((await task.DELETE(request("/api/tasks/missing", "DELETE"), { params: Promise.resolve({ id: "missing" }) })).status, 404);
  assert.equal((await upcoming.GET(request("/api/upcoming?after=2030-11-05T01:00:00Z"))).status, 400);
  assert.equal((await upcoming.GET(request("/api/upcoming?task=cursor-without-time"))).status, 400);
  assert.equal((await upcoming.GET(request("/api/upcoming?task=invalid-date&after=2030-02-31T01:00:00Z"))).status, 400);
});

test("bulk status writes prevalidate the batch and roll back on storage errors", async () => {
  const first = database.createTask({ ...input, name: "Atomic first" });
  const second = database.createTask({ ...input, name: "Atomic second" });
  const items = [first, second].map(({ id, revision }) => ({ id, revision }));
  const patch = (status: unknown, batch: unknown[]) => tasks.PATCH(request("/api/tasks", "PATCH", { status, items: batch }));
  assert.equal((await patch(["paused"], items)).status, 400);
  assert.equal((await patch("paused", [items[0], null])).status, 400);
  assert.equal(database.getTask(first.id)?.status, "active");
  const raw = database.__rawDatabaseForTests();
  raw.exec("CREATE TRIGGER fail_batch BEFORE UPDATE OF status ON tasks WHEN NEW.name = 'Atomic second' BEGIN SELECT RAISE(ABORT, 'write failed'); END;");
  try {
    assert.equal((await patch("paused", items)).status, 500);
    assert.equal(database.getTask(first.id)?.status, "active");
  } finally { raw.exec("DROP TRIGGER fail_batch"); }
  const response = await patch("paused", [items[0], { ...items[1], revision: items[1].revision + 1 }]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results.map((item: { success: boolean }) => item.success), [true, false]);
  assert.equal(database.getTask(first.id)?.status, "paused");
  assert.equal(database.getTask(second.id)?.status, "active");
});

test("security audit requires a session and device updates require a non-empty ID", async () => {
  const token = auth.createApiToken("API reader", "read", 1);
  assert.equal((await tasks.GET(request("/api/tasks", "GET", undefined, false, { authorization: `Bearer ${token}` }))).status, 200);
  assert.equal((await audit.GET(request("/api/audit", "GET", undefined, false, { authorization: `Bearer ${token}` }))).status, 401);
  assert.equal((await audit.GET(request("/api/audit"))).status, 200);
  const device = { name: "Test device", endpoint: "https://example.test", deviceKey: "test-device-key" };
  assert.equal((await devices.POST(request("/api/devices", "POST", { ...device, id: "" }))).status, 400);
  assert.equal((await devices.POST(request("/api/devices", "POST", device))).status, 200);
});

test("health requires a writable database and a fresh enabled scheduler", async () => {
  const previous = process.env.BARKER_DISABLE_SCHEDULER;
  const raw = database.__rawDatabaseForTests();
  try {
    process.env.BARKER_DISABLE_SCHEDULER = "1";
    database.writeRuntimeState("scheduler_heartbeat", String(Date.now()));
    assert.equal((await health.GET()).status, 503);
    delete process.env.BARKER_DISABLE_SCHEDULER;
    assert.equal((await health.GET()).status, 200);
    raw.exec("PRAGMA query_only=ON");
    assert.equal((await health.GET()).status, 503);
    raw.exec("PRAGMA query_only=OFF");
    database.writeRuntimeState("scheduler_heartbeat", String(Date.now() - 16_000));
    assert.equal((await health.GET()).status, 503);
    database.writeRuntimeState("scheduler_heartbeat", String(Date.now() + 60_000));
    assert.equal((await health.GET()).status, 503);
  } finally {
    raw.exec("PRAGMA query_only=OFF");
    if (previous === undefined) delete process.env.BARKER_DISABLE_SCHEDULER;
    else process.env.BARKER_DISABLE_SCHEDULER = previous;
  }
});

test("authentication storage failures return 500 rather than logging the user out", async () => {
  const authenticated = request("/api/tasks");
  const raw = database.__rawDatabaseForTests();
  raw.exec("ALTER TABLE sessions RENAME TO sessions_unavailable");
  try { assert.equal((await tasks.GET(authenticated)).status, 500); }
  finally { raw.exec("ALTER TABLE sessions_unavailable RENAME TO sessions"); }
});

test("delivery cancellation and attempt history follow authentication and retention contracts", async () => {
  const reminder = database.createTask({ ...input, name: "Cancellation API", preset: "daily", cron: "0 9 * * *", startsAt: "2030-11-05T09:00:00+08:00" });
  database.queueTaskBatch(reminder.id, new Date(reminder.nextRunAt!), 1);
  const item = database.listDeliveries({ page: 1, pageSize: 10, q: "Cancellation API" }).deliveries[0];
  const context = { params: Promise.resolve({ id: item.id }) };
  const historyPath = `/api/deliveries/${item.id}/attempts`;
  const cancelPath = `/api/deliveries/${item.id}/cancel`;
  assert.equal((await attempts.GET(request(historyPath, "GET", undefined, false), context)).status, 401);
  assert.equal((await cancellation.POST(request(cancelPath, "POST", {}, false), context)).status, 401);
  assert.equal((await cancellation.POST(request(cancelPath, "POST", {}, true, { origin: "https://evil.example" }), context)).status, 403);
  assert.deepEqual(await (await attempts.GET(request(historyPath), context)).json(), { attempts: [] });
  assert.equal((await deliveries.PATCH(request("/api/deliveries", "PATCH", { action: ["cancel"], ids: [item.id] }))).status, 400);
  assert.equal((await cancellation.POST(request("/api/deliveries/missing/cancel", "POST", {}), { params: Promise.resolve({ id: "missing" }) })).status, 404);
  assert.equal((await cancellation.POST(request(cancelPath, "POST", {}), context)).status, 200);
  assert.equal((await cancellation.POST(request(cancelPath, "POST", {}), context)).status, 409);
  const listing = await (await deliveries.GET(request("/api/deliveries?status=cancelled&q=Cancellation%20API&page=999"))).json();
  assert.equal(listing.page, 1);
  assert.equal(listing.total, 1);
  assert.equal(listing.deliveries[0].taskName, "Cancellation API");
  assert.equal(database.getTask(reminder.id)?.queuedCount, 1);
  assert.equal(database.getTask(reminder.id)?.sentCount, 0);
});

test("delivery retry distinguishes a missing record from a state conflict", async () => {
  const missing = await deliveryRetry.POST(request("/api/deliveries/missing/retry", "POST", {}), { params: Promise.resolve({ id: "missing" }) });
  assert.equal(missing.status, 404);
  const reminder = database.createTask({ ...input, name: "Retry status API", preset: "daily", cron: "0 9 * * *", startsAt: "2030-11-05T09:00:00+08:00" });
  database.queueTaskBatch(reminder.id, new Date(reminder.nextRunAt!), 1);
  const item = database.listDeliveries({ page: 1, pageSize: 10, q: "Retry status API" }).deliveries[0];
  database.__rawDatabaseForTests().prepare("UPDATE deliveries SET status = 'sent' WHERE id = ?").run(item.id);
  const conflict = await deliveryRetry.POST(request(`/api/deliveries/${item.id}/retry`, "POST", {}), { params: Promise.resolve({ id: item.id }) });
  assert.equal(conflict.status, 409);
});
