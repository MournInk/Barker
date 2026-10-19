import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { deliverySummary, listDeliveryErrors, listTasks, readSettings } from "@/lib/db";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const { deviceKey, ...settings } = readSettings();
  return NextResponse.json({
    tasks: listTasks(),
    settings,
    deviceKeyConfigured: Boolean(deviceKey),
    deliveries: deliverySummary(),
    retryQueue: listDeliveryErrors(),
  });
}
