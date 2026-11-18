import { NextResponse } from "next/server";
import { clearSessionCookie, clientKeyFor, createSessionToken, getCookieValue, loginRetryAfter, MAX_SECRET_LENGTH, revokeSessionToken, requestIsAuthorized, requestUsesHttps, setSessionCookie, verifyPassword } from "@/lib/auth";
import { apiRoute, jsonError, jsonErrorFrom, jsonObjectBody, requestBody, requireSameOriginMutation } from "@/lib/http";

export const runtime = "nodejs";

export const GET = apiRoute(async (request: Request): Promise<NextResponse> => {
  return NextResponse.json({ authenticated: requestIsAuthorized(request) });
});

export const POST = apiRoute(async (request: Request): Promise<NextResponse> => {
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
  if (password.length > MAX_SECRET_LENGTH) return jsonError("访问密码过长", 400);
  const clientKey = clientKeyFor(request);
  const now = Date.now();
  if (!verifyPassword(password, now, clientKey)) {
    const wait = loginRetryAfter(clientKey, now);
    const response = jsonError(wait ? "错误尝试次数过多，请稍后再试" : "访问密码错误", wait ? 429 : 401);
    if (wait) response.headers.set("retry-after", String(wait));
    return response;
  }
  const response = NextResponse.json({ authenticated: true });
  response.headers.set("set-cookie", setSessionCookie(createSessionToken(), requestUsesHttps(request)));
  return response;
});

export const DELETE = apiRoute(async (request: Request): Promise<NextResponse> => {
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const response = NextResponse.json({ authenticated: false });
  revokeSessionToken(getCookieValue(request.headers.get("cookie")));
  response.headers.set("set-cookie", clearSessionCookie(requestUsesHttps(request)));
  return response;
});
