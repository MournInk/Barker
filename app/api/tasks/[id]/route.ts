import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { deleteTask, getTask, setTaskStatus, updateTask } from "@/lib/db";
import { jsonError, jsonErrorFrom, jsonObjectBody, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
import type { TaskStatus } from "@/lib/types";
import { taskInputSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
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
  const { id } = await context.params;
  try {
    const task = updateTask(id, result.data);
    return task ? NextResponse.json({ task }) : jsonError("任务不存在", 404);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法更新任务", 400);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  let data: Record<string, unknown>;
  try {
    data = jsonObjectBody(await requestBody(request));
  } catch (error) {
    return jsonErrorFrom(error);
  }
  if (!(["active", "paused"] as unknown[]).includes(data.status)) return jsonError("仅支持暂停或恢复任务", 400);
  const { id } = await context.params;
  try {
    const task = setTaskStatus(id, data.status as TaskStatus);
    return task ? NextResponse.json({ task }) : jsonError("任务不存在", 404);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法更新任务", 400);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const { id } = await context.params;
  if (!getTask(id)) return jsonError("任务不存在", 404);
  // `?force=1` is the explicit escape hatch for a task whose deliveries can
  // never succeed (wrong device key, deleted Bark app, …): discard them.
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    deleteTask(id, new Date(), { force });
    return NextResponse.json({ deleted: true, forced: force });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法删除任务", 409);
  }
}
