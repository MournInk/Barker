import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { sendBark } from "@/lib/bark";
import { readSettings } from "@/lib/db";
import { apiRoute, jsonError, jsonErrorFrom, jsonObjectBody, requestBody, requireSameOriginMutation } from "@/lib/http";
import { redactSecrets } from "@/lib/errors";

export const runtime = "nodejs";

export const POST = apiRoute(async (request: Request): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  try { jsonObjectBody(await requestBody(request)); }
  catch (error) { return jsonErrorFrom(error); }
  const settings = readSettings();
  if (!settings.deviceKey.trim()) return jsonError("尚未配置 Bark Device Key，请先保存设置", 400);
  try {
    await sendBark(settings, "Barker 测试推送", "Bark 连接已配置成功。");
    return NextResponse.json({ delivered: true });
  } catch (error) {
    return jsonError(error instanceof Error ? redactSecrets(error.message, [settings.deviceKey]) : "测试推送失败", 502);
  }
});
