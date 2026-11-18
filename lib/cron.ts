import { Cron, CronPattern } from "croner";
import { SCHEDULE_TIME_ZONE } from "./types";
import type { RecurrencePreset, Task, TaskInput } from "./types";

export { SCHEDULE_TIME_ZONE };

const formatters = new Map<string, Intl.DateTimeFormat>();

function scheduleParts(date: Date, timeZone = SCHEDULE_TIME_ZONE): Record<string, number> {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short",
      hour: "numeric", minute: "numeric", hourCycle: "h23",
    });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, formatter);
  }
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

function cronSchedule(expression: string, timeZone = SCHEDULE_TIME_ZONE): Cron {
  if (expression.trim().split(/\s+/).length !== 5) {
    throw new Error("Cron must contain five fields");
  }
  return new Cron(expression, { timezone: timeZone, mode: "5-part" });
}

export function validateCron(expression: string, timeZone = SCHEDULE_TIME_ZONE): boolean {
  try {
    return cronSchedule(expression, timeZone).nextRun(new Date()) !== null;
  } catch {
    return false;
  }
}

export function nextCronDate(expression: string, from: Date, timeZone = SCHEDULE_TIME_ZONE): Date {
  const next = cronSchedule(expression, timeZone).nextRun(from);
  if (!next) throw new Error("Cron 表达式没有可执行的时间");
  return next;
}

export function presetCron(preset: RecurrencePreset, startsAt: Date, timeZone = SCHEDULE_TIME_ZONE): string {
  const { minute, hour, day, weekday } = scheduleParts(startsAt, timeZone);
  if (preset === "daily" || preset === "once") return `${minute} ${hour} * * *`;
  if (preset === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (preset === "weekly") return `${minute} ${hour} * * ${weekday}`;
  if (preset === "monthly") return `${minute} ${hour} ${day} * *`;
  throw new Error("Custom schedules require an explicit cron expression");
}

export function localDateString(date: Date, timeZone = SCHEDULE_TIME_ZONE): string {
  const { year, month, day } = scheduleParts(date, timeZone);
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
  if (input.preset === "once") {
    const at = new Date(Math.floor(new Date(input.startsAt).getTime() / 60_000) * 60_000);
    return at.getTime() >= earliest && !input.skipDates?.includes(localDateString(at, input.timeZone)) ? [at] : [];
  }
  const dates: Date[] = [];
  for (let index = 0; index < Math.min(input.repeatCount ?? 5, 5); index += 1) {
    cursor = nextTaskDate(input, cursor);
    if (input.endDate && localDateString(cursor, input.timeZone) > input.endDate) break;
    dates.push(cursor);
  }
  return dates;
}

export function nextTaskDate(input: Pick<TaskInput, "cron" | "timeZone" | "skipDates" | "includeDates">, after: Date): Date {
  const schedule = cronSchedule(input.cron, input.timeZone);
  const skipped = new Set(input.skipDates ?? []);
  let next = schedule.nextRun(after);
  while (next && skipped.has(localDateString(next, input.timeZone))) {
    const midnight = new Cron("0 0 * * *", { timezone: input.timeZone ?? SCHEDULE_TIME_ZONE, mode: "5-part" }).nextRun(next)!;
    next = schedule.nextRun(new Date(midnight.getTime() - 1));
  }
  for (const date of input.includeDates ?? []) {
    if (skipped.has(date)) continue;
    const [minute, hour] = input.cron.split(" ");
    const extra = new Cron(`${minute} ${hour} * * *`, { timezone: input.timeZone ?? SCHEDULE_TIME_ZONE, mode: "5-part" });
    const candidate = extra.nextRun(new Date(new Date(`${date}T00:00:00Z`).getTime() - 36 * 3_600_000));
    let cursor = candidate;
    for (let count = 0; cursor && count < 4; count += 1) {
      if (localDateString(cursor, input.timeZone) === date && cursor > after && (!next || cursor < next)) next = cursor;
      cursor = extra.nextRun(cursor);
    }
  }
  if (!next) throw new Error("Cron 表达式没有可执行的时间");
  return next;
}

/** Count seven Shanghai calendar days, retaining four reminders per day.
 * Enumerate clock slots on ordinary days and defer DST transition days to
 * Croner, preserving its gap/overlap rules without a week of minute searches.
 */
export function calendarDays(now: Date, timeZone = SCHEDULE_TIME_ZONE): Array<{ date: string; start: number; end: number }> {
  if (timeZone === SCHEDULE_TIME_ZONE || timeZone === "UTC") {
    const start = Date.parse(`${localDateString(now, timeZone)}T00:00:00${timeZone === "UTC" ? "Z" : "+08:00"}`);
    return Array.from({ length: 7 }, (_, index) => ({ date: localDateString(new Date(start + index * 86_400_000), timeZone), start: start + index * 86_400_000, end: start + (index + 1) * 86_400_000 }));
  }
  const schedule = new Cron("0 0 * * *", { timezone: timeZone, mode: "5-part" });
  let start = schedule.nextRun(new Date(now.getTime() - 48 * 3_600_000))!;
  let next = schedule.nextRun(start)!;
  while (next <= now) { start = next; next = schedule.nextRun(start)!; }
  return Array.from({ length: 7 }, () => {
    const day = { date: localDateString(start, timeZone), start: start.getTime(), end: next.getTime() };
    start = next; next = schedule.nextRun(start)!;
    return day;
  });
}

function lowerBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

export function upcomingWeekDetails(tasks: Iterable<Task>, now = new Date(), options: { timeZone?: string; perDay?: number; after?: { time: string; taskId: string } } = {}): {
  upcoming: Array<{ taskId: string; occurrenceAt: string }>;
  upcomingDays: Array<{ date: string; total: number; hidden: number }>;
} {
  const dayLength = 86_400_000;
  const nowTime = now.getTime();
  const calendar = calendarDays(now, options.timeZone);
  const end = calendar[6].end;
  const maximum = options.perDay ?? 4;
  const days: Array<Array<{ taskId: string; occurrenceAt: string }>> = Array.from({ length: 7 }, () => []);
  const totals = Array<number>(7).fill(0);
  const add = (taskId: string, time: number) => {
    const day = calendar.findIndex((day) => time >= day.start && time < day.end);
    if (time < nowTime || day < 0) return;
    if (options.after && (time < Date.parse(options.after.time) || (time === Date.parse(options.after.time) && taskId <= options.after.taskId))) return;
    const items = days[day];
    if (items.length >= maximum && items.at(-1)!.occurrenceAt < new Date(time).toISOString()) return;
    items.push({ taskId, occurrenceAt: new Date(time).toISOString() });
    items.sort((left, right) => left.occurrenceAt.localeCompare(right.occurrenceAt) || left.taskId.localeCompare(right.taskId));
    if (items.length > maximum) items.pop();
  };
  for (const task of tasks) {
    if (task.status !== "active" || !task.nextRunAt || task.pausedAt) continue;
    try {
    const zone = task.timeZone ?? SCHEDULE_TIME_ZONE;
    const schedule = cronSchedule(task.cron, zone);
    const pattern = new CronPattern(task.cron, zone, { mode: "5-part" });
    const slots: number[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      if (!pattern.hour[hour]) continue;
      for (let minute = 0; minute < 60; minute += 1) {
        if (pattern.minute[minute]) slots.push((hour * 60 + minute) * 60_000);
      }
    }
    let cursor: Date | null = new Date(task.nextRunAt);
    let remaining = task.repeatCount === null ? Infinity : Math.max(0, task.repeatCount - task.queuedCount);
    if (remaining === Infinity && cursor.getTime() < nowTime) cursor = nextTaskDate(task, new Date(nowTime - 1));
    while (cursor && remaining > 0 && cursor.getTime() < end) {
      const first = cursor.getTime();
      const parts = scheduleParts(cursor, zone);
      const date = localDateString(cursor, zone);
      if (task.endDate && date > task.endDate) break;
      if (task.skipDates?.includes(date)) { cursor = nextTaskDate(task, cursor); continue; }
      if (task.preset === "once") {
        const day = calendar.findIndex((day) => first >= Math.max(nowTime, day.start) && first < day.end);
        if (day >= 0) { totals[day] += 1; add(task.id, first); }
        break;
      }
      const midnight = first - (parts.hour * 60 + parts.minute) * 60_000;
      if (zone !== SCHEDULE_TIME_ZONE) {
        const beginning = scheduleParts(new Date(midnight), zone);
        const ending = scheduleParts(new Date(midnight + dayLength - 1), zone);
        if (beginning.day !== parts.day || beginning.hour !== 0 || beginning.minute !== 0
          || ending.day !== parts.day || ending.hour !== 23 || ending.minute !== 59) {
          while (cursor && cursor.getTime() < end && remaining > 0 && localDateString(cursor, zone) === date) {
            const time = cursor.getTime();
            const day = calendar.findIndex((day) => time >= Math.max(nowTime, day.start) && time < day.end);
            if (day >= 0) { totals[day] += 1; add(task.id, time); }
            remaining -= 1; cursor = schedule.nextRun(cursor);
          }
          continue;
        }
      }
      const firstSlot = lowerBound(slots, first - midnight);
      const lastSlot = Math.min(slots.length, firstSlot + remaining, lowerBound(slots, end - midnight));
      for (let day = 0; day < 7; day += 1) {
        const begin = Math.max(firstSlot, lowerBound(slots, Math.max(nowTime, calendar[day].start) - midnight));
        const finish = Math.min(lastSlot, lowerBound(slots, calendar[day].end - midnight));
        totals[day] += Math.max(0, finish - begin);
        const afterSlot = options.after ? lowerBound(slots, Date.parse(options.after.time) - midnight + (task.id <= options.after.taskId ? 1 : 0)) : begin;
        for (let index = Math.max(begin, afterSlot); index < Math.min(finish, Math.max(begin, afterSlot) + maximum); index += 1) add(task.id, midnight + slots[index]);
      }
      remaining -= Math.max(0, lastSlot - firstSlot);
      cursor = task.includeDates?.length || task.skipDates?.length ? nextTaskDate(task, new Date(midnight + dayLength - 1)) : schedule.nextRun(new Date(midnight + dayLength - 1));
    }
    } catch { continue; }
  }
  return {
    upcoming: days.flat(),
    upcomingDays: totals.map((total, index) => ({ date: calendar[index].date, total, hidden: Math.max(0, total - days[index].length) })),
  };
}

export function upcomingWeek(tasks: Task[], now = new Date()): Array<{ taskId: string; occurrenceAt: string }> {
  return upcomingWeekDetails(tasks, now).upcoming;
}
