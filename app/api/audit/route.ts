import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { listAuditEvents } from "@/lib/db";
import { apiRoute, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const GET = apiRoute(async (request: Request) => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  return NextResponse.json({ events: listAuditEvents() });
});
