import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { cancelDeliveryResult } from "@/lib/db";
import { apiRoute, jsonError, jsonObjectBody, requestBody, requireSameOriginMutation } from "@/lib/http";

export const runtime = "nodejs";

export const POST = apiRoute(async (request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  jsonObjectBody(await requestBody(request));
  const { id } = await context.params;
  const result = cancelDeliveryResult(id);
  if (result === "cancelled") return NextResponse.json({ cancelled: true });
  return result === "missing" ? jsonError("投递记录不存在", 404) : jsonError("记录已不在等待队列，无法取消", 409);
});
