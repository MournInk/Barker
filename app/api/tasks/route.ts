import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { createTask, listTasks, listTasksPaginated } from "@/lib/db";
import { jsonError, requestBody, validationMessage } from "@/lib/http";
import type { TaskStatus } from "@/lib/types";
import { taskInputSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const url = new URL(request.url);
  const hasPagination = url.searchParams.has("page") || url.searchParams.has("pageSize") || url.searchParams.has("status") || url.searchParams.has("q");
  if (!hasPagination) return NextResponse.json({ tasks: listTasks() });
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "12");
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q") ?? undefined;
  if (status && !new Set(["active", "paused", "completed"]).has(status)) return jsonError("无效的状态筛选", 400);
  const { tasks, total } = listTasksPaginated({
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 12,
    status: (status as TaskStatus) ?? undefined,
    q,
  });
  return NextResponse.json({
    tasks,
    total,
    page: Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)),
    pageSize: Math.min(50, Math.max(1, Math.floor(Number.isFinite(pageSize) ? pageSize : 12))),
  });
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
