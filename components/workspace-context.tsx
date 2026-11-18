"use client";

import { createContext, useContext } from "react";
import type { Dashboard, Task } from "@/lib/types";

export const WorkspaceContext = createContext<{
  dashboard: Dashboard | null;
  error: string;
  refresh: () => Promise<void>;
  openTask: (task?: Task, duplicate?: boolean) => void;
  notify: (message: string, kind?: "error" | "success") => void;
  logout: () => Promise<void>;
} | null>(null);

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace context is required");
  return context;
}
