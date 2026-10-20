import { NextResponse } from "next/server";

/** Requests are tiny JSON documents; anything bigger is abuse or a mistake. */
export const MAX_REQUEST_BYTES = 64 * 1024;

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Turn a thrown HttpError into its intended status, everything else into 400/500. */
export function jsonErrorFrom(error: unknown, fallbackStatus = 400, fallbackMessage = "请求内容无效"): NextResponse {
  if (error instanceof HttpError) return jsonError(error.message, error.status);
  if (error instanceof Error) return jsonError(error.message, fallbackStatus);
  return jsonError(fallbackMessage, fallbackStatus);
}

export async function requestBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new HttpError("请求体过大", 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError("无法读取请求体", 400);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new HttpError("请求体过大", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError("请求必须包含有效 JSON", 400);
  }
}

/** Guard against `null`/array bodies before reading properties. */
export function jsonObjectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("请求内容无效", 400);
  }
  return value as Record<string, unknown>;
}

/**
 * Cheap CSRF defence in depth: mutate only via same-origin JSON requests.
 * SameSite=Lax already blocks classic cross-site form posts; this also covers
 * same-site siblings and non-browser clients that forget the JSON header.
 */
export function requireSameOriginMutation(request: Request): NextResponse | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const expectsJsonBody = method === "POST" || method === "PUT" || method === "PATCH";
  if (expectsJsonBody && !contentType.startsWith("application/json")) {
    return jsonError("请求必须使用 application/json", 415);
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return jsonError("跨站请求被拒绝", 403);
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.get("host")) return jsonError("跨站请求被拒绝", 403);
    } catch {
      return jsonError("跨站请求被拒绝", 403);
    }
  }
  return null;
}

export function validationMessage(error: { issues?: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues?.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；") || "请求内容无效";
}
