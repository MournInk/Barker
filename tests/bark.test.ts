import assert from "node:assert/strict";
import { test } from "node:test";
import { sendBark } from "../lib/bark";
import { DEFAULT_SETTINGS } from "../lib/types";

test("Bark receives the configured endpoint and message", async () => {
  let request: { url: string; body: Record<string, string> } | undefined;
  await sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test/", deviceKey: "key" }, "Rent", "Pay today", async (url, init) => {
    request = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, string> };
    return Response.json({ code: 200 });
  });
  assert.equal(request?.url, "https://example.test/push");
  assert.equal(request?.body.device_key, "key");
  assert.equal(request?.body.title, "Rent");
  assert.equal(request?.body.body, "Pay today");
});

test("Bark application errors and missing credentials fail delivery", async () => {
  await assert.rejects(sendBark(DEFAULT_SETTINGS, "Title", "Body"), /Device Key/);
  await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: "key" }, "Title", "Body", async () => Response.json({ code: 400, message: "bad key" })), /bad key/);
});
