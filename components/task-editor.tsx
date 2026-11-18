"use client";

import { Button, Input, Label, Modal, Tabs, TextArea, TextField } from "@heroui/react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Device, RecurrencePreset, Task, TaskInput } from "@/lib/types";
import { api, clientPresetCron, createIdempotencyKey, duplicateStart, errorMessage, localDateValue, localInputValue, PRESET_LABELS, SCHEDULE_TIME_ZONE, toOffsetDateTime } from "@/lib/ui";
import { useTime } from "./use-time";
import { CalendarField } from "./calendar-field";
import { Glyph } from "./icons";
import { Field, IconButton, Notice, Pick } from "./primitives";
import { useWorkspace } from "./workspace-context";
import { useUnsaved } from "./use-unsaved";
import { useResource } from "./use-resource";

export function TaskEditor({ task, duplicate = false, onClose }: { task?: Task; duplicate?: boolean; onClose: () => void }) {
  const { formatTime } = useTime();
  const descriptionHintId = useId();
  const [persisted, setPersisted] = useState<Task | undefined>(duplicate ? undefined : task);
  const editing = Boolean(persisted);
  const { refresh, notify, dashboard } = useWorkspace();
  const { data: devices } = useResource<{ devices: Device[] }>("/api/devices", 0);
  const [name, setName] = useState(task ? duplicate ? `${task.name.slice(0, 76)}（副本）` : task.name : "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [timeZone, setTimeZone] = useState(task?.timeZone ?? SCHEDULE_TIME_ZONE);
  const [startsAt, setStartsAt] = useState(() => task ? duplicate ? duplicateStart(task) : localInputValue(new Date(task.startsAt), task.timeZone) : localInputValue(new Date(Date.now() + 300_000)));
  const [preset, setPreset] = useState<RecurrencePreset>(task?.preset ?? "once");
  const [cron, setCron] = useState(task?.cron ?? "0 9 * * *");
  const [limit, setLimit] = useState(task?.endDate ? "date" : task && task.repeatCount === null ? "never" : "count");
  const [count, setCount] = useState(String(task?.repeatCount ?? 30));
  const [endDate, setEndDate] = useState(() => task?.endDate ?? localDateValue(new Date(Date.now() + 30 * 86_400_000), timeZone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lateness, setLateness] = useState(String(task?.maxLatenessMinutes ?? ""));
  const [deviceId, setDeviceId] = useState(task?.deviceId ?? "default");
  const [sound, setSound] = useState(task?.notification?.sound ?? "");
  const [group, setGroup] = useState(task?.notification?.group ?? "");
  const [skipDates, setSkipDates] = useState(task?.skipDates?.join(", ") ?? "");
  const [includeDates, setIncludeDates] = useState(task?.includeDates?.join(", ") ?? "");
  const [previewVersion, setPreviewVersion] = useState(0);
  const creation = useRef<{ payload: string; key: string } | null>(null);
  const generatedCron = preset === "custom" ? cron : clientPresetCron(preset, startsAt);
  const payload = useMemo<TaskInput>(() => ({
    name, description, startsAt: toOffsetDateTime(startsAt, timeZone), timeZone,
    maxLatenessMinutes: lateness ? Number(lateness) : null, preset, cron: generatedCron,
    repeatCount: preset === "once" ? 1 : limit === "count" ? Number(count) : null,
    endDate: preset !== "once" && limit === "date" ? endDate : null,
    deviceId, notification: { ...(sound ? { sound } : {}), ...(group ? { group } : {}) },
    skipDates: skipDates.split(/[\s,，]+/).filter(Boolean),
    includeDates: preset === "weekdays" ? includeDates.split(/[\s,，]+/).filter(Boolean) : [],
  }), [name, description, startsAt, timeZone, lateness, preset, generatedCron, limit, count, endDate, deviceId, sound, group, skipDates, includeDates]);
  const serialized = JSON.stringify(payload);
  const [savedPayload, setSavedPayload] = useState(serialized);
  const latestPayload = useRef(serialized);
  useEffect(() => { latestPayload.current = serialized; }, [serialized]);
  const dirty = serialized !== savedPayload;
  useUnsaved(dirty);
  const close = () => { if (!busy && (!dirty || window.confirm("有尚未保存的修改，确认放弃？"))) onClose(); };
  useEffect(() => { const timer = setInterval(() => setPreviewVersion((value) => value + 1), 30_000); return () => clearInterval(timer); }, []);
  const previewKey = JSON.stringify({ ...payload, name: "预览", description: "", ...(persisted ? { taskId: persisted.id } : {}) });
  const [preview, setPreview] = useState<{ key: string; dates: string[]; error: string }>({ key: "", dates: [], error: "" });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ dates: string[] }>("/api/tasks/preview", { method: "POST", body: previewKey, signal: controller.signal })
        .then((data) => setPreview({ key: previewKey, dates: data.dates, error: "" }))
        .catch((error) => { if (!controller.signal.aborted) setPreview({ key: previewKey, dates: [], error: errorMessage(error) }); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [previewKey, previewVersion]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const body = JSON.stringify({ ...payload, ...(persisted ? { revision: persisted.revision } : {}) });
      if (!creation.current || creation.current.payload !== body) creation.current = { payload: body, key: createIdempotencyKey() };
      const response = await api<{ task: Task }>(persisted ? `/api/tasks/${persisted.id}` : "/api/tasks", {
        method: persisted ? "PUT" : "POST", headers: persisted ? {} : { "idempotency-key": creation.current.key }, body,
      });
      setPersisted(response.task); setSavedPayload(serialized);
      notify(editing ? "提醒已更新，已排队的消息保持原样。" : "提醒已创建。");
      void refresh();
      window.dispatchEvent(new Event("barker:tasks-changed"));
      if (latestPayload.current === serialized) onClose();
      else setError("提交内容已保存；保存期间的新修改仍保留在这里，请再次保存。");
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) close(); }} isDismissable={!busy}>
      <Modal.Container size="lg" placement="center" scroll="inside"><Modal.Dialog className="task-dialog">
        <form onSubmit={save} className="task-form">
          <Modal.Header className="editor-header">
            <div className="editor-title-row"><span className="editor-symbol"><Glyph name="calendar" size={23} /></span><IconButton label="关闭编辑器" icon="close" isDisabled={busy} onPress={close} /></div>
            <Modal.Heading>{editing ? "编辑提醒" : duplicate ? "复制为新提醒" : "留一个提醒给未来"}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="editor-body">
            {error && <Notice>{error}</Notice>}
            <Field label="提醒名称" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoFocus />
            <TextField className="field"><Label>提醒内容</Label><TextArea variant="secondary" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} aria-describedby={descriptionHintId} /><p id={descriptionHintId} className="field-hint">标题与正文合计最多 3000 个 UTF-8 字节。</p></TextField>
            <div className="form-grid">
              <CalendarField label="开始时间" value={startsAt} onChange={setStartsAt} />
              <Pick label="重复周期" value={preset} onChange={(value) => setPreset(value as RecurrencePreset)} options={Object.entries(PRESET_LABELS).map(([value, label]) => ({ value, label }))} />
            </div>
            <Pick label="投递设备" value={deviceId} onChange={setDeviceId} options={(devices?.devices ?? [{ id: "default", name: "默认设备" }]).map((device) => ({ value: device.id, label: device.name }))} />
            {preset === "custom" && <Field label="Cron 表达式" value={cron} onChange={(event) => setCron(event.target.value)} required hint="标准五段格式：分 时 日 月 周。" />}
            {preset === "monthly" && Number(startsAt.slice(8, 10)) > 28 && <Notice kind="info">短月不存在的日期会跳过。</Notice>}
            <details className="advanced-settings">
              <summary>时区、节假日与通知策略<Glyph name="chevronDown" size={15} /></summary>
              <div className="advanced-fields">
                <Field label="排期时区" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} required hint="IANA 时区，例如 Asia/Shanghai、UTC。夏令时不存在的输入时间会拒绝。" />
                <Field label="跳过日期" value={skipDates} onChange={(event) => setSkipDates(event.target.value)} hint="填写 YYYY-MM-DD，以逗号分隔；用于假日或临时休息。" />
                {preset === "weekdays" && <Field label="补班日期" value={includeDates} onChange={(event) => setIncludeDates(event.target.value)} hint="补充周末工作日，沿用开始时间的时分；节假日规则由你维护。" />}
                <Field label="允许延迟（分钟，可选）" type="number" min={1} max={525600} value={lateness} onChange={(event) => setLateness(event.target.value)} hint="留空持续保留；永久错误需人工修正后重试。" />
                <div className="form-grid"><Field label="任务通知分组" value={group} onChange={(event) => setGroup(event.target.value)} maxLength={100} hint="留空使用全局设置" /><Field label="任务提示音" value={sound} onChange={(event) => setSound(event.target.value)} maxLength={80} hint="留空使用全局设置" /></div>
              </div>
            </details>
            {preset !== "once" && <>
              <div className="limit-header"><Label>何时结束</Label>{persisted && <span className="field-hint">已排期 {persisted.queuedCount} 次</span>}</div>
              <Tabs selectedKey={limit} onSelectionChange={(key) => setLimit(String(key))} className="limit-tabs">
                <Tabs.ListContainer><Tabs.List aria-label="结束条件">
                  <Tabs.Tab id="count">按重复次数<Tabs.Indicator /></Tabs.Tab><Tabs.Tab id="date">按截止日期<Tabs.Indicator /></Tabs.Tab><Tabs.Tab id="never">持续重复<Tabs.Indicator /></Tabs.Tab>
                </Tabs.List></Tabs.ListContainer>
                <Tabs.Panel id="count"><div className="count-field"><Input aria-label="重复次数" variant="secondary" type="number" min={1} max={100000} value={count} onChange={(event) => setCount(event.target.value)} required={limit === "count"} /><span>次后结束</span></div></Tabs.Panel>
                <Tabs.Panel id="date"><CalendarField label="截止日期（含当天）" value={endDate} onChange={setEndDate} dateOnly /></Tabs.Panel>
                <Tabs.Panel id="never"><p className="field-hint">持续排期，直到暂停或归档。</p></Tabs.Panel>
              </Tabs>
            </>}
            <div className="schedule-preview">
              <div className="preview-title"><h3>接下来的提醒</h3><code>{generatedCron || "—"}</code></div>
              <p className="field-hint">显示时区：{dashboard?.displayTimeZone ?? SCHEDULE_TIME_ZONE}</p>
              {preview.key !== previewKey ? <p>正在计算排期…</p> : preview.error ? <p className="preview-error">{preview.error}</p> : !preview.dates.length ? <p>没有剩余排期。</p> : <ol>{preview.dates.slice(0, 3).map((date, index) => <li key={date}><span>{index + 1}</span><time>{formatTime(date)}</time></li>)}</ol>}
            </div>
            <div className="notification-sample"><strong>{name || "提醒名称"}</strong><p>{description || "计划提醒时间已到。"}</p><small>分组：{group || "使用全局设置"} · 提示音：{sound || "使用全局设置"}</small></div>
            {dashboard && !dashboard.deviceKeyConfigured && deviceId === "default" && <p className="field-hint">默认设备未连接。<Link href="/settings" className="inline-link">前往设置</Link></p>}
          </Modal.Body>
          <Modal.Footer className="editor-footer"><Button type="button" variant="ghost" isDisabled={busy} onPress={close}>取消</Button><Button type="submit" isPending={busy}>{editing ? "保存修改" : "创建提醒"}</Button></Modal.Footer>
        </form>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
  );
}
