import { SCHEDULE_TIME_ZONE, type RecurrencePreset } from "./types";

export { SCHEDULE_TIME_ZONE };

export const PRESET_LABELS: Record<RecurrencePreset, string> = {
  daily: "每天", weekdays: "工作日", weekly: "每周", monthly: "每月", custom: "自定义 Cron",
};

const wallFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: SCHEDULE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** HTML/Calendar wall-clock value, always in the scheduler's timezone. */
export function localInputValue(date = new Date()): string {
  return wallFormatter.format(date).replace(" ", "T");
}

export function localDateValue(date = new Date()): string {
  return localInputValue(date).slice(0, 10);
}

/** Shanghai has no DST in the supported scheduling range. */
export function toOffsetDateTime(value: string): string {
  return `${value}:00+08:00`;
}

/** Generate preset cron without shipping the scheduler library to the browser. */
export function clientPresetCron(preset: RecurrencePreset, startsAt: string): string {
  const [date, time] = startsAt.split("T");
  if (!date || !time) return "";
  const [hour, minute] = time.split(":").map(Number);
  const day = Number(date.slice(8, 10));
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (preset === "daily") return `${minute} ${hour} * * *`;
  if (preset === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (preset === "weekly") return `${minute} ${hour} * * ${weekday}`;
  if (preset === "monthly") return `${minute} ${hour} ${day} * *`;
  return "";
}

export function formatTime(value: string | null, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return "暂无安排";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SCHEDULE_TIME_ZONE, month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", ...options,
  }).format(new Date(value));
}

export function clockTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: SCHEDULE_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试";
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Same-origin session API; a 401 returns the entire workspace to the access gate. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init, cache: "no-store", credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/session" && typeof window !== "undefined") {
      window.dispatchEvent(new Event("barker:unauthorized"));
    }
    throw new ApiError(data.error || `请求失败 (${response.status})`, response.status);
  }
  return data;
}
