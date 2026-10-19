export type RecurrencePreset = "daily" | "weekly" | "monthly" | "custom";

export type TaskStatus = "active" | "paused" | "completed" | "failed";

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
