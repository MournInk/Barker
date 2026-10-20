import { NextResponse } from "next/server";
import { clearSessionCookie, clientKeyFor, createSessionToken, getCookieValue, getAuthCookieName, isValidSessionToken, requestIsAuthorized, requestUsesHttps, setSessionCookie, verifyPassword } from "@/lib/auth";
import { jsonError, jsonErrorFrom, jsonObjectBody, requestBody, requireSameOriginMutation } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  return NextResponse.json({ authenticated: requestIsAuthorized(request) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  let body: Record<string, unknown>;
  try {
    body = jsonObjectBody(await requestBody(request));
  } catch (error) {
    return jsonErrorFrom(error);
  }
  const password = body.password;
  if (typeof password !== "string") return jsonError("请输入访问密码", 400);
  if (password.length > 300) return jsonError("访问密码过长", 400);
  const clientKey = clientKeyFor(request);
  if (!verifyPassword(password, Date.now(), clientKey)) {
    return jsonError("密码错误或尝试次数过多，请稍后再试", 401);
  }
  const response = NextResponse.json({ authenticated: true });
  response.headers.set("set-cookie", setSessionCookie(createSessionToken(), requestUsesHttps(request)));
  return response;
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const response = NextResponse.json({ authenticated: false });
  if (isValidSessionToken(getCookieValue(request.headers.get("cookie"), getAuthCookieName()))) {
    response.headers.set("set-cookie", clearSessionCookie(requestUsesHttps(request)));
  }
  return response;
}
