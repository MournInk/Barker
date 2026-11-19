import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { activeScheduleTasks, readSettings } from "@/lib/db";
import { calendarDays, FORECAST_BUDGET_MS, upcomingWeekDetails } from "@/lib/cron";
import { apiRoute, jsonError } from "@/lib/http";
import { logError } from "@/lib/logging";
import { timestampSchema } from "@/lib/contracts";

export const runtime = "nodejs";
export const GET = apiRoute(async (request: Request) => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const query = new URL(request.url).searchParams;
  const now = new Date();
  const timeZone = readSettings().displayTimeZone;
  const days = calendarDays(now, timeZone);
  const date = query.get("date");
  if (date && !days.some((day) => day.date === date)) return jsonError("请选择未来七天内的日期", 400);
  const time = query.get("after");
  const taskId = query.get("task");
  if ((time !== null || taskId !== null) && (!timestampSchema.safeParse(time).success || !taskId?.trim() || taskId.length > 100)) return jsonError("分页游标无效", 400);
  const tasks = activeScheduleTasks();
  const names = new Map(tasks.map((task) => [task.id, task.name]));
  const forecast = upcomingWeekDetails(tasks, now, {
    timeZone, perDay: 51, after: time && taskId ? { time, taskId } : undefined,
    deadline: performance.now() + FORECAST_BUDGET_MS,
    onTaskError: (error, id) => logError("forecast.task.failed", error, { taskId: id }),
  });
  if (forecast.forecastTruncated) return jsonError("排期待处理量较大，请稍后重试", 503);
  const day = days.find((item) => item.date === date);
  const candidates = day ? forecast.upcoming.filter(({ occurrenceAt }) => {
    const timestamp = Date.parse(occurrenceAt);
    return timestamp >= day.start && timestamp < day.end;
  }) : forecast.upcoming;
  const items = candidates.slice(0, 50).map((item) => ({ ...item, name: names.get(item.taskId) ?? "提醒" }));
  return NextResponse.json({ items, total: forecast.upcomingDays.filter((day) => !date || day.date === date).reduce((sum, day) => sum + day.total, 0), next: candidates.length > 50 ? items.at(-1) : null });
});
