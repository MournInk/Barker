import { NextResponse } from "next/server";

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("请求必须包含有效 JSON");
  }
}

export function validationMessage(error: { issues?: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues?.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；") || "请求内容无效";
}
