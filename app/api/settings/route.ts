import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { readSettings, writeSettings } from "@/lib/db";
import { jsonError, requestBody, validationMessage } from "@/lib/http";
import { settingsSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const { deviceKey, ...settings } = readSettings();
  return NextResponse.json({ settings, deviceKeyConfigured: Boolean(deviceKey) });
}

export async function PUT(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  let body: unknown;
  try {
    body = await requestBody(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "请求内容无效", 400);
  }
  const data = body as Record<string, unknown> | null;
  const previous = readSettings();
  // An empty or missing deviceKey keeps the stored one, so the form never needs to echo secrets back.
  const candidate = data && typeof data === "object" && !(typeof data.deviceKey === "string" && data.deviceKey.trim())
    ? { ...data, deviceKey: previous.deviceKey }
    : data;
  const result = settingsSchema.safeParse(candidate);
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  const settings = { ...previous, ...result.data };
  writeSettings(settings);
  return NextResponse.json({ saved: true });
}
