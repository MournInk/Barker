import type { BarkSettings } from "./types";

export class BarkDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarkDeliveryError";
  }
}

export async function sendBark(
  settings: BarkSettings,
  title: string,
  body: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!settings.deviceKey.trim()) throw new BarkDeliveryError("尚未配置 Bark Device Key，推送已保留并将继续重试");
  const endpoint = settings.endpoint.replace(/\/+$/, "");
  const url = new URL(`${endpoint}/push`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
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
    if (!response.ok) throw new BarkDeliveryError(`Bark API 返回 HTTP ${response.status}`);
    let result: { code?: number; message?: string } | null = null;
    try {
      result = await response.json() as { code?: number; message?: string };
    } catch {
      // Some compatible Bark endpoints return an empty 2xx response.
    }
    if (result?.code !== undefined && result.code !== 200) {
      throw new BarkDeliveryError(`Bark API 拒绝推送${result.message ? `：${result.message.slice(0, 120)}` : ""}`);
    }
  } catch (error) {
    if (error instanceof BarkDeliveryError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new BarkDeliveryError("Bark API 请求超时，将自动重试");
    throw new BarkDeliveryError(`Bark API 网络错误：${error instanceof Error ? error.message.slice(0, 160) : "未知错误"}`);
  } finally {
    clearTimeout(timeout);
  }
}
