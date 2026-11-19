import { NextResponse } from "next/server";
import { z } from "zod";
import { requestIsAuthorized } from "@/lib/auth";
import { listDevices, removeDevice, saveDevice } from "@/lib/db";
import { apiRoute, expectedRevision, jsonError, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";

export const runtime = "nodejs";
const schema = z.object({ id: z.string().trim().min(1, "设备 ID 不能为空").max(100).optional(), name: z.string().trim().min(1).max(80), endpoint: z.string().trim().max(300), deviceKey: z.string().trim().max(300).default(""), revision: z.number().int().positive().optional() });

export const GET = apiRoute(async (request: Request) => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  return NextResponse.json({ devices: listDevices() });
});

export const POST = apiRoute(async (request: Request) => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const result = schema.safeParse(await requestBody(request));
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  if (result.data.id) expectedRevision(result.data.revision);
  return NextResponse.json({ device: saveDevice(result.data) });
});

export const DELETE = apiRoute(async (request: Request) => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  removeDevice(id, expectedRevision(Number(request.headers.get("if-match"))));
  return NextResponse.json({ deleted: true });
});
