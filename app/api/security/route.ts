import { NextResponse } from "next/server";
import { z } from "zod";
import { changePassword, clientKeyFor, createApiToken, createSessionToken, getCookieValue, isValidSessionToken, requestUsesHttps, setSessionCookie } from "@/lib/auth";
import { revokeCredential, securityState } from "@/lib/db";
import { apiRoute, jsonError, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";

export const runtime = "nodejs";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("password"), current: z.string().max(300), next: z.string().min(16).max(300) }),
  z.object({ action: z.literal("token"), name: z.string().trim().min(1).max(80), scope: z.enum(["read", "write"]), days: z.number().int().min(1).max(365) }),
  z.object({ action: z.literal("revoke"), id: z.string().max(100), kind: z.enum(["session", "token"]) }),
]);

export const GET = apiRoute(async (request: Request) => {
  if (!isValidSessionToken(getCookieValue(request.headers.get("cookie")))) return jsonError("请使用浏览器会话管理访问权限", 401);
  const { sessions, tokens } = securityState();
  return NextResponse.json({ sessions, tokens });
});

export const POST = apiRoute(async (request: Request) => {
  if (!isValidSessionToken(getCookieValue(request.headers.get("cookie")))) return jsonError("请使用浏览器会话管理访问权限", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const result = schema.safeParse(await requestBody(request));
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  const data = result.data;
  if (data.action === "password") {
    changePassword(data.current, data.next, clientKeyFor(request));
    const response = NextResponse.json({ saved: true });
    response.headers.set("set-cookie", setSessionCookie(createSessionToken(), requestUsesHttps(request)));
    return response;
  }
  if (data.action === "token") return NextResponse.json({ token: createApiToken(data.name, data.scope, data.days) });
  revokeCredential(data.id, data.kind);
  return NextResponse.json({ revoked: true });
});
