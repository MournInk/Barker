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

test("impossible dates are rejected as validation issues, not exceptions", () => {
  const base = { name: "喝水", preset: "daily" as const, cron: "30 9 * * *", repeatCount: 10 };
  for (const bad of [
    "2026-13-01T09:30:00+08:00",
    "2026-02-31T09:30:00+08:00",
    "2026-10-19T09:61:00+08:00",
    "2026-10-19T09:30:00+08",
  ]) {
    const result = taskInputSchema.safeParse({ ...base, startsAt: bad });
    assert.equal(result.success, false, bad);
  }
  assert.equal(taskInputSchema.safeParse({ ...base, startsAt: "2026-10-19T09:30:00+08:00" }).success, true, "a sane offset is still accepted");
});

test("control characters and absurd repeat counts are rejected", () => {
  const base = { name: "喝水", startsAt, preset: "daily" as const, cron: presetCron("daily", new Date(startsAt)), repeatCount: 10 };
  assert.equal(taskInputSchema.safeParse({ ...base, name: "a\nb" }).success, false);
  assert.equal(taskInputSchema.safeParse({ ...base, description: "x\u0000y" }).success, false);
  assert.equal(taskInputSchema.safeParse({ ...base, repeatCount: 1e9 }).success, false);
});

test("malformed or dangerous Bark endpoints are rejected without throwing", () => {
  const base = { title: "t", sound: "", group: "", icon: "" };
  for (const bad of [
    "https://",
    "http://",
    "//api.day.app",
    "https://?",
    "https://#f",
    "https://api.day.app:99999",
    "https://[::1",
    "https://exa mple.com",
    "https://api.day.app/?k=1",
    "https://api.day.app/#f",
  ]) {
    assert.equal(settingsSchema.safeParse({ ...base, endpoint: bad }).success, false, bad);
  }
  assert.equal(settingsSchema.safeParse({ ...base, endpoint: "https://api.day.app", icon: "ftp://x/y.png" }).success, false);
  assert.equal(settingsSchema.safeParse({ ...base, endpoint: "https://api.day.app", icon: "https://example.com/i.png" }).success, true);
  assert.equal(settingsSchema.safeParse({ ...base, endpoint: "https://api.day.app", icon: `https://x/${"a".repeat(400)}` }).success, false);
});
