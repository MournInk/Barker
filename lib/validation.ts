import { z } from "zod";
import { presetCron, validateCron } from "./cron";

const isoDateTime = z.string().datetime({ offset: true });

export const taskInputSchema = z
  .object({
    name: z.string().trim().min(1, "任务名称不能为空").max(80, "任务名称最多 80 个字符"),
    description: z.string().max(500, "解释最多 500 个字符").optional().default(""),
    startsAt: isoDateTime,
    preset: z.enum(["daily", "weekly", "monthly", "custom"]),
    cron: z.string().trim().min(9, "请输入有效的 cron 表达式").max(80),
    repeatCount: z.number().int().positive().nullable().optional(),
    endDate: z.string().date().nullable().optional(),
  })
  .superRefine((value, context) => {
    if (!validateCron(value.cron)) {
      context.addIssue({ code: "custom", path: ["cron"], message: "Cron 表达式无效，请使用标准五段格式" });
    } else if (value.preset !== "custom" && value.cron !== presetCron(value.preset, new Date(value.startsAt))) {
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
  endpoint: z.string().trim().url("请输入完整的 Bark API 地址").max(300).refine((value) => {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  }, "Bark API 地址必须使用 HTTP(S)，且不能包含用户名或密码"),
  deviceKey: z.string().trim().max(300).optional().default(""),
  title: z.string().trim().min(1).max(100),
  sound: z.string().trim().max(80),
  group: z.string().trim().max(100),
  icon: z.string().trim().url("图标必须是 URL").or(z.literal("")),
});

export type ValidatedTaskInput = z.infer<typeof taskInputSchema>;
export type ValidatedSettings = z.infer<typeof settingsSchema>;
