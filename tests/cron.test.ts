import assert from "node:assert/strict";
import { test } from "node:test";
import { localDateString, nextCronDate, presetCron, upcomingWeek, validateCron } from "../lib/cron";
import type { Task } from "../lib/types";
import { Cron } from "croner";

test("daily, weekly and monthly presets use Shanghai wall time", () => {
  const start = new Date("2026-10-19T01:30:00.000Z");
  assert.equal(presetCron("daily", start), "30 9 * * *");
  assert.equal(presetCron("weekly", start), "30 9 * * 1");
  assert.equal(presetCron("monthly", start), "30 9 19 * *");
  assert.equal(presetCron("weekly", new Date("2026-10-18T16:30:00.000Z")), "30 0 * * 1");
  assert.equal(localDateString(start), "2026-10-19");
});

test("cron finds the next Shanghai occurrence independent of process time zone", () => {
  assert.equal(nextCronDate("30 9 * * *", new Date("2026-10-19T01:29:59Z")).toISOString(), "2026-10-19T01:30:00.000Z");
  assert.equal(nextCronDate("30 9 * * *", new Date("2026-10-19T01:30:00Z")).toISOString(), "2026-10-20T01:30:00.000Z");
});

test("invalid or impossible cron schedules are rejected", () => {
  assert.equal(validateCron("0 9 * * *"), true);
  assert.equal(validateCron("0 9 31 2 *"), false);
  assert.equal(validateCron("*/5 * * * * *"), false);
});

test("weekly agenda includes later daily occurrences, cutoff days, and remaining count", () => {
  const task = {
    id: "daily", cron: "0 9 * * *", status: "active", nextRunAt: "2030-11-03T01:00:00Z",
    queuedCount: 2, repeatCount: 5, endDate: null,
  } as Task;
  const week = upcomingWeek([task], new Date("2030-11-03T00:00:00Z"));
  assert.deepEqual(week.map((item) => item.occurrenceAt), ["2030-11-03T01:00:00.000Z", "2030-11-04T01:00:00.000Z", "2030-11-05T01:00:00.000Z"]);
  const cutoff = upcomingWeek([{ ...task, repeatCount: null, endDate: "2030-11-04" }], new Date("2030-11-03T00:00:00Z"));
  assert.equal(cutoff.length, 2);
  assert.deepEqual(upcomingWeek([{ ...task, status: "paused" }]), []);
});

test("minute-level agenda forecasts by day instead of enumerating a week of cron calls", (context) => {
  const next = context.mock.method(Cron.prototype, "nextRun");
  const task = {
    id: "minute", cron: "* * * * *", status: "active", nextRunAt: "2030-11-02T16:00:00Z",
    queuedCount: 0, repeatCount: 100_000, endDate: null,
  } as Task;
  const now = new Date(task.nextRunAt!);
  assert.equal(upcomingWeek([task], now).length, 28);
  assert.ok(next.mock.callCount() <= 10, `unbounded forecast: ${next.mock.callCount()} cron calls`);
  const limited = upcomingWeek([{ ...task, repeatCount: 1500 }], now);
  assert.deepEqual(limited.map((item) => item.occurrenceAt.slice(0, 10)), [
    "2030-11-02", "2030-11-02", "2030-11-02", "2030-11-02",
    "2030-11-03", "2030-11-03", "2030-11-03", "2030-11-03",
  ]);
});

test("day-based agenda matches Croner for calendar modifiers, sparse times, and overdue budgets", () => {
  const now = new Date("2030-10-28T18:30:00Z");
  const horizon = new Date("2030-11-04T16:00:00Z");
  for (const expression of ["15,45 8-10 * * 1-5", "0 9 L * *", "0 9 1,15 * 1", "5 0,23 * * *"]) {
    const schedule = new Cron(expression, { timezone: "Asia/Shanghai" });
    const first = schedule.nextRun(new Date(now.getTime() - 2 * 86_400_000))!;
    const task = { id: "calendar", status: "active", cron: expression, nextRunAt: first.toISOString(), repeatCount: 25, queuedCount: 2, endDate: "2030-11-03" } as Task;
    const expected: Array<{ taskId: string; occurrenceAt: string }> = [];
    const perDay = new Map<string, number>();
    let cursor: Date | null = first;
    for (let index = 0; cursor && cursor < horizon && index < 23; index += 1) {
      const day = localDateString(cursor);
      if (day > task.endDate!) break;
      if (cursor >= now && (perDay.get(day) ?? 0) < 4) {
        expected.push({ taskId: task.id, occurrenceAt: cursor.toISOString() });
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      cursor = schedule.nextRun(cursor);
    }
    assert.deepEqual(upcomingWeek([task], now), expected, expression);
  }
});
