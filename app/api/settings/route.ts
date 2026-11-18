import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { dataDirectory, readSettings, readSettingsState, writeSettings } from "@/lib/db";
import { apiRoute, expectedRevision, jsonError, jsonErrorFrom, jsonObjectBody, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
import { settingsSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request: Request): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const state = readSettingsState();
  const { deviceKey, ...settings } = state.settings;
  // Only the absolute data directory is exposed, never any stored secret.
  return NextResponse.json({ settings, revision: state.revision, deviceKeyConfigured: Boolean(deviceKey), dataDir: dataDirectory() });
});

export const PUT = apiRoute(async (request: Request): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  let data: Record<string, unknown>;
  try {
    data = jsonObjectBody(await requestBody(request));
  } catch (error) {
    return jsonErrorFrom(error);
  }
  try {
    const revision = expectedRevision(data.revision);
    if (data.clearDeviceKey !== undefined && typeof data.clearDeviceKey !== "boolean") {
      return jsonError("清除 Device Key 的标记无效", 400);
    }
    const previous = readSettings();
    const clearDeviceKey = data.clearDeviceKey === true;
    const endpointChanged = typeof data.endpoint === "string" && data.endpoint.trim().replace(/\/+$/, "") !== previous.endpoint.replace(/\/+$/, "");
    if (clearDeviceKey && typeof data.deviceKey === "string" && data.deviceKey.trim()) {
      return jsonError("不能同时清除并填写新的 Device Key", 400);
    }
    if (clearDeviceKey && endpointChanged) {
      return jsonError("更换服务地址并清除旧密钥时，请改为填写新服务的 Device Key", 400);
    }
    if (endpointChanged && !(typeof data.deviceKey === "string" && data.deviceKey.trim())) {
      return jsonError("更换服务地址时必须填写该服务的 Device Key", 400);
    }
    // An empty or missing deviceKey keeps the stored one, so the form never needs to echo secrets back.
    const candidate = clearDeviceKey
      ? { ...data, deviceKey: "" }
      : !(typeof data.deviceKey === "string" && data.deviceKey.trim())
        ? { ...data, deviceKey: previous.deviceKey }
        : data;
    const result = settingsSchema.safeParse(candidate);
    if (!result.success) return jsonError(validationMessage(result.error), 400);
    const settings = { ...previous, ...result.data };
    const nextRevision = writeSettings(settings, revision);
    return NextResponse.json({ saved: true, revision: nextRevision });
  } catch (error) { return jsonErrorFrom(error); }
});
