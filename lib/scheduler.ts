import { claimDelivery, dueTaskRows, getTask, markDeliveryFailed, markDeliverySent, readSettings, scheduleOccurrence } from "./db";
import { sendBark } from "./bark";
import type { BarkSettings } from "./types";

let cycle: Promise<void> | null = null;

export async function enqueueDueOccurrences(now = new Date()): Promise<number> {
  let scheduled = 0;
  for (const task of dueTaskRows(now)) {
    let occurrence = task.nextRunAt ? new Date(task.nextRunAt) : null;
    let produced = 0;
    while (occurrence && occurrence <= now && produced < 500) {
      scheduleOccurrence(task, occurrence, now);
      scheduled += 1;
      produced += 1;
      const updated = getTask(task.id);
      occurrence = updated?.status === "active" && updated.nextRunAt ? new Date(updated.nextRunAt) : null;
    }
  }
  return scheduled;
}

export async function processOneDelivery(
  now = new Date(),
  deliver: (settings: BarkSettings, title: string, body: string) => Promise<void> = sendBark,
): Promise<boolean> {
  const item = claimDelivery(now);
  if (!item) return false;
  const attempt = item.attempts + 1;
  try {
    const settings = readSettings();
    await deliver(settings, item.name, item.description || "计划提醒时间已到。");
    markDeliverySent(item.id, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知推送错误";
    markDeliveryFailed(item.id, attempt, message, now);
    console.error(`[Barker] delivery ${item.id} failed; attempt ${attempt} retained for retry: ${message}`);
  }
  return true;
}

export async function runSchedulerCycle(now = new Date()): Promise<void> {
  if (cycle) return cycle;
  cycle = (async () => {
    try {
      await enqueueDueOccurrences(now);
      await processOneDelivery(now);
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
