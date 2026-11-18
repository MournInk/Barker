import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { activeScheduleTasks, dashboardStats, deliverySummary, getTask, listDeliveries, readSettings } from "@/lib/db";
import { apiRoute, jsonError } from "@/lib/http";
import { upcomingWeekDetails } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request: Request): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const { deviceKey, endpoint, displayTimeZone } = readSettings();
  const now = new Date();
  const forecast = upcomingWeekDetails(activeScheduleTasks(), now, { timeZone: displayTimeZone });
  const ids = new Set(forecast.upcoming.map((item) => item.taskId));
  const next = activeScheduleTasks().next().value;
  if (next) ids.add(next.id);
  const tasks = [...ids].map(getTask).filter(Boolean);
  return NextResponse.json({
    tasks,
    ...forecast,
    displayTimeZone,
    endpoint,
    deviceKeyConfigured: Boolean(deviceKey),
    deliveries: deliverySummary(),
    ...dashboardStats(now, displayTimeZone),
    recent: listDeliveries({ page: 1, pageSize: 5 }).deliveries,
    serverTime: now.toISOString(),
  });
});
