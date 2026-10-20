export type Overview = {
  tasks: import("./types").Task[];
  settings: Omit<import("./types").BarkSettings, "deviceKey">;
  deviceKeyConfigured: boolean;
  deliveries: { pending: number; retrying: number; nextRetryAt: string | null };
  retryQueue: Array<{ taskId: string; taskName: string; occurrenceAt: string; attempts: number; lastError: string | null; nextAttemptAt: string }>;
};

export function localInputValue(date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

export function toOffsetDateTime(value: string): string {
  return `${value}:00+08:00`;
}

export function formatTime(value: string | null): string {
  if (!value) return "—";
  const withYear = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric" });
  const targetYear = withYear.format(new Date(value));
  const currentYear = withYear.format(new Date());
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(targetYear !== currentYear ? { year: "numeric" as const } : {}),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
