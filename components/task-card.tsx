"use client";

import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RecurrencePreset, Task, TaskStatus } from "@/lib/types";
import { formatTime } from "@/lib/ui";

const PRESET_LABEL: Record<RecurrencePreset, string> = { daily: "每天", weekly: "每周", monthly: "每月", custom: "自定义" };
const STATUS_LABEL: Record<TaskStatus, string> = { active: "运行中", paused: "已暂停", completed: "已完成" };
const STATUS_VARIANT: Record<TaskStatus, "success" | "warning" | "secondary"> = {
  active: "success",
  paused: "warning",
  completed: "secondary",
};

export function TaskCard({
  task,
  onEdit,
  onToggle,
  onDelete,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
}) {
  const completed = task.status === "completed";

  return (
    <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">{task.name}</h2>
          <Badge variant={STATUS_VARIANT[task.status]}>{STATUS_LABEL[task.status]}</Badge>
          <Badge variant="outline">{PRESET_LABEL[task.preset]}</Badge>
        </div>
        {task.description && <p className="line-clamp-1 text-xs text-muted-foreground">{task.description}</p>}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground sm:text-xs">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{task.cron}</code>
          <span aria-hidden className="text-muted-foreground/40">·</span>
          <span>下次 {formatTime(task.nextRunAt)}</span>
          <span aria-hidden className="text-muted-foreground/40">·</span>
          <span>
            已发送 {task.sentCount}
            {task.repeatCount ? ` / ${task.repeatCount}` : ""}
          </span>
          {task.endDate && (
            <>
              <span aria-hidden className="text-muted-foreground/40">·</span>
              <span>截止 {task.endDate}</span>
            </>
          )}
        </p>
        {task.lastError && <p className="text-xs text-destructive">{task.lastError}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" type="button" className="h-9 sm:h-8" disabled={completed} onClick={() => onEdit(task)}>
          <Pencil size={14} />
          编辑
        </Button>
        {!completed && (
          <Button variant="outline" size="sm" type="button" className="h-9 sm:h-8" onClick={() => onToggle(task)}>
            {task.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
            {task.status === "paused" ? "恢复" : "暂停"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="h-9 text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-8"
          onClick={() => onDelete(task)}
        >
          <Trash2 size={14} />
          删除
        </Button>
      </div>
    </div>
  );
}
