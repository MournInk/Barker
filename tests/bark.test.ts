import assert from "node:assert/strict";
import { test } from "node:test";
import { barkPayload, BarkDeliveryError, retryAfter, sendBark } from "../lib/bark";
import { DEFAULT_SETTINGS } from "../lib/types";

test("Bark receives the configured endpoint and message", async () => {
  let request: { url: string; body: Record<string, string>; redirect: RequestRedirect | undefined } | undefined;
  await sendBark({ ...DEFAULT_SETTINGS, endpoint: "https://example.test/", deviceKey: "key" }, "Rent", "Pay today", async (url, init) => {
    request = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, string>, redirect: init?.redirect };
    return Response.json({ code: 200 });
  });
  assert.equal(request?.url, "https://example.test/push");
  assert.equal(request?.body.device_key, "key");
  assert.equal(request?.body.title, "Rent");
  assert.equal(request?.body.body, "Pay today");
  assert.equal(request?.redirect, "manual", "never forward a device key to a redirect target");
});

test("Bark application errors and missing credentials fail delivery", async () => {
  await assert.rejects(sendBark(DEFAULT_SETTINGS, "Title", "Body"), /Device Key/);
  await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: "secret-device" }, "Title", "Body", async () => Response.json({ code: 400, message: "bad credentials" })), /bad credentials/);
});

test("coercible acknowledgement codes cannot mark a delivery sent", async () => {
  for (const code of [[200], ["200"], "0xC8", "0200", "200.0", true, null, { valueOf: 200 }]) {
    await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: "key" }, "T", "B", async () => Response.json({ code })), /无法识别/);
  }
});

test("upstream and network errors redact both literal and URL-encoded keys", async () => {
  const key = "private/key?token";
  for (const fail of [async () => Response.json({ code: 400, message: `Rejected ${key} ${encodeURIComponent(key)}` }), async () => { throw new Error(`Connection to ${key}`); }]) {
    await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: key }, "T", "B", fail), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes(encodeURIComponent(key)), false);
      return true;
    });
  }
});

test("Retry-After accepts delta seconds and dates on throttled upstreams", async () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(retryAfter("3600", now)?.getTime(), now + 3_600_000);
  assert.equal(retryAfter("Tue, 01 Jan 2030 01:00:00 GMT", now)?.getTime(), now + 3_600_000);
  assert.equal(retryAfter("invalid", now), undefined);
  await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: "k" }, "T", "B", async () => new Response("", { status: 429, headers: { "retry-after": "3600" } })), (error: unknown) => error instanceof BarkDeliveryError && Boolean(error.retryAt && error.retryAt.getTime() > Date.now() + 3_590_000));
});

test("final serialized UTF-8 payload is bounded before sending", () => {
  assert.throws(() => barkPayload({ ...DEFAULT_SETTINGS, deviceKey: "k" }, "标题", "中".repeat(2000)), /4096/);
  assert.ok(Buffer.byteLength(barkPayload({ ...DEFAULT_SETTINGS, deviceKey: "k" }, "标题", "中".repeat(800))) < 4096);
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
  // HTTP success without Bark acknowledgement is not proof of delivery.
  for (const body of ["", "{}", "null", "[]"]) {
    await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: "key" }, "T", "B", async () => new Response(body, { status: 200 })), /无法识别/);
  }
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

test("redirect responses are reported without following or leaking the device key", async () => {
  let requested = "";
  const settings = { ...DEFAULT_SETTINGS, endpoint: "http://example.test", deviceKey: "private-device-key" };
  await assert.rejects(sendBark(settings, "T", "B", async (input, init) => {
    requested = String(input);
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 301, headers: { location: "https://other.test/push" } });
  }), (error: unknown) => error instanceof BarkDeliveryError && error.status === 301 && /301/.test(error.message));
  assert.equal(requested, "http://example.test/push");
});

test("oversized responses cannot be mistaken for acknowledged delivery", async () => {
  await assert.rejects(
    sendBark({ ...DEFAULT_SETTINGS, deviceKey: "key" }, "T", "B", async () => Response.json({ code: 200, padding: "x".repeat(17_000) })),
    /响应过大/,
  );
});

test("HTTP throttling is honored without waiting for its response body", async () => {
  const body = new ReadableStream({ start() {} });
  await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: "key" }, "T", "B", async () => new Response(body, { status: 429, headers: { "retry-after": "3600" } })),
    (error: unknown) => error instanceof BarkDeliveryError && error.status === 429 && Boolean(error.retryAt));
});

test("application-level 503 is transient and HTTP 413 is scoped to the payload", async () => {
  await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: "key" }, "T", "B", async () => Response.json({ code: 503 })),
    (error: unknown) => error instanceof BarkDeliveryError && error.kind === "transient");
  await assert.rejects(sendBark({ ...DEFAULT_SETTINGS, deviceKey: "key" }, "T", "B", async () => new Response("", { status: 413 })),
    (error: unknown) => error instanceof BarkDeliveryError && error.scope === "payload");
});
