import assert from "node:assert/strict";
import { test } from "node:test";
import { localDateString, nextCronDate, presetCron, validateCron } from "../lib/cron";

test("daily, weekly and monthly presets use Shanghai wall time", () => {
  const start = new Date("2026-10-19T01:30:00.000Z");
  assert.equal(presetCron("daily", start), "30 9 * * *");
  assert.equal(presetCron("weekly", start), "30 9 * * 1");
  assert.equal(presetCron("monthly", start), "30 9 19 * *");
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
