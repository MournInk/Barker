"use client";

import { Button, Card, Chip } from "@heroui/react";
import { useState, type FormEvent } from "react";
import { Glyph } from "@/components/icons";
import { Field, Notice } from "@/components/primitives";
import { useResource } from "@/components/use-resource";
import { useWorkspace } from "@/components/workspace-context";
import type { BarkSettings } from "@/lib/types";
import { api, errorMessage } from "@/lib/ui";

type SettingsPayload = { settings: Omit<BarkSettings, "deviceKey">; deviceKeyConfigured: boolean; dataDir: string };

export default function SettingsPage() {
  const { data, error, refresh } = useResource<SettingsPayload>("/api/settings", 0);
  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">连接设备，让提醒抵达</p><h1>推送设置<span className="heading-period">。</span></h1><p>你的 Bark，你的节奏。只需连接一次，之后交给 Barker。</p></div><Chip variant="soft" color={data?.deviceKeyConfigured ? "success" : "default"}><span className={`status-dot ${data?.deviceKeyConfigured ? "live" : ""}`} /><Chip.Label>{data?.deviceKeyConfigured ? "设备已配置" : "等待连接"}</Chip.Label></Chip></div>{error && <Notice>{error}<Button size="sm" variant="ghost" onPress={() => void refresh()}>重试</Button></Notice>}{data ? <SettingsForm initial={data} onSaved={refresh} /> : <div className="loading-state">正在读取你的配置…</div>}</div>;
}

function SettingsForm({ initial, onSaved }: { initial: SettingsPayload; onSaved: () => Promise<void> }) {
  const { refresh, notify } = useWorkspace();
  const [settings, setSettings] = useState<BarkSettings>({ ...initial.settings, deviceKey: "" });
  const [saved, setSaved] = useState<BarkSettings>({ ...initial.settings, deviceKey: "" });
  const [configured, setConfigured] = useState(initial.deviceKeyConfigured);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; kind: "error" | "success" } | null>(null);
  const dirty = JSON.stringify(saved) !== JSON.stringify(settings);
  function update(key: keyof BarkSettings, value: string) { setSettings((previous) => ({ ...previous, [key]: value })); setFeedback(null); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("save"); setFeedback(null);
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      const next = { ...settings, deviceKey: "" };
      setConfigured(configured || Boolean(settings.deviceKey.trim())); setSettings(next); setSaved(next);
      setFeedback({ message: "设置已保存。队列中的提醒将使用新配置继续尝试。", kind: "success" }); await Promise.all([refresh(), onSaved()]);
    } catch (error) { setFeedback({ message: errorMessage(error), kind: "error" }); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy("test"); setFeedback(null);
    try { await api("/api/settings/test", { method: "POST", body: "{}" }); setFeedback({ message: "Bark 已确认接收测试通知，请查看你的设备。", kind: "success" }); notify("测试通知已送达 Bark。"); }
    catch (error) { setFeedback({ message: errorMessage(error), kind: "error" }); }
    finally { setBusy(null); }
  }
  return <div className="settings-grid"><div className="settings-main"><form onSubmit={save}><Card className="settings-card"><div className="section-top"><div className="settings-section-title"><span className="settings-symbol"><Glyph name="link" size={23} /></span><div><h2>连接 Bark</h2><p>让重要的提醒，直达你的设备。</p></div></div><Chip variant="soft" size="sm">Bark API</Chip></div>
    <div className="settings-fields"><Field label="API 服务地址" value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://api.day.app" type="url" required maxLength={300} hint="使用 Bark 官方服务，或填写自建服务器地址。无需添加 /push。" /><Field label="Device Key" value={settings.deviceKey} onChange={(event) => update("deviceKey", event.target.value)} placeholder={configured ? "已安全保存，留空保持不变" : "粘贴你的 Bark Device Key"} type="password" autoComplete="new-password" maxLength={300} hint={configured ? "密钥仅保存在服务端，不会在页面回显。" : "打开 Bark，设备链接中服务地址后的那段字符就是 Device Key。"} />
      <details className="advanced-settings"><summary>更多通知选项<Glyph name="chevronDown" size={15} /></summary><div className="advanced-fields"><div className="form-grid"><Field label="通知分组" value={settings.group} onChange={(event) => update("group", event.target.value)} maxLength={100} placeholder="Barker" /><Field label="提示音" value={settings.sound} onChange={(event) => update("sound", event.target.value)} maxLength={80} placeholder="1107" /></div><Field label="通知图标 URL" value={settings.icon} onChange={(event) => update("icon", event.target.value)} placeholder="https://example.com/icon.png（可选）" type="url" maxLength={300} hint="留空时使用 Bark 默认图标。" /></div></details>
      {feedback && <Notice kind={feedback.kind}>{feedback.message}</Notice>}
    </div><div className="settings-actions"><span>{dirty ? "有尚未保存的修改" : "修改配置后，记得保存"}</span><Button variant="ghost" isDisabled={!dirty || busy !== null} onPress={() => { setSettings({ ...saved }); setFeedback(null); }}>取消修改</Button><Button type="submit" isPending={busy === "save"} isDisabled={!dirty || busy === "test"}>保存设置</Button></div>
  </Card></form><Card className="test-card"><span className="settings-symbol"><Glyph name="send" size={22} /></span><div><h2>试着打个招呼</h2><p>{dirty ? "请先保存修改，再发送一条测试通知。" : "发送一条测试通知，确认 Barker 和你的设备已连接。"}</p></div><Button variant="outline" onPress={() => void test()} isPending={busy === "test"} isDisabled={!configured || dirty || busy === "save"}>发送测试</Button></Card>
    <div className="page-note"><Glyph name="lock" size={16} /><p>Device Key 仅用于向你配置的 Bark API 发起推送，不会暴露给浏览器。</p></div>
  </div><aside className="settings-aside"><Card className="notification-preview"><div className="section-top"><h2>通知预览</h2><span className="mini-label">示意</span></div><div className="phone-preview"><span className="phone-island" /><span className="phone-time">09:41</span><span className="phone-date">每一个值得记住的日子</span><div className="mock-notification"><div><span className="mock-bark"><Glyph name="bell" size={14} /></span><span>Bark</span><small>现在</small></div><h3>给未来的自己</h3><p>停一停，喝杯水。<br />也别忘了为今天的努力鼓掌。</p></div><span className="phone-home" /></div><p className="preview-caption">提醒名称作为标题，提醒内容作为正文。</p></Card>
    <section className="settings-help"><h2>第一次使用？</h2><ol><li><span>1</span><p>在 iPhone 上打开 Bark 应用。</p></li><li><span>2</span><p>复制设备链接，将服务地址与 Device Key 填入左侧。</p></li><li><span>3</span><p>保存设置，发送测试通知。一切就绪。</p></li></ol><a href="https://bark.day.app" target="_blank" rel="noreferrer" className="text-action">了解 Bark<Glyph name="arrow" size={15} /></a></section>
    <section className="storage-note"><Glyph name="shield" size={18} /><div><h3>数据在你手中</h3><p>任务、投递队列与配置保存在本机 SQLite 数据库。备份请使用一致性数据库快照，或停止服务后复制整个数据目录。</p><code>{initial.dataDir}/barker.sqlite</code></div></section>
  </aside></div>;
}
