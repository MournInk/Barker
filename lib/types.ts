export type RecurrencePreset = "daily" | "weekly" | "monthly" | "custom";

/**
 * Single source of truth for the scheduler wall clock. Kept in this dependency-free
 * module so both the server (lib/cron.ts, lib/db.ts) and client components
 * (lib/ui.ts) can share it without pulling `croner` into the browser bundle.
 */
export const SCHEDULE_TIME_ZONE = "Asia/Shanghai";

export type TaskStatus = "active" | "paused" | "completed";

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

export interface StoreData {
  settings: BarkSettings;
  tasks: Task[];
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

export const DEFAULT_SETTINGS: BarkSettings = {
  endpoint: "https://api.day.app",
  deviceKey: "",
  title: "Barker 提醒",
  sound: "1107",
  group: "Barker",
  icon: "",
};
