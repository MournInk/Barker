"use client";

import { Button, Input, Label, Modal, Tabs, TextArea, TextField } from "@heroui/react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { RecurrencePreset, Task, TaskInput } from "@/lib/types";
import { api, clientPresetCron, errorMessage, formatTime, localDateValue, localInputValue, PRESET_LABELS, toOffsetDateTime } from "@/lib/ui";
import { CalendarField } from "./calendar-field";
import { Glyph } from "./icons";
import { Field, IconButton, Notice, Pick } from "./primitives";
import { useWorkspace } from "./workspace-context";

export function TaskEditor({ task, duplicate = false, onClose }: { task?: Task; duplicate?: boolean; onClose: () => void }) {
  const editing = Boolean(task && !duplicate);
  const { refresh, notify, dashboard } = useWorkspace();
  const [name, setName] = useState(task ? task.name + (duplicate ? "（副本）" : "") : "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [startsAt, setStartsAt] = useState(() => editing && task ? localInputValue(new Date(task.startsAt)) : localInputValue(new Date(Date.now() + 300_000)));
  const [preset, setPreset] = useState<RecurrencePreset>(task?.preset ?? "daily");
  const [cron, setCron] = useState(task?.cron ?? "0 9 * * *");
  const [limit, setLimit] = useState(task?.endDate ? "date" : "count");
  const [count, setCount] = useState(String(task?.repeatCount ?? 30));
  const [endDate, setEndDate] = useState(() => task?.endDate && (editing || task.endDate >= localDateValue(new Date())) ? task.endDate : localDateValue(new Date(Date.now() + 30 * 86_400_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generatedCron = preset === "custom" ? cron : clientPresetCron(preset, startsAt);
  const payload = useMemo<TaskInput>(() => ({ name, description, startsAt: toOffsetDateTime(startsAt), preset, cron: generatedCron, repeatCount: limit === "count" ? Number(count) : null, endDate: limit === "date" ? endDate : null }), [name, description, startsAt, preset, generatedCron, limit, count, endDate]);
  const previewKey = JSON.stringify({ ...payload, name: "预览", description: "", ...(editing ? { taskId: task!.id } : {}) });
  const [preview, setPreview] = useState<{ key: string; dates: string[]; error: string }>({ key: "", dates: [], error: "" });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ dates: string[] }>("/api/tasks/preview", { method: "POST", body: previewKey, signal: controller.signal }).then((data) => setPreview({ key: previewKey, dates: data.dates, error: "" })).catch((error) => { if (!controller.signal.aborted) setPreview({ key: previewKey, dates: [], error: errorMessage(error) }); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [previewKey]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api(editing ? `/api/tasks/${task!.id}` : "/api/tasks", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      notify(editing ? "提醒已更新，已排队的消息保持原样。" : "提醒已创建，接下来的安排交给 Barker。");
      await refresh(); window.dispatchEvent(new Event("barker:tasks-changed")); onClose();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open && !busy) onClose(); }} isDismissable={!busy}><Modal.Container size="lg" placement="center" scroll="inside"><Modal.Dialog className="task-dialog">
    <form onSubmit={save} className="task-form"><Modal.Header className="editor-header"><div className="editor-title-row"><span className="editor-symbol"><Glyph name="calendar" size={23} /></span><IconButton label="关闭编辑器" icon="close" isDisabled={busy} onPress={onClose} /></div><Modal.Heading>{editing ? "编辑提醒" : duplicate ? "复制为新提醒" : "留一个提醒给未来"}</Modal.Heading><p className="text-muted text-sm">写下要记住的事，剩下的交给时间。</p></Modal.Header>
      <Modal.Body className="editor-body">{error && <Notice>{error}</Notice>}
        <Field label="提醒名称" placeholder="例如：每周项目复盘" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoFocus />
        <TextField className="field"><Label>提醒内容 <span className="optional">可选</span></Label><TextArea variant="secondary" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="到时候，想对自己说些什么？" maxLength={2000} /></TextField>
        <div className="form-section-label"><Glyph name="clock" size={16} />安排时间<span>北京时间 · UTC+8</span></div>
        <div className="form-grid"><CalendarField label="开始时间" value={startsAt} onChange={setStartsAt} /><Pick label="重复周期" value={preset} onChange={(value) => setPreset(value as RecurrencePreset)} options={Object.entries(PRESET_LABELS).map(([value, label]) => ({ value, label }))} /></div>
        {preset === "custom" && <Field label="Cron 表达式" value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" hint="标准五段格式：分 时 日 月 周。例如 0 9 * * 1-5 表示工作日 09:00。" required />}
        {preset === "monthly" && Number(startsAt.slice(8, 10)) > 28 && <Notice kind="info">按每月相同日期提醒；短月不存在的日期会跳过。</Notice>}
        <div className="limit-header"><Label>何时结束</Label>{editing && task && task.queuedCount > 0 && <span className="field-hint">已排期 {task.queuedCount} 次，计入总次数</span>}</div>
        <Tabs selectedKey={limit} onSelectionChange={(key) => setLimit(String(key))} className="limit-tabs"><Tabs.ListContainer><Tabs.List aria-label="结束条件"><Tabs.Tab id="count">按重复次数<Tabs.Indicator /></Tabs.Tab><Tabs.Tab id="date">按截止日期<Tabs.Indicator /></Tabs.Tab></Tabs.List></Tabs.ListContainer><Tabs.Panel id="count"><div className="count-field"><Input aria-label="重复次数" variant="secondary" type="number" min={1} max={100000} step={1} value={count} onChange={(event) => setCount(event.target.value)} required={limit === "count"} /><span>次后结束</span><p>每个排期仅计一次，失败重试不额外占用次数。</p></div></Tabs.Panel><Tabs.Panel id="date"><CalendarField label="截止日期（含当天）" value={endDate} onChange={setEndDate} dateOnly /></Tabs.Panel></Tabs>
        <div className="schedule-preview"><div className="preview-title"><Glyph name="calendar" size={17} /><h3>接下来的提醒</h3><code>{generatedCron || "—"}</code></div>{preview.key !== previewKey ? <p className="field-hint">正在计算排期…</p> : preview.error ? <p className="preview-error">{preview.error}</p> : !preview.dates.length ? <p className="field-hint">已排期次数达到新的上限，保存后结束排期；待投递消息仍会继续发送。</p> : <ol>{preview.dates.slice(0, 3).map((date, index) => <li key={date}><span>{String(index + 1).padStart(2, "0")}</span><time dateTime={date}>{formatTime(date)}</time></li>)}</ol>}</div>
        {!dashboard?.deviceKeyConfigured && <p className="field-hint">尚未连接 Bark，提醒仍会可靠排队。<Link href="/settings" onClick={onClose} className="inline-link">前往设置</Link></p>}
      </Modal.Body><Modal.Footer className="editor-footer"><span><Glyph name="shield" size={15} />失败自动重试，不遗漏</span><Button variant="ghost" isDisabled={busy} onPress={onClose}>取消</Button><Button type="submit" isPending={busy}>{editing ? "保存修改" : "创建提醒"}</Button></Modal.Footer></form>
  </Modal.Dialog></Modal.Container></Modal.Backdrop>;
}
