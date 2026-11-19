import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { retryDeliveryResult } from "@/lib/db";
import { apiRoute, jsonError, jsonObjectBody, requestBody, requireSameOriginMutation } from "@/lib/http";

export const runtime = "nodejs";

export const POST = apiRoute(async (request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  jsonObjectBody(await requestBody(request));
  const { id } = await context.params;
  const result = retryDeliveryResult(id);
  if (result === "queued") return NextResponse.json({ queued: true });
  return result === "missing" ? jsonError("投递记录不存在", 404) : jsonError("记录已送达、正在发送或已过期，无法重试", 409);
});
