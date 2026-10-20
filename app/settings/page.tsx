"use client";

import { Check, Send, Shield } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Gate } from "@/components/gate";
import { Shell } from "@/components/nav";
import type { BarkSettings } from "@/lib/types";
import { api } from "@/lib/ui";

type SettingsPayload = {
  settings: Omit<BarkSettings, "deviceKey">;
  deviceKeyConfigured: boolean;
  dataDir: string;
};

type SettingsPageData = { authenticated: boolean; payload: SettingsPayload | null };

async function fetchSettingsPage(): Promise<SettingsPageData> {
  const session = await api<{ authenticated: boolean }>("/api/session");
  if (!session.authenticated) return { authenticated: false, payload: null };
  return { authenticated: true, payload: await api<SettingsPayload>("/api/settings") };
}

export default function SettingsPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<BarkSettings>({
    endpoint: "https://api.day.app",
    deviceKey: "",
    title: "Barker 提醒",
    sound: "1107",
    group: "Barker",
    icon: "",
  });
  const [configured, setConfigured] = useState(false);
  const [dataDir, setDataDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const apply = useCallback((page: SettingsPageData) => {
    const payload = page.payload;
    setAuthed(page.authenticated);
    if (!payload) return;
    setSettings((cur) => ({ ...cur, ...payload.settings, deviceKey: "" }));
    setConfigured(payload.deviceKeyConfigured);
    setDataDir(payload.dataDir);
  }, []);

  const load = useCallback(async () => { apply(await fetchSettingsPage()); }, [apply]);

  useEffect(() => {
    let alive = true;
    void fetchSettingsPage().then(
      (page) => { if (alive) apply(page); },
      (err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "无法加载"); },
    );
    return () => { alive = false; };
  }, [apply]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSettings((cur) => ({ ...cur, deviceKey: "" }));
      setMessage("Bark 配置已保存");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setError(""); setMessage("");
    try { await api("/api/settings/test", { method: "POST", body: "{}" }); setMessage("测试推送已发出，请查看 Bark"); }
    catch (err) { setError(err instanceof Error ? err.message : "测试失败"); }
    finally { setBusy(false); }
  }

  if (authed === null) return <div className="gate"><p className="muted">正在确认访问权限…</p></div>;
  if (!authed) return <Gate onAuthed={() => void load()} />;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>设置</h1>
          <p>配置自建 Bark API。Device Key 留空表示保持不变。</p>
        </div>
        <span className="chip" style={{ background: configured ? "#e3f4ed" : "#fff0df", color: configured ? "#0a7a63" : "#a85a10", borderColor: configured ? "#cce9dd" : "#ffe0b8" }}>
          {configured ? <><Check size={12} /> Device Key 已保存</> : "尚未配置 Device Key"}
        </span>
      </div>

      {message && <p className="notice" style={{ marginBottom: 12 }}>{message}</p>}
      {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(280px, 0.6fr)", gap: 16, alignItems: "start" }}>
        <form className="card stack" onSubmit={save}>
          <h2 style={{ fontSize: 15, display: "flex", gap: 8, alignItems: "center" }}><Shield size={16} /> Bark</h2>
          <label>API 地址<input value={settings.endpoint} onChange={(e) => setSettings({ ...settings, endpoint: e.target.value })} required placeholder="https://api.day.app" /></label>
          <label>
            Device Key
            <input type="password" value={settings.deviceKey} placeholder={configured ? "••••••••（留空保持不变）" : "粘贴 Bark Device Key"} onChange={(e) => setSettings({ ...settings, deviceKey: e.target.value })} />
          </label>
          <div className="split">
            <label>默认标题<input value={settings.title} onChange={(e) => setSettings({ ...settings, title: e.target.value })} required /></label>
            <label>提示音<input value={settings.sound} onChange={(e) => setSettings({ ...settings, sound: e.target.value })} placeholder="如：1107" /></label>
          </div>
          <div className="split">
            <label>分组<input value={settings.group} onChange={(e) => setSettings({ ...settings, group: e.target.value })} placeholder="Barker" /></label>
            <label>图标 URL<input value={settings.icon} onChange={(e) => setSettings({ ...settings, icon: e.target.value })} placeholder="https://…（可空）" /></label>
          </div>
          <div className="cluster">
            <button className="button" disabled={busy}><Check size={16} /> 保存配置</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void test()}><Send size={16} /> 发送测试</button>
          </div>
          <p className="helper">保存后可点“发送测试”验证推送链路是否通畅。</p>
        </form>

        <div className="stack">
          <div className="card" style={{ padding: 16 }}>
            <p className="eyebrow">安全</p>
            <h3 style={{ fontSize: 14, marginTop: 6 }}>代理与会话</h3>
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
              直连公网时不要启用 <code>BARKER_TRUST_PROXY</code>，否则客户端可伪造 <code>X-Forwarded-*</code> 绕过限流。
              会话为 <code>HttpOnly + SameSite=Lax</code>，有效期 12 小时。
            </p>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <p className="eyebrow">数据</p>
            <h3 style={{ fontSize: 14, marginTop: 6 }}>持久化</h3>
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
              任务与推送队列持久化于 <code>{dataDir ? `${dataDir.replace(/\/+$/, "")}/barker.sqlite` : "—"}</code>（WAL）。
              备份时一并拷贝 <code>.sqlite-wal/.sqlite-shm</code>。
            </p>
          </div>
        </div>
      </div>
    </Shell>
  );
}
