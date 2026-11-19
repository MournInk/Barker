import { z } from "zod";

export const timeZoneSchema = z.string().max(100).refine((value) => {
  try { return !/^[+-]/.test(new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone); } catch { return false; }
}, "时区必须是有效的 IANA 时区");
export const timestampSchema = z.string().datetime({ offset: true }).max(64);
const httpUrl = z.string().trim().max(300, "图标 URL 过长").refine((value) => {
  if (!value) return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, "图标必须是 HTTP(S) URL");

export const taskFields = z.object({
  name: z.string().trim().min(1, "任务名称不能为空").max(80, "任务名称最多 80 个字符").refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "任务名称不能包含控制字符"),
  description: z.string().max(2000, "提醒内容最多 2000 个字符").refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "提醒内容不能包含控制字符").optional().default(""),
  startsAt: timestampSchema,
  preset: z.enum(["once", "daily", "weekdays", "weekly", "monthly", "custom"]),
  cron: z.string().trim().min(9, "请输入有效的 Cron 表达式").max(80, "Cron 表达式最多 80 个字符"),
  repeatCount: z.number().int("重复次数必须为正整数").positive("重复次数必须为正整数").max(100000, "重复次数过大").nullable().optional(),
  endDate: z.string().date().nullable().optional(),
  timeZone: timeZoneSchema.optional().default("Asia/Shanghai"),
  maxLatenessMinutes: z.number().int().min(1).max(525600).nullable().optional().default(null),
  deviceId: z.string().max(100).optional().default("default"),
  notification: z.object({ sound: z.string().trim().max(80).optional(), group: z.string().trim().max(100).optional(), icon: httpUrl.optional() }).optional().default({}),
  skipDates: z.array(z.string().date()).max(366).optional().default([]),
  includeDates: z.array(z.string().date()).max(366).optional().default([]),
});

export const taskSchema = taskFields.extend({
  id: z.string(), description: z.string(), repeatCount: taskFields.shape.repeatCount.unwrap(), endDate: taskFields.shape.endDate.unwrap(),
  sentCount: z.number().int().nonnegative(), queuedCount: z.number().int().nonnegative(), pendingCount: z.number().int().nonnegative(),
  nextRunAt: timestampSchema.nullable(), lastRunAt: timestampSchema.nullable(), lastError: z.string().nullable(),
  status: z.enum(["active", "paused", "completed", "archived"]),
  createdAt: timestampSchema, updatedAt: timestampSchema, revision: z.number().int().positive(),
  maxLatenessMinutes: z.number().int().min(1).max(525600).nullable(), pausedAt: timestampSchema.nullable(),
});

export const deliverySchema = z.object({
  id: z.string(), taskId: z.string(), taskName: z.string(), description: z.string(),
  deviceId: z.string().optional(), manualOnly: z.boolean().optional(),
  occurrenceAt: timestampSchema, status: z.enum(["pending", "sending", "sent", "cancelled", "expired"]),
  attempts: z.number().int().nonnegative(), lastError: z.string().nullable(), nextAttemptAt: timestampSchema,
  deliveredAt: timestampSchema.nullable(), createdAt: timestampSchema, updatedAt: timestampSchema, expiresAt: timestampSchema.nullable(),
});

export const settingsFields = z.object({
  displayTimeZone: timeZoneSchema.optional().default("Asia/Shanghai"),
  endpoint: z.string().trim().min(1, "请输入完整的 Bark API 地址").max(300, "Bark API 地址过长").refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, "Bark API 地址必须是不含用户名、密码、查询串与锚点的 HTTP(S) 地址"),
  deviceKey: z.string().trim().max(300).optional().default(""),
  title: z.string().trim().min(1).max(100), sound: z.string().trim().max(80), group: z.string().trim().max(100), icon: httpUrl,
});
