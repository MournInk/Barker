"use client";

import { clockTime, formatTime, SCHEDULE_TIME_ZONE } from "@/lib/ui";
import { useWorkspace } from "./workspace-context";

export function useTime() {
  const { dashboard } = useWorkspace();
  const timeZone = dashboard?.displayTimeZone ?? SCHEDULE_TIME_ZONE;
  return {
    timeZone,
    formatTime: (value: string | null, options?: Intl.DateTimeFormatOptions) => formatTime(value, { timeZone, ...options }),
    clockTime: (value: string) => clockTime(value, timeZone),
  };
}
