"use client";

import { Button, Card, Chip } from "@heroui/react";
import { useEffect, useState, type FormEvent } from "react";
import { Glyph } from "@/components/icons";
import { Confirm, Field, Notice } from "@/components/primitives";
import { useUnsaved } from "@/components/use-unsaved";
import { useResource } from "@/components/use-resource";
import { useWorkspace } from "@/components/workspace-context";
import { DeviceManager } from "@/components/device-manager";
import { AuditLog, SecurityManager } from "@/components/security-manager";
import type { BarkSettings } from "@/lib/types";
import { api, errorMessage } from "@/lib/ui";

type SettingsPayload = { settings: Omit<BarkSettings, "deviceKey">; deviceKeyConfigured: boolean; dataDir: string; revision: number };

export default function SettingsPage() {
  const { data, error, refresh } = useResource<SettingsPayload>("/api/settings", 15_000);
  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">连接设备，让提醒抵达</p><h1>推送设置<span className="heading-period">。</span></h1><p>你的 Bark，你的节奏。只需连接一次，之后交给 Barker。</p></div><Chip variant="soft" color={data?.deviceKeyConfigured ? "success" : "default"}><span className={`status-dot ${data?.deviceKeyConfigured ? "live" : ""}`} /><Chip.Label>{data?.deviceKeyConfigured ? "设备已配置" : data ? "等待连接" : error ? "配置不可用" : "正在读取"}</Chip.Label></Chip></div>{error && <Notice>{error}<Button size="sm" variant="ghost" onPress={() => void refresh()}>重试</Button></Notice>}{data ? <SettingsForm initial={data} onSaved={refresh} /> : error ? null : <div className="loading-state">正在读取你的配置…</div>}</div>;
}

function SettingsForm({ initial, onSaved }: { initial: SettingsPayload; onSaved: () => Promise<void> }) {
  const { refresh, notify } = useWorkspace();
  const [settings, setSettings] = useState<BarkSettings>({ ...initial.settings, deviceKey: "" });
  const [saved, setSaved] = useState<BarkSettings>({ ...initial.settings, deviceKey: "" });
  const [configured, setConfigured] = useState(initial.deviceKeyConfigured);
  const [revision, setRevision] = useState(initial.revision);
  const [pruning, setPruning] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [clearDeviceKey, setClearDeviceKey] = useState(false);
  const [confirmClearDeviceKey, setConfirmClearDeviceKey] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; kind: "error" | "success" } | null>(null);
  const dirty = clearDeviceKey || JSON.stringify(saved) !== JSON.stringify(settings);
  const conflict = initial.revision > revision;
  useUnsaved(dirty);
  useEffect(() => {
    if (dirty || initial.revision <= revision) return;
    const timer = setTimeout(() => {
      const next = { ...initial.settings, deviceKey: "" };
      setSettings(next); setSaved(next); setRevision(initial.revision); setConfigured(initial.deviceKeyConfigured); setClearDeviceKey(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [initial, dirty, revision]);
  function reload() {
    const source = conflict ? initial : { settings: saved, revision, deviceKeyConfigured: configured };
    const next = { ...source.settings, deviceKey: "" };
    setSettings(next); setSaved(next); setRevision(source.revision); setConfigured(source.deviceKeyConfigured); setClearDeviceKey(false); setFeedback(null);
  }
  function update(key: keyof BarkSettings, value: string) { setSettings((previous) => ({ ...previous, [key]: value })); if (key === "deviceKey") setClearDeviceKey(false); setFeedback(null); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("save"); setFeedback(null);
    try {
      const response = await api<{ revision: number }>("/api/settings", { method: "PUT", body: JSON.stringify({ ...settings, revision, clearDeviceKey }) });
      const next = { ...settings, deviceKey: "" };
      setConfigured(clearDeviceKey ? false : configured || Boolean(settings.deviceKey.trim()));
      setSettings((current) => JSON.stringify(current) === JSON.stringify(settings) ? next : { ...current, deviceKey: current.deviceKey === settings.deviceKey ? "" : current.deviceKey });
      setSaved(next); setRevision(response.revision); setClearDeviceKey(false);
      setFeedback({ message: clearDeviceKey ? "设备连接已清除。已有队列会保留，配置新设备后继续尝试。" : "设置已保存。队列中的提醒将使用新配置继续尝试。", kind: "success" }); void Promise.allSettled([refresh(), onSaved()]);
    } catch (error) { setFeedback({ message: errorMessage(error), kind: "error" }); void onSaved().catch(() => undefined); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy("test"); setFeedback(null);
    try { await api("/api/settings/test", { method: "POST", body: "{}" }); setFeedback({ message: "Bark 已确认接收测试通知，请查看你的设备。", kind: "success" }); notify("测试通知已送达 Bark。"); }
    catch (error) { setFeedback({ message: errorMessage(error), kind: "error" }); }
    finally { setBusy(null); }
  }
  async function prune() {
    setPruning(true);
    try {
      const result = await api<{ removed: number }>("/api/deliveries", { method: "DELETE", body: JSON.stringify({ before: new Date(Date.now() - 30 * 86_400_000).toISOString(), all: true, compact: true }) });
      setConfirmPrune(false); notify(`已清理 ${result.removed} 条结束记录，并回收数据库空间。`); void refresh().catch(() => undefined);
    } catch (error) { notify(errorMessage(error), "error"); }
    finally { setPruning(false); }
  }
  return <div className="settings-grid"><div className="settings-main"><form onSubmit={save}><Card className="settings-card"><div className="section-top"><div className="settings-section-title"><span className="settings-symbol"><Glyph name="link" size={23} /></span><div><h2>连接 Bark</h2><p>让重要的提醒，直达你的设备。</p></div></div><Chip variant="soft" size="sm">Bark API</Chip></div>
    <div className="settings-fields">{conflict && <Notice>设置已在其他页面更新。<Button type="button" size="sm" variant="ghost" onPress={reload}>载入最新设置</Button></Notice>}{clearDeviceKey && <Notice kind="info">保存后将清除当前 Device Key。<Button type="button" size="sm" variant="ghost" onPress={() => setClearDeviceKey(false)}>撤销</Button></Notice>}<Field label="API 服务地址" value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://api.day.app" type="url" required maxLength={300} hint="配置一个 Bark 服务和一个设备；更换地址时需要重新输入该服务的 Device Key。无需添加 /push。" />{settings.endpoint.startsWith("http:") && <Notice kind="info">此地址使用明文 HTTP，沿途网络可读取 Device Key 和通知内容。跨网络连接请使用 HTTPS。</Notice>}<Field label="Device Key" value={settings.deviceKey} onChange={(event) => update("deviceKey", event.target.value)} placeholder={configured ? "已保存在服务端，同一服务留空保持不变" : "粘贴你的 Bark Device Key"} type="password" autoComplete="new-password" maxLength={300} hint={configured ? "密钥仅保存在服务端，不会在页面回显。" : "打开 Bark，设备链接中服务地址后的那段字符就是 Device Key。"} />
      <details className="advanced-settings"><summary>更多通知选项<Glyph name="chevronDown" size={15} /></summary><div className="advanced-fields"><div className="form-grid"><Field label="通知分组" value={settings.group} onChange={(event) => update("group", event.target.value)} maxLength={100} placeholder="Barker" /><Field label="提示音" value={settings.sound} onChange={(event) => update("sound", event.target.value)} maxLength={80} placeholder="1107" /></div><Field label="通知图标 URL" value={settings.icon} onChange={(event) => update("icon", event.target.value)} placeholder="https://example.com/icon.png（可选）" type="url" maxLength={300} hint="留空时使用 Bark 默认图标。" /></div></details>
      <Field label="显示时区" value={settings.displayTimeZone ?? "Asia/Shanghai"} onChange={(event) => update("displayTimeZone", event.target.value)} maxLength={100} required hint="概览日期、统计与所有投递时间使用此 IANA 时区。任务自身时区不受影响。" />
      {feedback && <Notice kind={feedback.kind}>{feedback.message}</Notice>}
    </div><div className="settings-actions"><span>{dirty ? "有尚未保存的修改" : "修改配置后，记得保存"}</span><Button type="button" variant="ghost" isDisabled={!dirty || busy !== null} onPress={reload}>取消修改</Button>{configured && !clearDeviceKey && <Button type="button" variant="ghost" isDisabled={busy !== null} onPress={() => setConfirmClearDeviceKey(true)}>断开设备</Button>}<Button type="submit" isPending={busy === "save"} isDisabled={!dirty || busy !== null || conflict}>保存设置</Button></div>
  </Card></form><Card className="test-card"><span className="settings-symbol"><Glyph name="send" size={22} /></span><div><h2>试着打个招呼</h2><p>{dirty ? "请先保存修改，再发送一条测试通知。" : "发送一条测试通知，确认 Barker 和你的设备已连接。"}</p></div><Button variant="outline" onPress={() => void test()} isPending={busy === "test"} isDisabled={!configured || dirty || busy !== null || conflict}>发送测试</Button></Card>
    <div className="page-note"><Glyph name="lock" size={16} /><p>Device Key 仅用于向你配置的 Bark API 发起推送，不会暴露给浏览器。</p></div>
    <Card className="test-card">
      <span className="settings-symbol"><Glyph name="archive" size={22} /></span>
      <div><h2>历史记录维护</h2><p>一次清理全部 30 天前已接收、已取消及已过期的记录，并回收数据库空间。累计排期和接收次数保留。</p></div>
      <Button variant="outline" onPress={() => setConfirmPrune(true)}>清理旧记录</Button>
    </Card>
    {confirmPrune && <Confirm title="清理 30 天前的结束记录？" confirmLabel="清理记录" onClose={() => setConfirmPrune(false)} onConfirm={() => void prune()} busy={pruning}><p>相应消息正文及尝试历史将被永久删除。请先通过服务端备份工具保留需要的历史。等待投递和发送中的消息不会被清理。</p></Confirm>}
    {confirmClearDeviceKey && <Confirm title="断开当前 Bark 设备？" confirmLabel="断开设备" onClose={() => setConfirmClearDeviceKey(false)} onConfirm={() => { setClearDeviceKey(true); setConfirmClearDeviceKey(false); }}><p>保存后，当前服务地址会保留，Device Key 将被清除。队列不会丢失，但在配置新设备前不会送达。</p></Confirm>}
    <DeviceManager /><SecurityManager /><AuditLog />
  </div><aside className="settings-aside"><Card className="notification-preview"><div className="section-top"><h2>通知预览</h2><span className="mini-label">随配置更新</span></div><div className="notification-sample"><strong>{settings.title}</strong><p>测试通知将发送到 {settings.endpoint}。</p><small>分组 {settings.group || "无"} · 提示音 {settings.sound || "默认"}</small>{settings.icon && <p className="field-hint">图标：{settings.icon}</p>}</div><p className="preview-caption">任务编辑器显示各自的标题、正文和覆盖选项；实际外观由设备决定。</p></Card>
    <section className="settings-help"><h2>第一次使用？</h2><ol><li><span>1</span><p>在 iPhone 上打开 Bark 应用。</p></li><li><span>2</span><p>复制设备链接，将服务地址与 Device Key 填入左侧。</p></li><li><span>3</span><p>保存设置，发送测试通知。一切就绪。</p></li></ol><a href="https://bark.day.app" target="_blank" rel="noreferrer" className="text-action">了解 Bark<Glyph name="arrow" size={15} /></a></section>
    <section className="storage-note"><Glyph name="shield" size={18} /><div><h3>数据在你手中</h3><p>任务、投递队列与配置保存在本机 SQLite 数据库。备份请使用一致性数据库快照，或停止服务后复制整个数据目录。</p><code>{initial.dataDir}/barker.sqlite</code></div></section>
  </aside></div>;
}
