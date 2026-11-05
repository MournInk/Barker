export type RecurrencePreset = "daily" | "weekdays" | "weekly" | "monthly" | "custom";

/**
 * Single source of truth for the scheduler wall clock. Kept in this dependency-free
 * module so both the server (lib/cron.ts, lib/db.ts) and client components
 * (lib/ui.ts) can share it without pulling `croner` into the browser bundle.
 */
export const SCHEDULE_TIME_ZONE = "Asia/Shanghai";

export type TaskStatus = "active" | "paused" | "completed" | "archived";

export interface Task {
  id: string;
  name: string;
  description: string;
  startsAt: string;
  preset: RecurrencePreset;
  cron: string;
  repeatCount: number | null;
  endDate: string | null;
  sentCount: number;
  queuedCount: number;
  pendingCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BarkSettings {
  endpoint: string;
  deviceKey: string;
  title: string;
  sound: string;
  group: string;
  icon: string;
}

export interface TaskInput {
  name: string;
  description?: string;
  startsAt: string;
  preset: RecurrencePreset;
  cron: string;
  repeatCount?: number | null;
  endDate?: string | null;
}

export type DeliveryStatus = "pending" | "sending" | "sent";
export type DeliveryFilter = DeliveryStatus | "retrying";

export interface Delivery {
  id: string;
  taskId: string;
  taskName: string;
  description: string;
  occurrenceAt: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
}

export interface Dashboard {
  tasks: Task[];
  upcoming: Array<{ taskId: string; occurrenceAt: string }>;
  deviceKeyConfigured: boolean;
  endpoint: string;
  deliveries: { pending: number; retrying: number; nextRetryAt: string | null };
  stats: { active: number; paused: number; todaySent: number; totalSent: number };
  activity: Array<{ date: string; sent: number }>;
  recent: Delivery[];
  serverTime: string;
}

export const DEFAULT_SETTINGS: BarkSettings = {
  endpoint: "https://api.day.app",
  deviceKey: "",
  title: "Barker 提醒",
  sound: "1107",
  group: "Barker",
  icon: "",
};
