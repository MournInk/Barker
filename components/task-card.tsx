"use client";

import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import type { RecurrencePreset, Task, TaskStatus } from "@/lib/types";
import { formatTime } from "@/lib/ui";

const PRESET_LABEL: Record<RecurrencePreset, string> = { daily: "每天", weekly: "每周", monthly: "每月", custom: "自定义" };
const STATUS_LABEL: Record<TaskStatus, string> = { active: "运行中", paused: "已暂停", completed: "已完成" };

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
  return (
    <article className="task">
      <div className="task__head">
        <h2>{task.name}</h2>
        <span className={`badge ${task.status}`}>{STATUS_LABEL[task.status]}</span>
      </div>
      {task.description && <p>{task.description}</p>}
      <p className="meta">
        <span>{PRESET_LABEL[task.preset]}</span>
        <code>{task.cron}</code>
        <span>已发送 {task.sentCount}{task.repeatCount ? ` / ${task.repeatCount}` : ""}</span>
      </p>
      <p className="muted" style={{ color: "var(--muted)", fontSize: 12 }}>
        下次 {formatTime(task.nextRunAt)} · 截止 {task.endDate ?? "按次数"}
        {task.lastError ? ` · ${task.lastError}` : ""}
      </p>
      <div className="actions">
        <button className="ghost" onClick={() => onEdit(task)} disabled={task.status === "completed"}>
          <Pencil size={14} /> 编辑
        </button>
        {task.status !== "completed" && (
          <button className="ghost" onClick={() => onToggle(task)}>
            {task.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
            {task.status === "paused" ? "恢复" : "暂停"}
          </button>
        )}
        <button className="danger" onClick={() => onDelete(task)}>
          <Trash2 size={14} /> 删除
        </button>
      </div>
    </article>
  );
}
