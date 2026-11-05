"use client";

import { Button, Chip, Input, Label, ListBox, Modal, Select, TextField, Tooltip } from "@heroui/react";
import type { ComponentProps, ReactNode } from "react";
import { Glyph, type IconName } from "./icons";
import type { Task } from "@/lib/types";

export function IconButton({ label, icon, ...props }: { label: string; icon: IconName } & Omit<ComponentProps<typeof Button>, "children">) {
  return <Tooltip delay={300}><Button isIconOnly variant="ghost" aria-label={label} {...props}><Glyph name={icon} /></Button><Tooltip.Content>{label}</Tooltip.Content></Tooltip>;
}

export function Field({ label, hint, ...props }: { label: string; hint?: string } & ComponentProps<typeof Input>) {
  return <TextField className="field"><Label>{label}</Label><Input variant="secondary" {...props} />{hint && <p className="field-hint">{hint}</p>}</TextField>;
}

export function Pick({ label, value, options, onChange, className = "" }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; className?: string }) {
  return <Select aria-label={label} className={`field ${className}`} variant="secondary" value={value} onChange={(key) => { if (key !== null) onChange(String(key)); }}>
    <Label>{label}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover><ListBox>{options.map((option) => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>{option.label}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
  </Select>;
}

export function TaskBadge({ task }: { task: Task }) {
  const meta = {
    active: { color: "success" as const, label: "进行中" },
    paused: { color: "default" as const, label: "已暂停" },
    completed: { color: "default" as const, label: task.pendingCount ? "排期结束" : "已完成" },
    archived: { color: "default" as const, label: "已归档" },
  }[task.status];
  return <Chip size="sm" variant="soft" color={meta.color}><span className={`status-dot ${task.status === "active" ? "live" : ""}`} /><Chip.Label>{meta.label}</Chip.Label></Chip>;
}

export function Notice({ children, kind = "error", onClose }: { children: ReactNode; kind?: "error" | "success" | "info"; onClose?: () => void }) {
  return <div className={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}><Glyph name={kind === "success" ? "circleCheck" : kind === "error" ? "warning" : "shield"} /><div>{children}</div>{onClose && <IconButton label="关闭提示" icon="close" size="sm" onPress={onClose} />}</div>;
}

export function Empty({ title, description, action, icon = "bell" }: { title: string; description: string; action?: ReactNode; icon?: IconName }) {
  return <div className="empty-state"><span className="empty-symbol"><Glyph name={icon} size={27} /></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function Confirm({ title, children, confirmLabel, onConfirm, onClose, busy = false }: { title: string; children: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  return <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open && !busy) onClose(); }} isDismissable={!busy}><Modal.Container size="sm" placement="center"><Modal.Dialog>
    <Modal.Header><Modal.Heading>{title}</Modal.Heading></Modal.Header><Modal.Body>{children}</Modal.Body><Modal.Footer><Button variant="ghost" isDisabled={busy} onPress={onClose}>取消</Button><Button variant="danger-soft" isPending={busy} onPress={onConfirm}>{confirmLabel}</Button></Modal.Footer>
  </Modal.Dialog></Modal.Container></Modal.Backdrop>;
}
