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
before(async () => {
  auth = await import("../lib/auth"); tasks = await import("../app/api/tasks/route"); task = await import("../app/api/tasks/[id]/route");
  settings = await import("../app/api/settings/route"); deliveries = await import("../app/api/deliveries/route");
  preview = await import("../app/api/tasks/preview/route"); overview = await import("../app/api/overview/route"); session = await import("../app/api/session/route");
});
after(() => rmSync(directory, { recursive: true, force: true }));

function request(path: string, method = "GET", body?: unknown, authorized = true) {
  return new Request(`http://localhost:3000${path}`, { method, headers: { host: "localhost:3000", "content-type": "application/json", ...(authorized ? { cookie: `barker_session=${auth.createSessionToken()}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const input = { name: "API reminder", description: "First line\nSecond line", startsAt: "2030-11-05T09:00:00+08:00", preset: "weekdays", cron: "0 9 * * 1-5", repeatCount: 3, endDate: null };

test("all workspace data endpoints reject unauthorized reads and mutations", async () => {
  for (const handler of [tasks.GET, settings.GET, deliveries.GET, overview.GET]) assert.equal((await handler(request("/api", "GET", undefined, false))).status, 401);
  assert.equal((await tasks.POST(request("/api/tasks", "POST", input, false))).status, 401);
  assert.equal((await settings.PUT(request("/api/settings", "PUT", {}, false))).status, 401);
});

test("password login sets an HttpOnly session and logout clears it", async () => {
  const response = await session.POST(request("/api/session", "POST", { password: "api-test-password-1234" }, false));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Lax/);
  const logout = await session.DELETE(request("/api/session", "DELETE"));
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("settings roundtrip never returns the device key and empty edits preserve it", async () => {
  const value = { endpoint: "https://example.test", deviceKey: "secret-device-key", title: "Barker", sound: "", group: "Barker", icon: "" };
  assert.equal((await settings.PUT(request("/api/settings", "PUT", value))).status, 200);
  assert.equal((await settings.PUT(request("/api/settings", "PUT", { ...value, deviceKey: "", group: "Personal" }))).status, 200);
  const payload = await (await settings.GET(request("/api/settings"))).json();
  assert.equal(payload.deviceKeyConfigured, true);
  assert.equal(payload.settings.group, "Personal");
  assert.equal(JSON.stringify(payload).includes("secret-device-key"), false);
  assert.equal(payload.settings.deviceKey, undefined);
});

test("create, preview, pause, edit and archive form a complete authenticated workflow", async () => {
  const previewResponse = await preview.POST(request("/api/tasks/preview", "POST", input));
  assert.equal(previewResponse.status, 200);
  const dates = (await previewResponse.json()).dates;
  assert.equal(dates.length, 3);
  const created = await tasks.POST(request("/api/tasks", "POST", input));
  assert.equal(created.status, 201);
  const entity = (await created.json()).task;
  assert.equal(entity.nextRunAt, dates[0]);
  const context = { params: Promise.resolve({ id: entity.id }) };
  assert.equal((await task.PATCH(request(`/api/tasks/${entity.id}`, "PATCH", { status: "paused" }), context)).status, 200);
  assert.equal((await task.PUT(request(`/api/tasks/${entity.id}`, "PUT", { ...input, name: "Updated" }), context)).status, 200);
  assert.equal((await task.DELETE(request(`/api/tasks/${entity.id}?force=1`, "DELETE"), context)).status, 200);
  const listing = await (await tasks.GET(request("/api/tasks?status=archived&page=1"))).json();
  assert.equal(listing.tasks[0].name, "Updated");
  assert.equal(listing.tasks[0].status, "archived");
});

test("invalid pagination, dates, limits, and nonexistent task IDs return errors", async () => {
  assert.equal((await tasks.GET(request("/api/tasks?page=Infinity"))).status, 400);
  assert.equal((await deliveries.GET(request("/api/deliveries?pageSize=100000"))).status, 400);
  assert.equal((await tasks.POST(request("/api/tasks", "POST", { ...input, repeatCount: 0 }))).status, 400);
  assert.equal((await preview.POST(request("/api/tasks/preview", "POST", { ...input, endDate: "2020-01-01", repeatCount: null }))).status, 400);
  assert.equal((await task.DELETE(request("/api/tasks/missing", "DELETE"), { params: Promise.resolve({ id: "missing" }) })).status, 404);
});
