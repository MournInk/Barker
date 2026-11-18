import type { z } from "zod";
import type { deliverySchema, settingsFields, taskFields, taskSchema } from "./contracts";

export type RecurrencePreset = TaskInput["preset"];

/**
 * Single source of truth for the scheduler wall clock. Kept in this dependency-free
 * module so both the server (lib/cron.ts, lib/db.ts) and client components
 * (lib/ui.ts) can share it without pulling `croner` into the browser bundle.
 */
export const SCHEDULE_TIME_ZONE = "Asia/Shanghai";

export type TaskStatus = "active" | "paused" | "completed" | "archived";

export type Task = z.output<typeof taskSchema>;

export type BarkSettings = Omit<z.output<typeof settingsFields>, "displayTimeZone"> & { displayTimeZone?: string };

export type TaskInput = z.input<typeof taskFields>;

export type DeliveryStatus = "pending" | "sending" | "sent" | "cancelled" | "expired";
export type DeliveryFilter = DeliveryStatus | "retrying";

export type Delivery = z.output<typeof deliverySchema>;

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "sending" | "sent" | "failed" | "interrupted";
  error: string | null;
}

export interface Dashboard {
  displayTimeZone?: string;
  taskTotal?: number;
  tasks: Task[];
  upcoming: Array<{ taskId: string; occurrenceAt: string }>;
  upcomingDays: Array<{ date: string; total: number; hidden: number }>;
  deviceKeyConfigured: boolean;
  endpoint: string;
  deliveries: { pending: number; retrying: number; nextRetryAt: string | null };
  stats: { active: number; paused: number; todaySent: number; totalSent: number };
  activity: Array<{ date: string; sent: number }>;
  recent: Delivery[];
  serverTime: string;
}

export const DEFAULT_SETTINGS: BarkSettings = {
  displayTimeZone: SCHEDULE_TIME_ZONE,
  endpoint: "https://api.day.app",
  deviceKey: "",
  title: "Barker 提醒",
  sound: "1107",
  group: "Barker",
  icon: "",
};

export interface NotificationOptions {
  sound?: string;
  group?: string;
  icon?: string;
}

export interface Device {
  id: string;
  name: string;
  endpoint: string;
  deviceKeyConfigured: boolean;
  revision: number;
}
