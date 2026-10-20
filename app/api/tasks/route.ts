import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { createTask, listTasks, listTasksPaginated } from "@/lib/db";
import { jsonError, jsonErrorFrom, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
import type { TaskStatus } from "@/lib/types";
import { taskInputSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGE = 1_000_000;

export async function GET(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const url = new URL(request.url);
  const hasPagination = url.searchParams.has("page") || url.searchParams.has("pageSize") || url.searchParams.has("status") || url.searchParams.has("q");
  if (!hasPagination) return NextResponse.json({ tasks: listTasks() });
  // Reject absurd values instead of letting them become an `Infinity` OFFSET.
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const requestedPageSize = Number(url.searchParams.get("pageSize") ?? "12");
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > MAX_PAGE) {
    return jsonError("无效的分页参数", 400);
  }
  if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
    return jsonError("无效的分页参数", 400);
  }
  const page = requestedPage;
  const pageSize = Math.min(50, requestedPageSize);
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q") ?? undefined;
  if (status && !new Set(["active", "paused", "completed"]).has(status)) return jsonError("无效的状态筛选", 400);
  const { tasks, total } = listTasksPaginated({
    page,
    pageSize,
    status: (status as TaskStatus) ?? undefined,
    q,
  });
  return NextResponse.json({ tasks, total, page, pageSize });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await requestBody(request);
  } catch (error) {
    return jsonErrorFrom(error);
  }
  const result = taskInputSchema.safeParse(body);
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  try {
    return NextResponse.json({ task: createTask(result.data) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法创建任务", 400);
  }
}
