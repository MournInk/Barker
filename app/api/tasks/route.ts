import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { createTask, listTasks } from "@/lib/db";
import { jsonError, requestBody, validationMessage } from "@/lib/http";
import { taskInputSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  return NextResponse.json({ tasks: listTasks() });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  let body: unknown;
  try {
    body = await requestBody(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "请求内容无效", 400);
  }
  const result = taskInputSchema.safeParse(body);
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  try {
    return NextResponse.json({ task: createTask(result.data) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法创建任务", 400);
  }
}
