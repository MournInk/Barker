import { NextResponse } from "next/server";
import { clearSessionCookie, createSessionToken, getCookieValue, getAuthCookieName, isValidSessionToken, requestIsAuthorized, requestUsesHttps, setSessionCookie, verifyPassword } from "@/lib/auth";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  return NextResponse.json({ authenticated: requestIsAuthorized(request) });
}

export async function POST(request: Request): Promise<NextResponse> {
  let data: { password?: unknown };
  try {
    data = await request.json() as { password?: unknown };
  } catch {
    return jsonError("请求内容无效", 400);
  }
  if (typeof data.password !== "string" || data.password.length > 300) {
    return jsonError("请输入访问密码", 400);
  }
  const forwardedFor = request.headers.get("x-forwarded-for");
  const clientKey = request.headers.get("x-real-ip") || forwardedFor?.split(",").at(-1)?.trim() || "local";
  if (!verifyPassword(data.password, Date.now(), clientKey)) {
    return jsonError("密码错误或尝试次数过多，请稍后再试", 401);
  }
  const response = NextResponse.json({ authenticated: true });
  response.headers.set("set-cookie", setSessionCookie(createSessionToken(), requestUsesHttps(request)));
  return response;
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const response = NextResponse.json({ authenticated: false });
  if (isValidSessionToken(getCookieValue(request.headers.get("cookie"), getAuthCookieName()))) {
    response.headers.set("set-cookie", clearSessionCookie(requestUsesHttps(request)));
  }
  return response;
}
