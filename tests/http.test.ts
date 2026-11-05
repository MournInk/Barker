import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, MAX_REQUEST_BYTES, requestBody, requireSameOriginMutation } from "../lib/http";

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/tasks", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...headers }, body });
}

test("bounded JSON parser accepts a small document and rejects invalid JSON", async () => {
  assert.deepEqual(await requestBody(jsonRequest('{"name":"Reminder"}')), { name: "Reminder" });
  await assert.rejects(requestBody(jsonRequest("not json")), (error) => error instanceof HttpError && error.status === 400);
});

test("body limit is enforced on both declared length and actual streamed bytes", async () => {
  await assert.rejects(requestBody(jsonRequest("{}", { "content-length": String(MAX_REQUEST_BYTES + 1) })), (error) => error instanceof HttpError && error.status === 413);
  await assert.rejects(requestBody(jsonRequest(JSON.stringify({ text: "x".repeat(MAX_REQUEST_BYTES) }))), (error) => error instanceof HttpError && error.status === 413);
});

test("mutations reject cross-origin requests and non-JSON forms", () => {
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { origin: "https://evil.example" }))?.status, 403);
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { "sec-fetch-site": "same-site" }))?.status, 403);
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { "content-type": "text/plain" }))?.status, 415);
  assert.equal(requireSameOriginMutation(jsonRequest("{}", { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })), null);
});
