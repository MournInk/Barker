import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { sendBark } from "@/lib/bark";
import { readSettings } from "@/lib/db";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  try {
    await sendBark(readSettings(), "Barker 测试推送", "Bark 连接已配置成功。");
    return NextResponse.json({ delivered: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "测试推送失败", 502);
  }
}
