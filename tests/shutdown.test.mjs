import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("disabled scheduler still initializes the generated runtime password", { timeout: 10_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "barker-disabled-scheduler-"));
  const env = { ...process.env, NEXT_RUNTIME: "nodejs", BARKER_DATA_DIR: directory, BARKER_DISABLE_SCHEDULER: "1" };
  delete env.BARKER_PASSWORD;
  delete env.BARKER_SESSION_SECRET;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", "import('./instrumentation.ts').then(({ register }) => register())"], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 8_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Barker access password: \S+/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the server supervisor drains an in-flight delivery before forwarding SIGTERM", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "barker-shutdown-"));
  const entry = join(directory, "server.mjs");
  writeFileSync(entry, `
    import * as db from ${JSON.stringify(pathToFileURL(resolve("lib/db.ts")).href)};
    import * as scheduler from ${JSON.stringify(pathToFileURL(resolve("lib/scheduler.ts")).href)};
    const due = new Date('2030-01-01T00:00:00Z');
    db.createTask({ name: 'Shutdown', startsAt: due.toISOString(), preset: 'custom', cron: '* * * * *', repeatCount: 1 }, due);
    let begun;
    const ready = new Promise(resolve => { begun = resolve; });
    const cycle = scheduler.runSchedulerCycle(due, async () => {
      begun();
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    await ready;
    scheduler.startScheduler();
    process.once('SIGTERM', () => {
      console.log('FINAL:' + db.listDeliveries({ page: 1, pageSize: 1 }).deliveries[0].status);
      process.exit(0);
    });
    console.log('READY');
    await cycle;
  `);
  const child = spawn(process.execPath, ["scripts/start-server.mjs", "--import", "tsx", entry], {
    cwd: process.cwd(), env: { ...process.env, BARKER_DATA_DIR: directory, BARKER_DISABLE_SCHEDULER: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let started;
  const ready = new Promise((resolveReady) => { started = resolveReady; });
  child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("READY")) started(); });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { started(); resolveExit(code); });
  });
  try {
    await ready;
    assert.match(stdout, /READY/, stderr);
    child.kill("SIGTERM");
    assert.equal(await exited, 0, stderr);
    assert.match(stdout, /FINAL:sent/);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(`the browser server leaves no child process after group ${signal}`, { timeout: 10_000, skip: process.platform === "win32" }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "barker-browser-lifecycle-"));
    const entry = join(directory, ".next/standalone/server.js");
    mkdirSync(join(directory, ".next/static"), { recursive: true });
    mkdirSync(join(directory, ".next/standalone"), { recursive: true });
    writeFileSync(entry, `
      process.once('SIGTERM', () => process.exit(0));
      console.log('READY:' + JSON.stringify({ pid: process.pid, directory: process.env.BARKER_DATA_DIR }));
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, [resolve("scripts/browser-server.mjs")], {
      cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let server;
    let output = "";
    let errors = "";
    let ready;
    const started = new Promise((resolveReady) => { ready = resolveReady; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/READY:(.+)\n/);
      if (match) { server = JSON.parse(match[1]); ready(); }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    const exited = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => { ready(); resolveExit(code); });
    });
    try {
      await started;
      assert.ok(server, errors);
      process.kill(-child.pid, signal);
      const code = await exited;
      if (signal === "SIGTERM") {
        assert.equal(code, 0, errors);
        assert.equal(existsSync(server.directory), false);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      assert.throws(() => process.kill(server.pid, 0), { code: "ESRCH" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
      if (server) {
        try { process.kill(server.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        rmSync(server.directory, { recursive: true, force: true });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
