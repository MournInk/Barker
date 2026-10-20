import { SCHEDULE_TIME_ZONE } from "./types";

export type Overview = {
  tasks: import("./types").Task[];
  settings: Omit<import("./types").BarkSettings, "deviceKey">;
  deviceKeyConfigured: boolean;
  deliveries: { pending: number; retrying: number; nextRetryAt: string | null };
  retryQueue: Array<{ taskId: string; taskName: string; occurrenceAt: string; attempts: number; lastError: string | null; nextAttemptAt: string }>;
};

export { SCHEDULE_TIME_ZONE };

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** Wall-clock parts of `date` in the scheduler timezone, independent of the host TZ. */
function wallClock(date: Date): WallClock {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** `datetime-local` value ("YYYY-MM-DDTHH:mm") for the scheduler timezone. */
export function localInputValue(date = new Date()): string {
  const { year, month, day, hour, minute } = wallClock(date);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/** `date` input value ("YYYY-MM-DD") for the scheduler timezone. */
export function localDateValue(date = new Date()): string {
  const { year, month, day } = wallClock(date);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Minutes the scheduler timezone is ahead of UTC at the given instant. */
function zoneOffsetMinutes(instant: Date): number {
  const { year, month, day, hour, minute, second } = wallClock(instant);
  return Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - instant.getTime()) / 60_000);
}

function offsetSuffix(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Turn a scheduler-timezone wall clock ("YYYY-MM-DDTHH:mm") into an ISO string carrying that zone's offset. */
export function toOffsetDateTime(value: string): string {
  const [datePart, timePart = "00:00"] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Resolve the offset at the wall-clock instant itself (Asia/Shanghai has no DST,
  // the second pass only matters for zones that do observe it).
  const firstGuess = zoneOffsetMinutes(new Date(wallClockUtc));
  const offset = zoneOffsetMinutes(new Date(wallClockUtc - firstGuess * 60_000));
  return `${value}:00${offsetSuffix(offset)}`;
}

export function formatTime(value: string | null): string {
  if (!value) return "—";
  const withYear = new Intl.DateTimeFormat("zh-CN", { timeZone: SCHEDULE_TIME_ZONE, year: "numeric" });
  const targetYear = withYear.format(new Date(value));
  const currentYear = withYear.format(new Date());
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SCHEDULE_TIME_ZONE,
    ...(targetYear !== currentYear ? { year: "numeric" as const } : {}),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
