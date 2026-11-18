import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { activeScheduleTasks, getTask, readSettings } from "@/lib/db";
import { calendarDays, upcomingWeekDetails } from "@/lib/cron";
import { apiRoute, jsonError } from "@/lib/http";

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
  const taskId = query.get("task") ?? "";
  if (time && (!Number.isFinite(Date.parse(time)) || taskId.length > 100)) return jsonError("分页游标无效", 400);
  const forecast = upcomingWeekDetails(activeScheduleTasks(), now, { timeZone, perDay: 51, after: time ? { time, taskId } : undefined });
  const candidates = forecast.upcoming.filter((item) => !date || days.find((day) => Date.parse(item.occurrenceAt) >= day.start && Date.parse(item.occurrenceAt) < day.end)?.date === date);
  const items = candidates.slice(0, 50).map((item) => ({ ...item, name: getTask(item.taskId)?.name ?? "提醒" }));
  return NextResponse.json({ items, total: forecast.upcomingDays.filter((day) => !date || day.date === date).reduce((sum, day) => sum + day.total, 0), next: candidates.length > 50 ? items.at(-1) : null });
});
