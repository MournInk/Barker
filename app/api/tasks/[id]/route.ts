import { NextResponse } from "next/server";
import { requestIsAuthorized } from "@/lib/auth";
import { deleteTask, getTask, permanentlyDeleteTask, setTaskStatus, updateTask } from "@/lib/db";
import { apiRoute, expectedRevision, jsonError, jsonObjectBody, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
import { taskInputSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const PUT = apiRoute(async (request: Request, context: RouteContext): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const body = await requestBody(request);
  const result = taskInputSchema.safeParse(body);
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  const { id } = await context.params;
  const task = updateTask(id, result.data, new Date(), expectedRevision(jsonObjectBody(body).revision));
  return task ? NextResponse.json({ task }) : jsonError("任务不存在", 404);
});

export const PATCH = apiRoute(async (request: Request, context: RouteContext): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const data = jsonObjectBody(await requestBody(request));
  if (data.status !== "active" && data.status !== "paused") return jsonError("仅支持暂停或恢复任务", 400);
  const { id } = await context.params;
  const task = setTaskStatus(id, data.status, new Date(), expectedRevision(data.revision));
  return task ? NextResponse.json({ task }) : jsonError("任务不存在", 404);
});

export const DELETE = apiRoute(async (request: Request, context: RouteContext): Promise<NextResponse> => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const { id } = await context.params;
  if (!getTask(id)) return jsonError("任务不存在", 404);
  const revision = expectedRevision(Number(request.headers.get("if-match")));
  if (new URL(request.url).searchParams.get("permanent") === "1") {
    permanentlyDeleteTask(id, revision);
    return NextResponse.json({ deleted: true });
  }
  deleteTask(id, new Date(), revision);
  return NextResponse.json({ archived: true });
});
