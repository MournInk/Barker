import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { deliveryAttempts } from "@/lib/db";
import { apiRoute, jsonError, jsonErrorFrom } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  try {
    const { id } = await context.params;
    return NextResponse.json({ attempts: deliveryAttempts(id) });
  } catch (error) { return jsonErrorFrom(error); }
});
