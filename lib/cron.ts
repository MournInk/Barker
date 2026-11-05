import { Cron, CronPattern } from "croner";
import { SCHEDULE_TIME_ZONE } from "./types";
import type { RecurrencePreset, Task, TaskInput } from "./types";

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
  if (preset === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (preset === "weekly") return `${minute} ${hour} * * ${weekday}`;
  if (preset === "monthly") return `${minute} ${hour} ${day} * *`;
  throw new Error("Custom schedules require an explicit cron expression");
}

export function localDateString(date: Date): string {
  const { year, month, day } = scheduleParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Preview future occurrences in the same wall clock and boundary rules as the worker. */
export function previewSchedule(input: TaskInput, now = new Date(), after?: string | null): Date[] {
  const earliest = Math.max(
    Math.floor(new Date(input.startsAt).getTime() / 60_000) * 60_000,
    Math.ceil(now.getTime() / 60_000) * 60_000,
    after ? new Date(after).getTime() + 1 : 0,
  );
  let cursor = new Date(earliest - 1);
  const dates: Date[] = [];
  for (let index = 0; index < Math.min(input.repeatCount ?? 5, 5); index += 1) {
    cursor = nextCronDate(input.cron, cursor);
    if (input.endDate && localDateString(cursor) > input.endDate) break;
    dates.push(cursor);
  }
  return dates;
}

/** Forecast the first four reminders per day for seven Shanghai calendar days.
 * Croner finds matching calendar days; its parsed hour/minute masks let us
 * count slots without thousands of expensive timezone conversions per task.
 */
export function upcomingWeek(tasks: Task[], now = new Date()): Array<{ taskId: string; occurrenceAt: string }> {
  const dayLength = 86_400_000;
  const offset = 8 * 60 * 60_000;
  const nowTime = now.getTime();
  const start = new Date(`${localDateString(now)}T00:00:00+08:00`).getTime();
  const end = start + 7 * dayLength;
  const days: Array<Array<{ taskId: string; occurrenceAt: string }>> = Array.from({ length: 7 }, () => []);
  for (const task of tasks) {
    if (task.status !== "active" || !task.nextRunAt) continue;
    const schedule = cronSchedule(task.cron);
    const pattern = new CronPattern(task.cron, SCHEDULE_TIME_ZONE, { mode: "5-part" });
    const slots: number[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      if (!pattern.hour[hour]) continue;
      for (let minute = 0; minute < 60; minute += 1) {
        if (pattern.minute[minute]) slots.push((hour * 60 + minute) * 60_000);
      }
    }
    let cursor: Date | null = new Date(task.nextRunAt);
    let remaining = task.repeatCount === null ? Infinity : Math.max(0, task.repeatCount - task.queuedCount);
    if (remaining === Infinity && cursor.getTime() < nowTime) cursor = schedule.nextRun(new Date(nowTime - 1));
    const cutoff = task.endDate ? new Date(`${task.endDate}T00:00:00+08:00`).getTime() + dayLength : end;
    const shown = Array<number>(7).fill(0);
    while (cursor && remaining > 0 && cursor.getTime() < Math.min(end, cutoff)) {
      const first = cursor.getTime();
      const midnight = Math.floor((first + offset) / dayLength) * dayLength - offset;
      const day = Math.floor((midnight - start) / dayLength);
      for (const slot of slots) {
        const time = midnight + slot;
        if (time < first) continue;
        if (remaining <= 0) break;
        remaining -= 1;
        if (time >= nowTime && day >= 0 && shown[day] < 4) {
          days[day].push({ taskId: task.id, occurrenceAt: new Date(time).toISOString() });
          shown[day] += 1;
        }
      }
      cursor = schedule.nextRun(new Date(midnight + dayLength - 1));
    }
  }
  return days.flatMap((day) => day.sort((a, b) => a.occurrenceAt.localeCompare(b.occurrenceAt) || a.taskId.localeCompare(b.taskId)).slice(0, 4));
}
