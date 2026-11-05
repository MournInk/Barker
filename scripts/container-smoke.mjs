import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

// Exercise only an isolated volume and a local fake Bark, never a real device.
const image = process.argv[2] || "barker:local";
const name = `barker-smoke-${process.pid}-${Date.now()}`;
const volume = `${name}-data`;
const deviceKey = "container-smoke-device";
let acknowledge = false;
const received = [];
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
const mock = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  received.push({ url: request.url, body: JSON.parse(text) });
  response.writeHead(acknowledge ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: acknowledge ? 200 : 503 }));
});

/** Poll a concrete condition, retaining its last error for useful diagnostics. */
async function until(check, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (failure) { error = failure; }
    await delay(500);
  }
  throw new Error(`Smoke check timed out${error ? `: ${error.message}` : ""}`);
}

let created = false;
try {
  docker("image", "inspect", image);
  await new Promise((resolve) => mock.listen(0, "0.0.0.0", resolve));
  const mockPort = mock.address().port;
  docker("run", "-d", "--init", "--name", name, "-p", "127.0.0.1::3000",
    ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
    "--mount", `type=volume,source=${volume},target=/app/data`, image);
  created = true;
  const address = () => `http://127.0.0.1:${docker("port", name, "3000/tcp").split(":").at(-1)}`;
  let base = address();
  await until(async () => (await fetch(`${base}/api/health`)).ok);
  assert.notEqual(docker("exec", name, "id", "-u"), "0", "runtime must be non-root");
  assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
  const password = docker("logs", name).match(/Barker access password: (\S+)/)?.[1];
  assert.ok(password, "runtime must generate and print a password");
  const login = await fetch(`${base}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  await api("/api/settings", "PUT", {
    endpoint: `http://host.docker.internal:${mockPort}`, deviceKey,
    title: "Barker", sound: "", group: "Smoke", icon: "",
  });
  const settings = await api("/api/settings");
  assert.equal(settings.deviceKeyConfigured, true);
  assert.equal(JSON.stringify(settings).includes(deviceKey), false);
  const startsAt = new Date(Math.ceil((Date.now() + 3000) / 60_000) * 60_000).toISOString();
  const { task } = await api("/api/tasks", "POST", {
    name: "Container restart reminder", description: "Immutable local smoke payload",
    startsAt, preset: "custom", cron: "* * * * *", repeatCount: 1, endDate: null,
  });
  console.log("Non-root startup, generated password, auth and settings: passed.");
  console.log(`Waiting for real scheduler occurrence at ${startsAt}...`);
  const failed = await until(async () => {
    const { deliveries } = await api("/api/deliveries?status=retrying");
    return deliveries.find((item) => item.taskId === task.id && item.attempts > 0);
  });
  assert.match(failed.lastError, /503/);
  await api(`/api/tasks/${task.id}`, "DELETE");
  docker("stop", "--time", "30", name);
  // Next 16 completes cleanup and exits with 128 + SIGTERM (143), not zero.
  const exitCode = Number(docker("inspect", name, "--format", "{{.State.ExitCode}}"));
  assert.ok([0, 143].includes(exitCode), `shutdown must finish without SIGKILL: ${exitCode}`);
  assert.equal(docker("inspect", name, "--format", "{{.State.OOMKilled}}"), "false");
  acknowledge = true;
  docker("start", name);
  // Docker can allocate a new host port when restarting a random-port binding.
  base = address();
  await until(async () => (await fetch(`${base}/api/health`)).ok);
  const { authenticated } = await api("/api/session");
  assert.equal(authenticated, true, "persisted signing secret must preserve the session");
  assert.equal((await api("/api/session", "POST", { password })).authenticated, true, "generated password must survive restart");
  const sent = await until(async () => {
    const { deliveries } = await api("/api/deliveries?status=sent");
    return deliveries.find((item) => item.id === failed.id);
  });
  assert.equal(sent.description, "Immutable local smoke payload");
  assert.ok(sent.attempts >= 2);
  assert.ok(received.length >= 2);
  assert.ok(received.every((item) => item.url === "/push" && item.body.device_key === deviceKey));
  const { tasks } = await api("/api/tasks?status=archived");
  assert.equal(tasks[0].id, task.id);
  await until(() => docker("inspect", name, "--format", "{{.State.Health.Status}}") === "healthy");
  console.log("Failure retention, archive, restart persistence, automatic retry and healthcheck: passed.");
} catch (error) {
  if (created) {
    console.error(docker("inspect", name, "--format", "status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}"));
    console.error(docker("logs", "--tail", "30", name).replace(/Barker access password: \S+/g, "Barker access password: [redacted]"));
  }
  throw error;
} finally {
  if (created) {
    docker("stop", "--time", "30", name);
    docker("rm", name);
    docker("volume", "rm", volume);
  }
  if (mock.listening) await new Promise((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
}
