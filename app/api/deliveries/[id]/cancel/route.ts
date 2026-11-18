import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { cancelDelivery } from "@/lib/db";
import { apiRoute, jsonError, jsonErrorFrom, jsonObjectBody, requestBody, requireSameOriginMutation } from "@/lib/http";

export const runtime = "nodejs";

export const POST = apiRoute(async (request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  try {
    jsonObjectBody(await requestBody(request));
    const { id } = await context.params;
    return cancelDelivery(id) ? NextResponse.json({ cancelled: true }) : jsonError("记录不存在或已不在等待队列，无法取消", 409);
  } catch (error) { return jsonErrorFrom(error); }
});
