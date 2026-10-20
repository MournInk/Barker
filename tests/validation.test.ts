import assert from "node:assert/strict";
import { test } from "node:test";
import { presetCron } from "../lib/cron";
import { settingsSchema, taskInputSchema } from "../lib/validation";

const startsAt = "2026-10-19T01:30:00.000+00:00";

test("task input accepts presets, rejects conflicting limits", () => {
  const base = { name: "喝水", startsAt, preset: "daily" as const, cron: presetCron("daily", new Date(startsAt)) };
  assert.equal(taskInputSchema.safeParse({ ...base, repeatCount: 10 }).success, true);
  assert.equal(taskInputSchema.safeParse({ ...base, endDate: "2026-11-01" }).success, true);
  assert.equal(taskInputSchema.safeParse(base).success, false);
  assert.equal(taskInputSchema.safeParse({ ...base, repeatCount: 10, endDate: "2026-11-01" }).success, false);
  assert.equal(taskInputSchema.safeParse({ ...base, repeatCount: 0 }).success, false);
  assert.equal(taskInputSchema.safeParse({ ...base, cron: "0 9 * * *" }).success, false);
});

test("settings allow an empty device key and strip credentials from the endpoint", () => {
  const minimal = settingsSchema.safeParse({ endpoint: "https://api.day.app", title: "Barker 提醒", sound: "1107", group: "Barker", icon: "" });
  assert.equal(minimal.success, true);
  assert.equal(minimal.data?.deviceKey, "");
  const withCreds = settingsSchema.safeParse({ endpoint: "https://user:pass@api.day.app", deviceKey: "k", title: "t", sound: "", group: "", icon: "" });
  assert.equal(withCreds.success, false);
  const badIcon = settingsSchema.safeParse({ endpoint: "https://api.day.app", deviceKey: "k", title: "t", sound: "", group: "", icon: "not-a-url" });
  assert.equal(badIcon.success, false);
});
