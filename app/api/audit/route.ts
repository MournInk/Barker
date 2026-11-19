import { NextResponse } from "next/server";
import { getCookieValue, isValidSessionToken } from "@/lib/auth";
import { listAuditEvents } from "@/lib/db";
import { apiRoute, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const GET = apiRoute(async (request: Request) => {
  if (!isValidSessionToken(getCookieValue(request.headers.get("cookie")))) return jsonError("请使用浏览器会话查看安全审计", 401);
  return NextResponse.json({ events: listAuditEvents() });
});
