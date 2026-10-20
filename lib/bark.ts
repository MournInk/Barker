import type { BarkSettings } from "./types";

/**
 * Bark reports failures in two flavours:
 * - permanent: the request itself was rejected (bad device key, revoked app,
 *   404 …) — retrying the same payload cannot succeed;
 * - transient: network/timeout/5xx/429 — worth retrying with backoff.
 * The scheduler uses this to stop hammering an endpoint that will never accept
 * the push (and to pause the task after repeated permanent failures).
 */
export type BarkFailureKind = "permanent" | "transient";

const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

export class BarkDeliveryError extends Error {
  readonly kind: BarkFailureKind;
  readonly status?: number;

  constructor(message: string, options: { kind?: BarkFailureKind; status?: number } = {}) {
    super(message);
    this.name = "BarkDeliveryError";
    this.kind = options.kind ?? "transient";
    this.status = options.status;
  }
}

/** Build `<endpoint>/push` and never inherit a query string or fragment. */
export function barkPushUrl(endpoint: string): URL {
  return new URL("push", `${endpoint.replace(/\/+$/, "")}/`);
}

export async function sendBark(
  settings: BarkSettings,
  title: string,
  body: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!settings.deviceKey.trim()) {
    throw new BarkDeliveryError("尚未配置 Bark Device Key，推送已保留并将继续重试", { kind: "permanent" });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const url = barkPushUrl(settings.endpoint);
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        device_key: settings.deviceKey,
        title: title || settings.title,
        body,
        sound: settings.sound || undefined,
        group: settings.group || undefined,
        icon: settings.icon || undefined,
      }),
      signal: controller.signal,
    });
    const text = (await response.text().catch(() => "")).trim();
    if (!response.ok) {
      throw new BarkDeliveryError(`Bark API 返回 HTTP ${response.status}`, {
        kind: PERMANENT_HTTP_STATUSES.has(response.status) ? "permanent" : "transient",
        status: response.status,
      });
    }
    let result: { code?: number | string; message?: string } | null = null;
    if (text) {
      try {
        result = JSON.parse(text) as { code?: number | string; message?: string };
      } catch {
        // An HTML/truncated 2xx is almost always a captive portal or proxy error
        // page: the reminder was NOT delivered, so treat it as a failure instead
        // of silently marking it sent.
        throw new BarkDeliveryError("Bark API 返回了非 JSON 响应，无法确认推送是否成功", { kind: "transient" });
      }
    }
    // Some compatible servers return the code as a string.
    const code = result?.code === undefined ? undefined : Number(result.code);
    if (code !== undefined && !Number.isFinite(code)) {
      throw new BarkDeliveryError("Bark API 返回了无法识别的响应", { kind: "transient" });
    }
    if (code !== undefined && code !== 200) {
      throw new BarkDeliveryError(`Bark API 拒绝推送${result?.message ? `：${String(result.message).slice(0, 120)}` : ""}`, {
        kind: "permanent",
      });
    }
  } catch (error) {
    if (error instanceof BarkDeliveryError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new BarkDeliveryError("Bark API 请求超时，将自动重试", { kind: "transient" });
    }
    throw new BarkDeliveryError(`Bark API 网络错误：${error instanceof Error ? error.message.slice(0, 160) : "未知错误"}`, {
      kind: "transient",
    });
  } finally {
    clearTimeout(timeout);
  }
}
