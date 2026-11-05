import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { listDeliveries } from "@/lib/db";
import { jsonError } from "@/lib/http";
import type { DeliveryFilter } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const query = new URL(request.url).searchParams;
  const page = Number(query.get("page") ?? 1);
  const pageSize = Number(query.get("pageSize") ?? 12);
  const status = query.get("status") || undefined;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return jsonError("无效的分页参数", 400);
  }
  if (status && !["pending", "sending", "sent", "retrying"].includes(status)) return jsonError("无效的状态筛选", 400);
  return NextResponse.json({ ...listDeliveries({ page, pageSize, status: status as DeliveryFilter, q: query.get("q") ?? "" }), page, pageSize });
}
