import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { dataDirectory, readSettings, readSettingsState, writeSettings } from "@/lib/db";
import { apiRoute, expectedRevision, jsonError, jsonObjectBody, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
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
  const data = jsonObjectBody(await requestBody(request));
  const revision = expectedRevision(data.revision);
  if (data.clearDeviceKey !== undefined && typeof data.clearDeviceKey !== "boolean") {
    return jsonError("清除 Device Key 的标记无效", 400);
  }
  const previous = readSettings();
  const clearDeviceKey = data.clearDeviceKey === true;
  const endpointChanged = typeof data.endpoint === "string" && data.endpoint.trim().replace(/\/+$/, "") !== previous.endpoint.replace(/\/+$/, "");
  const hasDeviceKey = typeof data.deviceKey === "string" && Boolean(data.deviceKey.trim());
  if (clearDeviceKey && hasDeviceKey) return jsonError("不能同时清除并填写新的 Device Key", 400);
  if (clearDeviceKey && endpointChanged) return jsonError("更换服务地址并清除旧密钥时，请改为填写新服务的 Device Key", 400);
  if (endpointChanged && !hasDeviceKey) return jsonError("更换服务地址时必须填写该服务的 Device Key", 400);
  const candidate = clearDeviceKey ? { ...data, deviceKey: "" } : hasDeviceKey ? data : { ...data, deviceKey: previous.deviceKey };
  const result = settingsSchema.safeParse(candidate);
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  const nextRevision = writeSettings({ ...previous, ...result.data }, revision);
  return NextResponse.json({ saved: true, revision: nextRevision });
});
