"use client";

import { Bell, LogOut, Pause, Pencil, Play, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { presetCron } from "@/lib/cron";
import type { BarkSettings, RecurrencePreset, Task, TaskStatus } from "@/lib/types";

type LimitMode = "count" | "date";
type Overview = {
  tasks: Task[];
  settings: Omit<BarkSettings, "deviceKey">;
  deviceKeyConfigured: boolean;
  deliveries: { pending: number; retrying: number; nextRetryAt: string | null };
  retryQueue: Array<{ taskId: string; taskName: string; occurrenceAt: string; attempts: number; lastError: string | null; nextAttemptAt: string }>;
};

const PRESETS: Array<{ value: RecurrencePreset; label: string }> = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "custom", label: "自定义" },
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  active: "运行中", paused: "已暂停", completed: "已完成",
};

function localInputValue(date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

function toOffsetDateTime(value: string): string {
  return `${value}:00+08:00`;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const withYear = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric" });
  const targetYear = withYear.format(new Date(value));
  const currentYear = withYear.format(new Date());
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(targetYear !== currentYear ? { year: "numeric" as const } : {}),
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

export default function HomePage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const settingsLoaded = useRef(false);
  const [preset, setPreset] = useState<RecurrencePreset>("daily");
  const [startsAt, setStartsAt] = useState(localInputValue());
  const [cron, setCron] = useState("0 9 * * *");
  const [limitMode, setLimitMode] = useState<LimitMode>("count");
  const [repeatCount, setRepeatCount] = useState("30");
  const [endDate, setEndDate] = useState(localInputValue(new Date(Date.now() + 86_400_000)).slice(0, 10));
  const [settings, setSettings] = useState({ endpoint: "https://api.day.app", deviceKey: "", title: "Barker 提醒", sound: "1107", group: "Barker", icon: "" });

  const generatedCron = useMemo(() => {
    if (preset === "custom") return cron;
    return presetCron(preset, new Date(`${startsAt}:00+08:00`));
  }, [cron, preset, startsAt]);

  const load = useCallback(async () => {
    const session = await api<{ authenticated: boolean }>("/api/session");
    setAuthenticated(session.authenticated);
    if (!session.authenticated) {
      setOverview(null);
      settingsLoaded.current = false;
      return;
    }
    const data = await api<Overview>("/api/overview");
    setOverview(data);
    if (!settingsLoaded.current) {
      setSettings((current) => ({ ...current, ...data.settings, deviceKey: "" }));
      settingsLoaded.current = true;
    }
  }, []);

  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法加载")); }, [load]);

  // Keep the board in sync with the server-side scheduler (retries, counts, next runs).
  useEffect(() => {
    if (!authenticated) return;
    const timer = setInterval(() => { void load().catch(() => undefined); }, 5_000);
    return () => clearInterval(timer);
  }, [authenticated, load]);

  function beginEdit(task: Task) {
    setEditing(task);
    setPreset(task.preset);
    setStartsAt(localInputValue(new Date(task.startsAt)));
    setCron(task.cron);
    setLimitMode(task.repeatCount ? "count" : "date");
    setRepeatCount(String(task.repeatCount ?? 30));
    setEndDate(task.endDate ?? localInputValue().slice(0, 10));
    document.getElementById("task-form")?.scrollIntoView({ behavior: "smooth" });
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/session", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally { setBusy(false); }
  }

  async function saveTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      name: String(form.get("name") || ""),
      description: String(form.get("description") || ""),
      startsAt: toOffsetDateTime(startsAt),
      preset,
      cron: generatedCron,
      repeatCount: limitMode === "count" ? Number(repeatCount) : null,
      endDate: limitMode === "date" ? endDate : null,
    };
    setBusy(true); setError(""); setMessage("");
    try {
      await api(editing ? `/api/tasks/${editing.id}` : "/api/tasks", {
        method: editing ? "PUT" : "POST", body: JSON.stringify(payload),
      });
      setEditing(null);
      formElement.reset();
      setMessage(editing ? "任务已更新" : "任务已创建");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally { setBusy(false); }
  }

  async function changeStatus(task: Task) {
    setError("");
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: task.status === "paused" ? "active" : "paused" }) });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "状态更新失败");
    }
  }

  async function removeTask(task: Task) {
    if (!window.confirm(`删除「${task.name}」？待发送的提醒必须先推送成功。`)) return;
    try { await api(`/api/tasks/${task.id}`, { method: "DELETE" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSettings((current) => ({ ...current, deviceKey: "" }));
      setMessage("Bark 配置已保存");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function testBark() {
    setBusy(true); setError(""); setMessage("");
    try { await api("/api/settings/test", { method: "POST", body: "{}" }); setMessage("测试推送已发出"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "测试失败"); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setError("");
    try {
      await api("/api/session", { method: "DELETE" });
      setAuthenticated(false);
      setOverview(null);
      settingsLoaded.current = false;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "退出失败");
    }
  }

  if (authenticated === null) return <main className="gate"><p className="muted">正在确认访问权限…</p></main>;
  if (!authenticated) {
    return (
      <main className="gate">
        <form className="card stack" onSubmit={signIn}>
          <div className="brand"><span className="mark"><Bell size={22} /></span><div><p className="eyebrow">Barker</p><h1>输入启动密码</h1></div></div>
          <label>启动日志中的访问密码<input type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <p className="error">{error}</p>}
          <button className="button" disabled={busy}>进入</button>
        </form>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand"><span className="mark"><Bell size={22} /></span><div><p className="eyebrow">北京时间</p><h1>Barker</h1></div></div>
        <button className="ghost icon-button" title="退出登录" aria-label="退出登录" onClick={() => void signOut()}><LogOut size={18} /></button>
      </header>
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}
      <div className="grid">
        <section className="editor stack">
          <form className="card stack" id="task-form" onSubmit={saveTask}>
            <h2>{editing ? "编辑任务" : "新建任务"}</h2>
            <label>名称<input name="name" required maxLength={80} defaultValue={editing?.name ?? ""} key={editing?.id ?? "new"} /></label>
            <label>解释<textarea name="description" maxLength={500} defaultValue={editing?.description ?? ""} key={`${editing?.id ?? "new"}-description`} /></label>
            <label>开始时间<input type="datetime-local" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
            <div className="choice" role="group" aria-label="周期预设">
              {PRESETS.map((item) => <button type="button" className={preset === item.value ? "selected" : ""} aria-pressed={preset === item.value} key={item.value} onClick={() => setPreset(item.value)}>{item.label}</button>)}
            </div>
            <label>Cron{preset === "custom"
              ? <input value={cron} onChange={(event) => setCron(event.target.value)} required />
              : <input value={generatedCron} readOnly />}
            </label>
            <div className="choice" role="group" aria-label="结束条件">
              <button type="button" className={limitMode === "count" ? "selected" : ""} aria-pressed={limitMode === "count"} onClick={() => setLimitMode("count")}>重复次数</button>
              <button type="button" className={limitMode === "date" ? "selected" : ""} aria-pressed={limitMode === "date"} onClick={() => setLimitMode("date")}>截止日期</button>
            </div>
            {limitMode === "count"
              ? <label>次数<input type="number" min={1} value={repeatCount} onChange={(event) => setRepeatCount(event.target.value)} required /></label>
              : <label>截止日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>}
            <div className="actions">
              <button className="button" disabled={busy}>{editing ? "保存修改" : "添加任务"}</button>
              {editing && <button type="button" className="ghost" onClick={() => setEditing(null)}>取消</button>}
            </div>
          </form>
          <form className="card stack" onSubmit={saveSettings}>
            <h2>Bark</h2>
            <p className="muted">{overview?.deviceKeyConfigured ? "Device Key 已保存。留空则保持不变。" : "尚未配置 Device Key。"}</p>
            <label>API 地址<input value={settings.endpoint} onChange={(event) => setSettings({ ...settings, endpoint: event.target.value })} required /></label>
            <label>Device Key<input type="password" value={settings.deviceKey} placeholder={overview?.deviceKeyConfigured ? "••••••••" : ""} onChange={(event) => setSettings({ ...settings, deviceKey: event.target.value })} /></label>
            <div className="split">
              <label>默认标题<input value={settings.title} onChange={(event) => setSettings({ ...settings, title: event.target.value })} required /></label>
              <label>提示音<input value={settings.sound} onChange={(event) => setSettings({ ...settings, sound: event.target.value })} /></label>
            </div>
            <div className="split">
              <label>分组<input value={settings.group} onChange={(event) => setSettings({ ...settings, group: event.target.value })} /></label>
              <label>图标 URL<input value={settings.icon} onChange={(event) => setSettings({ ...settings, icon: event.target.value })} /></label>
            </div>
            <div className="actions"><button className="button" disabled={busy}>保存配置</button><button type="button" className="ghost" disabled={busy} onClick={() => void testBark()}><Send size={16} />发送测试</button></div>
          </form>
        </section>
        <section className="task-panel">
          <div className="panel-heading row">
            <div><p className="eyebrow">任务概览</p><h2>提醒任务</h2></div>
            <div className="actions"><button className="ghost icon-button" title="刷新任务" aria-label="刷新任务" onClick={() => void load()}><RefreshCw size={17} /></button><button className="button mobile-add" onClick={() => document.getElementById("task-form")?.scrollIntoView({ behavior: "smooth" })}><Plus size={17} />新建</button></div>
          </div>
          <div className="stats">
            <div className="stat"><span className="muted">待推送</span><strong>{overview?.deliveries.pending ?? 0}</strong></div>
            <div className="stat"><span className="muted">重试中</span><strong>{overview?.deliveries.retrying ?? 0}</strong></div>
            <div className="stat"><span className="muted">下次重试</span><strong>{formatTime(overview?.deliveries.nextRetryAt ?? null)}</strong></div>
          </div>
          {overview?.tasks.map((task) => (
            <article className="task" key={task.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2>{task.name}</h2><span className={`badge ${task.status}`}>{STATUS_LABEL[task.status]}</span>
              </div>
              {task.description && <p>{task.description}</p>}
              <p className="meta muted"><span>{PRESETS.find((item) => item.value === task.preset)?.label}</span><code>{task.cron}</code><span>已发送 {task.sentCount}{task.repeatCount ? ` / ${task.repeatCount}` : ""}</span></p>
              <p className="muted">下次 {formatTime(task.nextRunAt)} · 截止 {task.endDate ?? "按次数"}{task.lastError ? ` · ${task.lastError}` : ""}</p>
              <div className="actions">
                <button className="ghost" onClick={() => beginEdit(task)} disabled={task.status === "completed"}><Pencil size={16} />编辑</button>
                {task.status !== "completed" && <button className="ghost" onClick={() => void changeStatus(task)}>{task.status === "paused" ? <Play size={16} /> : <Pause size={16} />}{task.status === "paused" ? "恢复" : "暂停"}</button>}
                <button className="danger" onClick={() => void removeTask(task)}><Trash2 size={16} />删除</button>
              </div>
            </article>
          ))}
          {!overview?.tasks.length && <p className="muted">还没有任务。</p>}
          {!!overview?.retryQueue.length && <div className="stack" style={{ marginTop: 18 }}><h2>重试队列</h2>{overview.retryQueue.map((item) => <p className="muted" key={`${item.taskId}-${item.occurrenceAt}`}>{item.taskName} · 第 {item.attempts} 次失败 · {item.lastError}</p>)}</div>}
        </section>
      </div>
    </main>
  );
}
