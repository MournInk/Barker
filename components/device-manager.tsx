"use client";

import { Button, Card } from "@heroui/react";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/ui";
import type { Device } from "@/lib/types";
import { Confirm, Field, Notice } from "./primitives";
import { useResource } from "./use-resource";
import { useUnsaved } from "./use-unsaved";

const empty = { id: undefined as string | undefined, name: "", endpoint: "https://api.day.app", deviceKey: "", revision: undefined as number | undefined };

export function DeviceManager() {
  const { data, error, refresh } = useResource<{ devices: Device[] }>("/api/devices", 15000);
  const [form, setForm] = useState(empty);
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<Device | null>(null);
  useUnsaved(dirty);
  function update(field: string, value: string) { setForm((current) => ({ ...current, [field]: value })); setDirty(true); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFeedback("");
    try {
      await api("/api/devices", { method: "POST", body: JSON.stringify(form) });
      setForm(empty); setDirty(false); setFeedback("设备已保存。"); await refresh();
    } catch (error) { setFeedback(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function deleteDevice() {
    if (!remove) return;
    setBusy(true);
    try {
      await api(`/api/devices?id=${encodeURIComponent(remove.id)}`, { method: "DELETE", headers: { "if-match": String(remove.revision) } });
      setRemove(null); await refresh();
    } catch (error) { setFeedback(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <Card className="management-card">
    <h2>更多设备</h2><p>每个任务可选择独立设备与服务地址。默认设备在上方设置。</p>
    {(error || feedback) && <Notice>{error || feedback}</Notice>}
    <div className="management-list">{data?.devices.filter((device) => device.id !== "default").map((device) => <div key={device.id}>
      <span><strong>{device.name}</strong><small>{device.endpoint}</small></span>
      <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => { if (dirty && !window.confirm("放弃当前设备编辑？")) return; setForm({ ...device, deviceKey: "" }); setDirty(false); }}>编辑</Button>
      <Button size="sm" variant="danger-soft" isDisabled={busy} onPress={() => setRemove(device)}>删除</Button>
    </div>)}</div>
    <form onSubmit={save} className="management-form">
      <fieldset disabled={busy}>
        <Field label="设备名称" value={form.name} onChange={(event) => update("name", event.target.value)} maxLength={80} required />
        <Field label="设备服务地址" value={form.endpoint} onChange={(event) => update("endpoint", event.target.value)} type="url" maxLength={300} required />
        <Field label="设备密钥" value={form.deviceKey} onChange={(event) => update("deviceKey", event.target.value)} type="password" autoComplete="new-password" maxLength={300} required={!form.id} hint={form.id ? "同一服务留空保留已有密钥" : "密钥保存后不回显"} />
      </fieldset>
      <div className="management-actions"><Button type="button" variant="ghost" isDisabled={busy} onPress={() => { setForm(empty); setDirty(false); }}>取消</Button><Button type="submit" isPending={busy}>{form.id ? "保存设备" : "添加设备"}</Button></div>
    </form>
    {remove && <Confirm title={`删除设备「${remove.name}」？`} confirmLabel="删除设备" onClose={() => setRemove(null)} onConfirm={() => void deleteDevice()} busy={busy}><p>仍被任务或队列引用的设备不能删除。</p></Confirm>}
  </Card>;
}
