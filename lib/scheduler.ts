import { createHash } from "node:crypto";
import { claimDelivery, deliverySettings, dueTaskRows, extendEndpointCooldown, isolateInvalidTask, listDevices, markDeliveryFailed, markDeliverySent, queueTaskBatch, readRuntimeState, writeRuntimeState } from "./db";
import { BarkDeliveryError, sendBark } from "./bark";
import { redactSecrets } from "./errors";
import type { BarkSettings } from "./types";
import { logError } from "./logging";

let cycle: Promise<void> | null = null;
let enqueueCycle: Promise<number> | null = null;
let stopping = false;
let timer: ReturnType<typeof setInterval> | undefined;
let lastEnqueueSucceeded = true;
const MAX_ENQUEUE_PER_CYCLE = 500;
const MAX_DELIVERIES_PER_CYCLE = 20;
const DELIVERY_CONCURRENCY = 4;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const globalWorker = globalThis as typeof globalThis & { barkerSchedulerStarted?: boolean };

export async function enqueueDueOccurrences(now = new Date()): Promise<number> {
  if (enqueueCycle) return enqueueCycle;
  enqueueCycle = (async () => {
    const deadline = performance.now() + 100;
    let scheduled = 0;
    let rows = dueTaskRows(now);
    while (rows.length && scheduled < MAX_ENQUEUE_PER_CYCLE && performance.now() < deadline && !stopping) {
      let progress = 0;
      for (const task of rows) {
        try {
          const count = queueTaskBatch(task.id, now, Math.min(25, MAX_ENQUEUE_PER_CYCLE - scheduled), performance.now() + 10);
          scheduled += count; progress += count;
        } catch (error) {
          if (error instanceof Error && /cron|pattern|timezone|time zone|schedule|invalid time value/i.test(error.message)) {
            isolateInvalidTask(task.id, now);
            console.error(`[Barker] isolated invalid schedule ${task.id}`);
          } else throw error;
        }
        await yieldToEventLoop();
        if (scheduled >= MAX_ENQUEUE_PER_CYCLE || performance.now() >= deadline || stopping) break;
      }
      if (!progress) break;
      rows = dueTaskRows(now);
    }
    return scheduled;
  })();
  try { return await enqueueCycle; }
  finally { enqueueCycle = null; }
}

function endpointStateKey(settings: BarkSettings): string {
  return `endpoint:${createHash("sha256").update(`${settings.endpoint}\n${settings.deviceKey}`).digest("hex")}`;
}

export async function processOneDelivery(
  now = new Date(),
  deliver: (settings: BarkSettings, title: string, body: string) => Promise<void> = sendBark,
): Promise<boolean> {
  if (stopping) return false;
  const claimAt = new Date(Math.max(now.getTime(), Date.now()));
  const excludedDevices = listDevices().filter((device) => Number(readRuntimeState(endpointStateKey(deliverySettings(device.id))) ?? 0) > claimAt.getTime()).map((device) => device.id);
  // Lease recovery and expiration still run while the endpoint is cooling
  // down; otherwise a long Retry-After would keep already-undeliverable
  // messages looking pending for days.
  const item = claimDelivery(claimAt, true, excludedDevices);
  if (!item) return false;
  const settings = deliverySettings(item.deviceId, item.notification);
  const endpointKey = endpointStateKey(settings);
  const attempt = item.attempts + 1;
  const completedAt = (): Date => new Date(Math.max(claimAt.getTime(), Date.now()));
  try {
    await deliver(settings, item.name, item.description || "计划提醒时间已到。");
    markDeliverySent(item.id, item.leaseUntil, completedAt());
  } catch (error) {
    const nowCompleted = completedAt();
    const message = redactSecrets(error instanceof Error ? error.message : "未知推送错误", [settings.deviceKey]);
    const retryAt = error instanceof BarkDeliveryError ? error.retryAt : undefined;
    markDeliveryFailed(item.id, item.leaseUntil, attempt, message, nowCompleted, retryAt, error instanceof BarkDeliveryError && error.kind === "permanent");
    if (error instanceof BarkDeliveryError && error.scope === "endpoint") {
      const delay = error.kind === "permanent" ? 60_000 : 5000;
      extendEndpointCooldown(endpointKey, Math.max(retryAt?.getTime() ?? 0, nowCompleted.getTime() + delay));
    }
    logError("delivery.failed", new Error(message), { deliveryId: item.id, attempt });
  }
  return true;
}

export async function runSchedulerCycle(now = new Date(), deliver = sendBark): Promise<void> {
  if (stopping) return;
  try {
    await enqueueDueOccurrences(now);
    lastEnqueueSucceeded = true;
    writeRuntimeState("scheduler_heartbeat", String(Date.now()));
    writeRuntimeState("scheduler_enqueue_error", "");
  }
  catch (error) {
    lastEnqueueSucceeded = false;
    logError("scheduler.enqueue.failed", error);
    try { writeRuntimeState("scheduler_enqueue_error", "enqueue_failed"); } catch {}
  }
  if (cycle) return cycle;
  cycle = (async () => {
    let failure = !lastEnqueueSucceeded;
    let claimed = 0;
    const worker = async () => {
      while (!stopping && claimed < MAX_DELIVERIES_PER_CYCLE) {
        claimed += 1;
        if (!await processOneDelivery(now, deliver)) break;
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: DELIVERY_CONCURRENCY }, worker));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") { failure = true; logError("scheduler.delivery.failed", outcome.reason); }
    }
    try {
      writeRuntimeState("scheduler_error", failure || !lastEnqueueSucceeded ? "cycle_failed" : "");
      if (!failure && lastEnqueueSucceeded && !stopping) writeRuntimeState("scheduler_heartbeat", String(Date.now()));
    } catch (error) { logError("scheduler.heartbeat.failed", error); }
  })();
  try { await cycle; }
  finally { cycle = null; }
}

export function schedulerHealth(now = Date.now()): boolean {
  if (process.env.BARKER_DISABLE_SCHEDULER === "1") return false;
  if (!lastEnqueueSucceeded) return false;
  if (readRuntimeState("scheduler_error") || readRuntimeState("scheduler_enqueue_error")) return false;
  const heartbeat = Number(readRuntimeState("scheduler_heartbeat") ?? 0);
  return Number.isFinite(heartbeat) && heartbeat > 0 && heartbeat <= now && now - heartbeat < 15_000;
}

export async function stopScheduler(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  globalWorker.barkerSchedulerStarted = false;
  await Promise.allSettled([cycle, enqueueCycle]);
  try { writeRuntimeState("scheduler_heartbeat", "0"); }
  catch { console.error("[Barker] could not clear shutdown heartbeat"); }
}

export function startScheduler(): void {
  if (process.env.BARKER_DISABLE_SCHEDULER === "1" || globalWorker.barkerSchedulerStarted) return;
  stopping = false;
  globalWorker.barkerSchedulerStarted = true;
  const tick = () => {
    void runSchedulerCycle().catch((error) => logError("scheduler.cycle.failed", error));
  };
  timer = setInterval(tick, 2000);
  timer.unref?.();
  process.once("SIGTERM", () => { void stopScheduler(); });
  process.once("SIGINT", () => { void stopScheduler(); });
  if (process.send) process.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "barker:shutdown") {
      void stopScheduler().finally(() => { if (process.connected) process.send?.({ type: "barker:stopped" }); });
    }
  });
  tick();
}
