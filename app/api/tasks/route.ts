import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { createTask, deleteTask, listTasks, listTasksPaginated, setTaskStatus, transaction } from "@/lib/db";
import { apiRoute, expectedRevision, jsonError, jsonObjectBody, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
import { DomainError } from "@/lib/errors";
import type { TaskStatus } from "@/lib/types";
import { taskInputSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGE = 1_000_000;

export const GET = apiRoute(async (request: Request): Promise<NextResponse> => {
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
  if (q && q.length > 200) return jsonError("搜索内容过长", 400);
  if (status && !new Set(["active", "paused", "completed", "archived"]).has(status)) return jsonError("无效的状态筛选", 400);
  const listing = listTasksPaginated({
    page,
    pageSize,
    status: (status as TaskStatus) ?? undefined,
    q,
  });
  return NextResponse.json({ ...listing, pageSize });
});

export const POST = apiRoute(async (request: Request): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const result = taskInputSchema.safeParse(await requestBody(request));
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  const key = request.headers.get("idempotency-key");
  if (key !== null && !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return jsonError("幂等键格式无效", 400);
  return NextResponse.json({ task: createTask(result.data, new Date(), key ?? undefined) }, { status: 201 });
});

export const PATCH = apiRoute(async (request: Request) => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const body = jsonObjectBody(await requestBody(request));
  const { status } = body;
  if ((status !== "active" && status !== "paused" && status !== "archived") || !Array.isArray(body.items) || !body.items.length || body.items.length > 50) return jsonError("无效的批量操作", 400);
  const items = body.items.map((value: unknown) => {
    const item = jsonObjectBody(value);
    if (typeof item.id !== "string" || !item.id.trim()) throw new DomainError("任务 ID 无效");
    return { id: item.id, revision: expectedRevision(item.revision) };
  });
  const now = new Date();
  const results = transaction(() => items.map(({ id, revision }) => {
    try {
      const changed = status === "archived" ? deleteTask(id, now, revision) : setTaskStatus(id, status, now, revision);
      return { id, success: Boolean(changed), error: changed ? undefined : "任务不存在" };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return { id, success: false, error: error.message };
    }
  }));
  return NextResponse.json({ results });
});
