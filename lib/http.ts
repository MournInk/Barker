import { NextResponse } from "next/server";
import { DomainError } from "./errors";
import { randomUUID } from "node:crypto";
import { logError } from "./logging";

/** Requests are tiny JSON documents; anything bigger is abuse or a mistake. */
export const MAX_REQUEST_BYTES = 64 * 1024;

export class HttpError extends DomainError {}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Turn a domain error into its intended status and everything else into a sanitized 500. */
export function jsonErrorFrom(error: unknown, fallbackStatus = 500, fallbackMessage = "服务暂时无法完成请求，请稍后重试"): NextResponse {
  if (error instanceof DomainError) return jsonError(error.message, error.status);
  return jsonError(fallbackMessage, fallbackStatus);
}

/** Keep every API failure in the JSON contract, including auth/DB bootstrapping errors. */
export function apiRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args) => {
    const requestId = randomUUID();
    try {
      const response = await handler(...args);
      response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      if (!(error instanceof DomainError)) {
        const request = args[0] instanceof Request ? args[0] : null;
        logError("api.failed", error, { requestId, method: request?.method ?? "unknown", path: request ? new URL(request.url).pathname : "unknown" });
      }
      const response = jsonErrorFrom(error);
      response.headers.set("x-request-id", requestId);
      return response;
    }
  };
}

export function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new HttpError("缺少有效版本号，请刷新后重试", 428);
  return Number(value);
}

export async function requestBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new HttpError("请求体过大", 413);
  }
  let text: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError("请求必须包含有效 JSON", 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new HttpError("请求体过大", 413);
      }
      chunks.push(value);
    }
    text = new TextDecoder().decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof HttpError) throw error;
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
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return jsonError("请求体过大", 413);
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const expectsJsonBody = method === "POST" || method === "PUT" || method === "PATCH";
  if (expectsJsonBody && contentType !== "application/json") {
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
