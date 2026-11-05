import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { retryDelivery } from "@/lib/db";
import { jsonError, requireSameOriginMutation } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const { id } = await context.params;
  return retryDelivery(id) ? NextResponse.json({ queued: true }) : jsonError("记录不存在、已送达或正在发送", 409);
}
