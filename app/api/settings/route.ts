import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { dataDirectory, readSettings, writeSettings } from "@/lib/db";
import { jsonError, jsonErrorFrom, jsonObjectBody, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
import { settingsSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const { deviceKey, ...settings } = readSettings();
  // Only the absolute data directory is exposed, never any stored secret.
  return NextResponse.json({ settings, deviceKeyConfigured: Boolean(deviceKey), dataDir: dataDirectory() });
}

export async function PUT(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  let data: Record<string, unknown>;
  try {
    data = jsonObjectBody(await requestBody(request));
  } catch (error) {
    return jsonErrorFrom(error);
  }
  const previous = readSettings();
  // An empty or missing deviceKey keeps the stored one, so the form never needs to echo secrets back.
  const candidate = !(typeof data.deviceKey === "string" && data.deviceKey.trim())
    ? { ...data, deviceKey: previous.deviceKey }
    : data;
  const result = settingsSchema.safeParse(candidate);
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  const settings = { ...previous, ...result.data };
  writeSettings(settings);
  return NextResponse.json({ saved: true });
}
