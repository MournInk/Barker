import { z } from "zod";
import { presetCron, validateCron } from "./cron";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const isoDateTime = z.string().datetime({ offset: true }).max(64);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export const taskInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "任务名称不能为空")
      .max(80, "任务名称最多 80 个字符")
      .refine((value) => !CONTROL_CHARS.test(value), "任务名称不能包含控制字符"),
    description: z
      .string()
      .max(500, "解释最多 500 个字符")
      .refine((value) => !CONTROL_CHARS.test(value), "解释不能包含控制字符")
      .optional()
      .default(""),
    startsAt: isoDateTime,
    preset: z.enum(["daily", "weekly", "monthly", "custom"]),
    cron: z.string().trim().min(9, "请输入有效的 cron 表达式").max(80),
    repeatCount: z.number().int().positive("重复次数必须为正整数").max(100_000, "重复次数过大").nullable().optional(),
    endDate: z.string().date().nullable().optional(),
  })
  .superRefine((value, context) => {
    // A regex-valid but impossible date (month 13, Feb 31, +08:00:30 …) parses to
    // an Invalid Date; Intl/cron would throw a RangeError and escape zod as a 500.
    const start = new Date(value.startsAt);
    const startIsValid = !Number.isNaN(start.getTime());
    if (!startIsValid) {
      context.addIssue({ code: "custom", path: ["startsAt"], message: "开始时间无效" });
    }
    if (!validateCron(value.cron)) {
      context.addIssue({ code: "custom", path: ["cron"], message: "Cron 表达式无效，请使用标准五段格式" });
    } else if (startIsValid && value.preset !== "custom" && value.cron !== presetCron(value.preset, start)) {
      context.addIssue({ code: "custom", path: ["cron"], message: "预设周期与开始时间不匹配" });
    }
    if (value.repeatCount && value.endDate) {
      context.addIssue({ code: "custom", path: ["repeatCount"], message: "重复次数与截止日期只能填写一项" });
    }
    if (!value.repeatCount && !value.endDate) {
      context.addIssue({ code: "custom", path: ["repeatCount"], message: "请填写重复次数或截止日期" });
    }
  });

export const settingsSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .min(1, "请输入完整的 Bark API 地址")
    .max(300)
    .refine((value) => {
      try {
        const url = new URL(value);
        // Query strings and fragments would be swallowed by `${endpoint}/push`
        // and silently misroute every push, so reject them here.
        return (
          ["http:", "https:"].includes(url.protocol) &&
          Boolean(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "Bark API 地址必须是不含用户名、密码、查询串与锚点的 HTTP(S) 地址"),
  deviceKey: z.string().trim().max(300).optional().default(""),
  title: z.string().trim().min(1).max(100),
  sound: z.string().trim().max(80),
  group: z.string().trim().max(100),
  icon: z
    .string()
    .trim()
    .max(300, "图标 URL 过长")
    .refine((value) => value === "" || isHttpUrl(value), "图标必须是 HTTP(S) URL"),
});

export type ValidatedTaskInput = z.infer<typeof taskInputSchema>;
export type ValidatedSettings = z.infer<typeof settingsSchema>;
