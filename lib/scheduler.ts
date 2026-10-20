import { claimDelivery, dueTaskRows, getTask, markDeliveryFailed, markDeliverySent, readSettings, scheduleOccurrence, setTaskStatus } from "./db";
import { BarkDeliveryError, sendBark } from "./bark";
import type { BarkSettings } from "./types";

let cycle: Promise<void> | null = null;

/** Bound the synchronous work per cycle so HTTP stays responsive after downtime. */
const MAX_ENQUEUE_PER_CYCLE = 500;
const MAX_DELIVERIES_PER_CYCLE = 20;
/** Permanent failures (wrong key, revoked app, 404 …) auto-pause the task. */
const PERMANENT_FAILURE_PAUSE_AFTER = 5;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function enqueueDueOccurrences(now = new Date()): Promise<number> {
  let scheduled = 0;
  let scanned = 0;
  for (const task of dueTaskRows(now)) {
    let occurrence = task.nextRunAt ? new Date(task.nextRunAt) : null;
    while (occurrence && occurrence <= now && scheduled < MAX_ENQUEUE_PER_CYCLE) {
      scheduleOccurrence(task, occurrence, now);
      scheduled += 1;
      const updated = getTask(task.id);
      occurrence = updated?.status === "active" && updated.nextRunAt ? new Date(updated.nextRunAt) : null;
    }
    scanned += 1;
    // A cold start can otherwise block the event loop for seconds (100 tasks ×
    // 500 occurrences); yield regularly and continue draining next cycle.
    if (scanned % 10 === 0 || scheduled >= MAX_ENQUEUE_PER_CYCLE) await yieldToEventLoop();
    if (scheduled >= MAX_ENQUEUE_PER_CYCLE) break;
  }
  return scheduled;
}

export async function processOneDelivery(
  now = new Date(),
  deliver: (settings: BarkSettings, title: string, body: string) => Promise<void> = sendBark,
): Promise<boolean> {
  // Leases are wall-clock based: a long cycle (up to 20 × 15s timeouts) would
  // otherwise hand out already-expired leases, letting another instance re-claim
  // an in-flight delivery and push it twice.
  const claimAt = new Date(Math.max(now.getTime(), Date.now()));
  const item = claimDelivery(claimAt);
  if (!item) return false;
  const attempt = item.attempts + 1;
  // Timestamps must reflect when the push actually finished, not when it was
  // claimed: a 15s timeout otherwise lands the retry already in the past and the
  // backoff would be skipped entirely.
  const completedAt = (): Date => new Date(Math.max(claimAt.getTime(), Date.now()));
  try {
    const settings = readSettings();
    await deliver(settings, item.name, item.description || "计划提醒时间已到。");
    markDeliverySent(item.id, item.leaseUntil, completedAt());
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知推送错误";
    markDeliveryFailed(item.id, item.leaseUntil, attempt, message, completedAt());
    console.error(`[Barker] delivery ${item.id} failed; attempt ${attempt} retained for retry: ${message}`);
    if (error instanceof BarkDeliveryError && error.kind === "permanent" && attempt >= PERMANENT_FAILURE_PAUSE_AFTER) {
      // Retrying a permanently rejected push forever only hammers the endpoint
      // and grows the queue; pause the task and let the user fix the settings.
      try {
        const task = getTask(item.taskId);
        if (task && task.status === "active") {
          setTaskStatus(item.taskId, "paused", completedAt());
          console.warn(`[Barker] task "${task.name}" paused after ${attempt} permanent delivery failures: ${message}`);
        }
      } catch (pauseError) {
        console.error("[Barker] failed to pause a task after permanent delivery failures:", pauseError);
      }
    }
  }
  return true;
}

export async function runSchedulerCycle(now = new Date()): Promise<void> {
  if (cycle) return cycle;
  cycle = (async () => {
    try {
      await enqueueDueOccurrences(now);
      for (let sent = 0; sent < MAX_DELIVERIES_PER_CYCLE; sent += 1) {
        const processed = await processOneDelivery(now);
        if (!processed) break;
      }
    } catch (error) {
      console.error("[Barker] scheduler cycle failed; database state retained:", error);
    }
  })();
  try {
    await cycle;
  } finally {
    cycle = null;
  }
}

const globalWorker = globalThis as typeof globalThis & { barkerSchedulerStarted?: boolean };

export function startScheduler(): void {
  if (globalWorker.barkerSchedulerStarted) return;
  globalWorker.barkerSchedulerStarted = true;
  const timer = setInterval(() => void runSchedulerCycle(), 2_000);
  timer.unref?.();
  void runSchedulerCycle();
}
