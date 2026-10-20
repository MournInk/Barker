import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("failed login state stays bounded when clients rotate addresses", () => {
  const base = 10_000_000_000_000;
  for (let i = 0; i < 5000; i += 1) auth.verifyPassword("bad", base + i, `rotating-client-${i}`);
  const size = auth.__failedLoginsSizeForTests();
  assert.ok(size > 0 && size <= 1000, `failed-login map is not bounded: ${size} entries`);
  // A fresh client still gets the documented 5-failure / 10-minute lockout.
  const client = "rotating-client-after-cap";
  for (let i = 0; i < 5; i += 1) assert.equal(auth.verifyPassword("bad", base + 10_000 + i, client), false);
  assert.equal(auth.verifyPassword("test-access-password", base + 10_100, client), false);
  assert.equal(auth.verifyPassword("test-access-password", base + 10_100 + 601_000, client), true);
  // Entries whose window and lockout have both expired are pruned.
  assert.equal(auth.__pruneFailedLoginsForTests(base + 3_600_000), 0);
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

function runAuthModule(dir: string, extraEnv: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", "import('./lib/auth.ts').catch((error) => { console.error(error.message); process.exit(1); });"],
    {
      cwd: process.cwd(),
      env: { ...process.env, BARKER_DATA_DIR: dir, BARKER_PASSWORD: "test-access-password", BARKER_SESSION_SECRET: "", ...extraEnv },
      encoding: "utf8",
    },
  );
  return { status: result.status, stderr: result.stderr };
}

test("empty or weak secret files fail fast instead of allowing a login bypass", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "barker-secret-empty-"));
  writeFileSync(join(emptyDir, "session-secret.txt"), "\n", { mode: 0o600 });
  const empty = runAuthModule(emptyDir, {});
  rmSync(emptyDir, { recursive: true, force: true });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /empty or too short/);

  const weakEnvDir = mkdtempSync(join(tmpdir(), "barker-secret-env-"));
  const weak = runAuthModule(weakEnvDir, { BARKER_SESSION_SECRET: "short" });
  rmSync(weakEnvDir, { recursive: true, force: true });
  assert.notEqual(weak.status, 0);
  assert.match(weak.stderr, /at least 16 characters/);
});

test("concurrent first boot agrees on a single generated session secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "barker-secret-race-"));
  const env = { ...process.env, BARKER_DATA_DIR: dir, BARKER_PASSWORD: "test-access-password", BARKER_SESSION_SECRET: "" };
  const results = Array.from({ length: 4 }, () =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "--eval", "import('./lib/auth.ts').then(() => { const { readFileSync } = require('node:fs'); console.log(readFileSync(process.env.BARKER_DATA_DIR + '/session-secret.txt', 'utf8').trim()); });"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    ),
  );
  const secrets = results.map((result) => result.stdout.trim()).filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(secrets.length, 4);
  assert.equal(new Set(secrets).size, 1, "all workers must share one secret");
});

test("Secure cookie only follows an explicit trust decision", () => {
  const request = new Request("http://localhost:3000", { headers: { "x-forwarded-proto": "https" } });
  delete process.env.BARKER_TRUST_PROXY;
  delete process.env.BARKER_COOKIE_SECURE;
  assert.equal(auth.requestUsesHttps(request), false, "spoofable header alone must not force Secure");
  process.env.BARKER_COOKIE_SECURE = "1";
  assert.equal(auth.requestUsesHttps(request), true);
  delete process.env.BARKER_COOKIE_SECURE;
  process.env.BARKER_TRUST_PROXY = "1";
  assert.equal(auth.requestUsesHttps(request), true);
  delete process.env.BARKER_TRUST_PROXY;
});
