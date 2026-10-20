import { Cron } from "croner";
import { SCHEDULE_TIME_ZONE } from "./types";
import type { RecurrencePreset } from "./types";

export { SCHEDULE_TIME_ZONE };


function scheduleParts(date: Date): Record<string, number> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric", month: "numeric", day: "numeric", weekday: "short",
    hour: "numeric", minute: "numeric", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdays[parts.weekday],
  };
}

function cronSchedule(expression: string): Cron {
  if (expression.trim().split(/\s+/).length !== 5) {
    throw new Error("Cron must contain five fields");
  }
  return new Cron(expression, { timezone: SCHEDULE_TIME_ZONE });
}

export function validateCron(expression: string): boolean {
  try {
    return cronSchedule(expression).nextRun(new Date()) !== null;
  } catch {
    return false;
  }
}

export function nextCronDate(expression: string, from: Date): Date {
  const next = cronSchedule(expression).nextRun(from);
  if (!next) throw new Error("Cron 表达式没有可执行的时间");
  return next;
}

export function presetCron(preset: RecurrencePreset, startsAt: Date): string {
  const { minute, hour, day, weekday } = scheduleParts(startsAt);
  if (preset === "daily") return `${minute} ${hour} * * *`;
  if (preset === "weekly") return `${minute} ${hour} * * ${weekday}`;
  if (preset === "monthly") return `${minute} ${hour} ${day} * *`;
  throw new Error("Custom schedules require an explicit cron expression");
}

export function localDateString(date: Date): string {
  const { year, month, day } = scheduleParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
