import assert from "node:assert/strict";
import { test } from "node:test";
import { apiRoute, HttpError, jsonErrorFrom, MAX_REQUEST_BYTES, requestBody, requireSameOriginMutation } from "../lib/http";
import { redactSecrets } from "../lib/errors";

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/tasks", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...headers }, body });
}

test("bounded JSON parser accepts a small document and rejects invalid JSON", async () => {
  assert.deepEqual(await requestBody(jsonRequest('{"name":"Reminder"}')), { name: "Reminder" });
  assert.deepEqual(await requestBody(jsonRequest("\uFEFF{\"name\":\"Reminder\"}")), { name: "Reminder" });
  await assert.rejects(requestBody(jsonRequest("not json")), (error) => error instanceof HttpError && error.status === 400);
});

test("body limit is enforced on both declared length and actual streamed bytes", async () => {
  await assert.rejects(requestBody(jsonRequest("{}", { "content-length": String(MAX_REQUEST_BYTES + 1) })), (error) => error instanceof HttpError && error.status === 413);
  await assert.rejects(requestBody(jsonRequest(JSON.stringify({ text: "x".repeat(MAX_REQUEST_BYTES) }))), (error) => error instanceof HttpError && error.status === 413);
});

test("mutations reject oversized bodies, cross-origin requests and non-JSON forms", () => {
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { "content-length": String(MAX_REQUEST_BYTES + 1) }))?.status, 413);
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { origin: "https://evil.example" }))?.status, 403);
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { "sec-fetch-site": "same-site" }))?.status, 403);
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { "content-type": "text/plain" }))?.status, 415);
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { "content-type": "application/jsonp" }))?.status, 415);
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })), null);
});

test("unexpected backend failures map to 500 without exposing their message", async () => {
  const response = jsonErrorFrom(new Error("SQLITE_READONLY: sensitive path"));
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /SQLITE|sensitive/);
});

test("the API boundary converts authentication or storage failures into sanitized JSON", async () => {
  const handler = apiRoute(async () => { throw new Error("SQLITE_IOERR: /private/data/barker.sqlite"); });
  const response = await handler();
  assert.equal(response.status, 500);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { error: "服务暂时无法完成请求，请稍后重试" });
});

test("literal and encoded secrets are redacted without rescanning replacement markers", () => {
  assert.equal(redactSecrets("key=?a.b and %3Fa.b or redact", ["?a.b", "redact"]), "key=[redacted] and [redacted] or [redacted]");
});
