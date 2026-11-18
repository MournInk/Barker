import { NextResponse } from "next/server";
import { z } from "zod";
import { requestIsAuthorized } from "@/lib/auth";
import { editDelivery } from "@/lib/db";
import { apiRoute, jsonError, requestBody, requireSameOriginMutation, validationMessage } from "@/lib/http";
import { taskInputSchema } from "@/lib/validation";

export const runtime = "nodejs";
const schema = z.object({ title: taskInputSchema.shape.name, body: taskInputSchema.shape.description, updatedAt: z.string().datetime() })
  .refine((value) => new TextEncoder().encode(JSON.stringify({ title: value.title, body: value.body })).byteLength <= 3000, "标题和正文不能超过 3000 字节");

export const PATCH = apiRoute(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  if (!requestIsAuthorized(request)) return jsonError("未授权", 401);
  const blocked = requireSameOriginMutation(request);
  if (blocked) return blocked;
  const result = schema.safeParse(await requestBody(request));
  if (!result.success) return jsonError(validationMessage(result.error), 400);
  editDelivery((await context.params).id, result.data.title, result.data.body, result.data.updatedAt);
  return NextResponse.json({ saved: true });
});
