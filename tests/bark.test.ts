import assert from "node:assert/strict";
import { test } from "node:test";
import { BarkDeliveryError, sendBark } from "../lib/bark";
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

test("a query string or fragment in the endpoint cannot misroute the push", async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ code: 200 });
  };
  await sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test/?k=1", deviceKey: "key" }, "T", "B", fetcher);
  await sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test/#frag", deviceKey: "key" }, "T", "B", fetcher);
  assert.deepEqual(urls, ["https://example.test/push", "https://example.test/push"]);
});

test("a non-JSON 2xx is a failure (captive portal / proxy page), not a delivery", async () => {
  await assert.rejects(
    sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test", deviceKey: "key" }, "T", "B", async () =>
      new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html" } })),
    /非 JSON/,
  );
  // Empty 2xx stays valid for Bark-compatible servers.
  await sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test", deviceKey: "key" }, "T", "B", async () => new Response("", { status: 200 }));
});

test("numeric-string codes are accepted and 4xx/5xx are classified", async () => {
  await sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test", deviceKey: "key" }, "T", "B", async () => Response.json({ code: "200" }));
  await assert.rejects(
    sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test", deviceKey: "key" }, "T", "B", async () => new Response("", { status: 404 })),
    (error: unknown) => error instanceof BarkDeliveryError && error.kind === "permanent",
  );
  await assert.rejects(
    sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test", deviceKey: "key" }, "T", "B", async () => new Response("", { status: 503 })),
    (error: unknown) => error instanceof BarkDeliveryError && error.kind === "transient",
  );
});
