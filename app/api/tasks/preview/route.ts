import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { previewSchedule } from "@/lib/cron";
import { previewTaskUpdate } from "@/lib/db";
import { jsonError, jsonErrorFrom, jsonObjectBody, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
import { taskInputSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  try {
    const body = jsonObjectBody(await requestBody(request));
    const result = taskInputSchema.safeParse(body);
    if (!result.success) return jsonError(validationMessage(result.error), 400);
    if (body.taskId !== undefined && (typeof body.taskId !== "string" || !body.taskId)) return jsonError("任务编号无效", 400);
    const runs = typeof body.taskId === "string" ? previewTaskUpdate(body.taskId, result.data) : previewSchedule(result.data);
    if (!runs) return jsonError("任务不存在", 404);
    if (!runs.length && !body.taskId) return jsonError("截止日期早于下一次执行时间", 400);
    const dates = runs.map((date) => date.toISOString());
    return NextResponse.json({ dates });
  } catch (error) {
    return jsonErrorFrom(error);
  }
}
