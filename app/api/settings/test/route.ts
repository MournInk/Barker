import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { sendBark } from "@/lib/bark";
import { readSettings } from "@/lib/db";
import { jsonError, requireSameOriginMutation } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const settings = readSettings();
  if (!settings.deviceKey.trim()) return jsonError("尚未配置 Bark Device Key，请先保存设置", 400);
  try {
    await sendBark(settings, "Barker 测试推送", "Bark 连接已配置成功。");
    return NextResponse.json({ delivered: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "测试推送失败", 502);
  }
}
