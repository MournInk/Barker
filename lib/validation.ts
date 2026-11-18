import { z } from "zod";
import { presetCron, validateCron } from "./cron";
import { settingsFields, taskFields, timeZoneSchema } from "./contracts";

export const taskInputSchema = taskFields.superRefine((value, context) => {
  const start = new Date(value.startsAt);
  const validStart = Number.isFinite(start.getTime());
  if (!validStart) context.addIssue({ code: "custom", path: ["startsAt"], message: "开始时间无效" });
  if (!validateCron(value.cron, value.timeZone)) {
    context.addIssue({ code: "custom", path: ["cron"], message: "Cron 表达式无效，请使用标准五段格式" });
  } else if (validStart && timeZoneSchema.safeParse(value.timeZone).success && value.preset !== "custom" && value.cron !== presetCron(value.preset, start, value.timeZone)) {
    context.addIssue({ code: "custom", path: ["cron"], message: "预设周期与开始时间不匹配" });
  }
  if (value.repeatCount && value.endDate) context.addIssue({ code: "custom", path: ["repeatCount"], message: "重复次数与截止日期只能填写一项" });
  if (value.preset === "once" && (value.repeatCount !== 1 || value.endDate)) context.addIssue({ code: "custom", path: ["repeatCount"], message: "一次性提醒必须只执行一次" });
  if (value.skipDates.some((date) => value.includeDates.includes(date))) context.addIssue({ code: "custom", path: ["includeDates"], message: "同一日期不能同时跳过和补班" });
  if (value.includeDates.length && value.preset !== "weekdays") context.addIssue({ code: "custom", path: ["includeDates"], message: "补班日期仅适用于周一至周五预设" });
  if (new TextEncoder().encode(JSON.stringify({ title: value.name, body: value.description || "计划提醒时间已到。" })).byteLength > 3000) {
    context.addIssue({ code: "custom", path: ["description"], message: "标题和正文合计不能超过 3000 个 UTF-8 字节，请缩短内容" });
  }
});

export const settingsSchema = settingsFields.superRefine((value, context) => {
  const options = JSON.stringify({ device_key: value.deviceKey, sound: value.sound || undefined, group: value.group || undefined, icon: value.icon || undefined });
  if (new TextEncoder().encode(options).byteLength > 1096) context.addIssue({ code: "custom", path: ["deviceKey"], message: "密钥与通知选项合计过长，请缩短分组、提示音或图标地址，为通知正文保留空间" });
});

export type ValidatedTaskInput = z.infer<typeof taskInputSchema>;
export type ValidatedSettings = z.infer<typeof settingsSchema>;
