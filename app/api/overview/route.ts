import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { dashboardStats, deliverySummary, listDeliveries, listTasks, readSettings } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { upcomingWeek } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const { deviceKey, endpoint } = readSettings();
  const tasks = listTasks().filter((task) => task.status !== "archived");
  const now = new Date();
  return NextResponse.json({
    tasks,
    upcoming: upcomingWeek(tasks, now),
    endpoint,
    deviceKeyConfigured: Boolean(deviceKey),
    deliveries: deliverySummary(),
    ...dashboardStats(now),
    recent: listDeliveries({ page: 1, pageSize: 5 }).deliveries,
    serverTime: now.toISOString(),
  });
}
