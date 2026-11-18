import type { BarkSettings } from "./types";
import { redactSecrets } from "./errors";

/**
 * Bark reports failures in two flavours:
 * - permanent: the request itself was rejected (bad device key, revoked app,
 *   404 …) — retrying the same payload cannot succeed;
 * - transient: network/timeout/5xx/429 — worth retrying with backoff.
 * Both kinds remain in the outbox. Permanent failures wait for manual repair.
 */
export type BarkFailureKind = "permanent" | "transient";

const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

export class BarkDeliveryError extends Error {
  readonly kind: BarkFailureKind;
  readonly status?: number;
  readonly retryAt?: Date;
  readonly scope: "endpoint" | "payload";

  constructor(message: string, options: { kind?: BarkFailureKind; status?: number; retryAt?: Date; scope?: "endpoint" | "payload" } = {}) {
    super(message);
    this.name = "BarkDeliveryError";
    this.kind = options.kind ?? "transient";
    this.status = options.status;
    this.retryAt = options.retryAt;
    this.scope = options.scope ?? "endpoint";
  }
}

export function retryAfter(value: string | null, now = Date.now()): Date | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value.trim()) ? Number(value) * 1000 + now : Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > now ? new Date(Math.min(milliseconds, now + 7 * 86_400_000)) : undefined;
}

export function barkPayload(settings: BarkSettings, title: string, body: string): string {
  const payload = JSON.stringify({ device_key: settings.deviceKey, title: title || settings.title, body,
    sound: settings.sound || undefined, group: settings.group || undefined, icon: settings.icon || undefined });
  if (Buffer.byteLength(payload, "utf8") > 4096) {
    throw new BarkDeliveryError("通知 JSON 超过 4096 字节，请缩短正文或通知选项后重试", { kind: "permanent", scope: "payload" });
  }
  return payload;
}

/** Build `<endpoint>/push` and never inherit a query string or fragment. */
export function barkPushUrl(endpoint: string): URL {
  return new URL("push", `${endpoint.replace(/\/+$/, "")}/`);
}

async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 16_384) {
      await reader.cancel();
      throw new BarkDeliveryError("Bark API 响应过大，无法确认送达");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function sendBark(
  settings: BarkSettings,
  title: string,
  body: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!settings.deviceKey.trim()) {
    throw new BarkDeliveryError("尚未配置 Bark Device Key，推送已保留，配置设备后恢复", { kind: "permanent" });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const url = barkPushUrl(settings.endpoint);
    const response = await fetcher(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: barkPayload(settings, title, body),
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new BarkDeliveryError(`Bark API 返回 HTTP ${response.status}`, {
        kind: response.status === 413 || PERMANENT_HTTP_STATUSES.has(response.status) ? "permanent" : "transient",
        status: response.status,
        scope: [400, 413, 422].includes(response.status) ? "payload" : "endpoint",
        retryAt: [429, 503].includes(response.status) ? retryAfter(response.headers.get("retry-after")) : undefined,
      });
    }
    const text = await responseText(response);
    let result: unknown = null;
    if (text) {
      try {
        result = JSON.parse(text) as unknown;
      } catch {
        // An HTML/truncated 2xx is almost always a captive portal or proxy error
        // page: the reminder was NOT delivered, so treat it as a failure instead
        // of silently marking it sent.
        throw new BarkDeliveryError("Bark API 返回了非 JSON 响应，无法确认推送是否成功", { kind: "transient" });
      }
    }
    // Some compatible servers return the code as a string.
    const object = result && typeof result === "object" && !Array.isArray(result) ? result as { code?: unknown; message?: unknown } : null;
    const code = object?.code;
    if (!(typeof code === "number" && Number.isSafeInteger(code)) && !(typeof code === "string" && /^(0|[1-9]\d*)$/.test(code))) {
      throw new BarkDeliveryError("Bark API 返回了无法识别的响应", { kind: "transient" });
    }
    if (code !== 200 && code !== "200") {
      const status = Number(code);
      throw new BarkDeliveryError(`Bark API 拒绝推送${typeof object?.message === "string" ? `：${redactSecrets(object.message, [settings.deviceKey]).slice(0, 120)}` : ""}`, {
        kind: status === 429 || status >= 500 ? "transient" : "permanent",
        status,
        scope: [400, 413, 422].includes(status) ? "payload" : "endpoint",
        retryAt: [429, 503].includes(status) ? retryAfter(response.headers.get("retry-after")) : undefined,
      });
    }
  } catch (error) {
    if (error instanceof BarkDeliveryError) {
      error.message = redactSecrets(error.message, [settings.deviceKey]);
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new BarkDeliveryError("Bark API 请求超时，将自动重试", { kind: "transient" });
    }
    throw new BarkDeliveryError(`Bark API 网络错误：${error instanceof Error ? redactSecrets(error.message, [settings.deviceKey]).slice(0, 160) : "未知错误"}`, {
      kind: "transient",
    });
  } finally {
    clearTimeout(timeout);
  }
}
