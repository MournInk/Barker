import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkLegacyData, loadRuntimeEnvironment, runtimeDirectory } from "./runtime-paths.mjs";

const [entry, ...argumentsList] = process.argv.slice(2);
if (!entry) throw new Error("Usage: node scripts/start-server.mjs SERVER_ENTRY [ARGUMENTS]");
loadRuntimeEnvironment();
process.env.BARKER_DATA_DIR = runtimeDirectory();
if (resolve(entry) === resolve(".next/standalone/server.js")) {
  checkLegacyData();
  cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
  if (existsSync("public")) cpSync("public", ".next/standalone/public", { recursive: true });
}
const child = spawn(process.execPath, [entry, ...argumentsList], { detached: process.platform !== "win32", stdio: ["inherit", "inherit", "inherit", "ipc"] });
let stoppingSignal;
let deadline;
let forwarded = false;

function forwardSignal() {
  if (forwarded || !stoppingSignal) return;
  forwarded = true;
  clearTimeout(deadline);
  child.kill(stoppingSignal);
}

function shutdown(signal) {
  if (stoppingSignal) {
    if (forwarded) child.kill("SIGKILL");
    return;
  }
  stoppingSignal = signal;
  deadline = setTimeout(forwardSignal, 20_000);
  deadline.unref();
  if (!child.connected || process.env.BARKER_DISABLE_SCHEDULER === "1") return forwardSignal();
  child.send({ type: "barker:shutdown" }, (error) => { if (error) forwardSignal(); });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(signal));
child.on("message", (message) => { if (message?.type === "barker:stopped") forwardSignal(); });
child.once("error", (error) => { console.error(`Barker server failed to start: ${error.message}`); process.exitCode = 1; });
child.once("exit", (code, signal) => {
  clearTimeout(deadline);
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 1);
});
