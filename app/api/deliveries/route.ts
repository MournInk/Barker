import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { cancelDelivery, compactDatabase, listDeliveries, pruneHistory, retryDelivery } from "@/lib/db";
import { apiRoute, jsonError, jsonObjectBody, requestBody, requireSameOriginMutation } from "@/lib/http";
import type { DeliveryFilter } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request: Request): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const query = new URL(request.url).searchParams;
  const page = Number(query.get("page") ?? 1);
  const pageSize = Number(query.get("pageSize") ?? 12);
  const status = query.get("status") || undefined;
  const q = query.get("q") ?? "";
  if (q.length > 200) return jsonError("搜索内容过长", 400);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return jsonError("无效的分页参数", 400);
  }
  if (status && !["pending", "sending", "sent", "retrying", "cancelled", "expired"].includes(status)) return jsonError("无效的状态筛选", 400);
  return NextResponse.json({ ...listDeliveries({ page, pageSize, status: status as DeliveryFilter, q }), pageSize });
});

export const DELETE = apiRoute(async (request: Request): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const body = jsonObjectBody(await requestBody(request));
  const before = typeof body.before === "string" ? new Date(body.before) : new Date(NaN);
  if (!Number.isFinite(before.getTime()) || before.getTime() > Date.now() - 7 * 86_400_000) return jsonError("只能清理至少七天前的已结束记录", 400);
  let removed = 0;
  let batch: number;
  do {
    batch = pruneHistory(before.toISOString());
    removed += batch;
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (body.all === true && batch === 1000);
  if (body.compact === true) compactDatabase();
  return NextResponse.json({ removed });
});

export const PATCH = apiRoute(async (request: Request) => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const body = jsonObjectBody(await requestBody(request));
  const { action, ids } = body;
  if ((action !== "cancel" && action !== "retry") || !Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((id) => typeof id === "string" && id.trim())) return jsonError("无效的批量操作", 400);
  return NextResponse.json({ results: ids.map((id: string) => ({ id, success: action === "cancel" ? cancelDelivery(id) : retryDelivery(id) })) });
});
