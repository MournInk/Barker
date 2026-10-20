import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "barker-auth-"));
process.env.BARKER_DATA_DIR = directory;
process.env.BARKER_PASSWORD = "test-access-password";
after(() => rmSync(directory, { recursive: true, force: true }));

let auth: typeof import("../lib/auth");
before(async () => { auth = await import("../lib/auth"); });

test("password, signed session and expiry", () => {
  assert.equal(auth.verifyPassword("wrong", 1000, "auth-case"), false);
  assert.equal(auth.verifyPassword("test-access-password", 1001, "auth-case"), true);
  const token = auth.createSessionToken(1000);
  assert.equal(auth.isValidSessionToken(token, 1001), true);
  assert.equal(auth.isValidSessionToken(token, 1000 + 12 * 60 * 60 * 1000), false);
  assert.equal(auth.isValidSessionToken(`${token}broken`, 1001), false);
});

test("repeated failures lock a client temporarily", () => {
  for (let i = 0; i < 5; i += 1) auth.verifyPassword("bad", 1000 + i, "limited-client");
  assert.equal(auth.verifyPassword("test-access-password", 1100, "limited-client"), false);
  assert.equal(auth.verifyPassword("test-access-password", 601_005, "limited-client"), true);
});

test("session cookies follow HTTP or HTTPS and malformed cookies are ignored", () => {
  assert.equal(auth.getCookieValue("barker_session=%bad"), null);
  assert.equal(auth.requestUsesHttps(new Request("http://localhost:3000")), false);
  assert.doesNotMatch(auth.setSessionCookie("abc"), /Secure/);
  assert.match(auth.setSessionCookie("abc", true), /Secure/);
});

test("proxy headers are ignored unless explicitly trusted", () => {
  const request = new Request("http://localhost:3000", {
    headers: { "x-forwarded-proto": "https", "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" },
  });
  delete process.env.BARKER_TRUST_PROXY;
  assert.equal(auth.requestUsesHttps(request), false);
  assert.equal(auth.clientKeyFor(request), "local");
  process.env.BARKER_TRUST_PROXY = "1";
  assert.equal(auth.requestUsesHttps(request), true);
  assert.equal(auth.clientKeyFor(request), "9.9.9.9");
  assert.equal(auth.clientKeyFor(new Request("http://localhost:3000", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })), "5.6.7.8");
  delete process.env.BARKER_TRUST_PROXY;
});
