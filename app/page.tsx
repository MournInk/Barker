"use client";

import { Bell, Clock3, Inbox, ListTodo, Plus, RefreshCw, Settings2, Timer } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Gate } from "@/components/gate";
import { Shell } from "@/components/nav";
import type { BarkSettings, Task } from "@/lib/types";
import { api, formatTime } from "@/lib/ui";

type Overview = {
  tasks: Task[];
  settings: Omit<BarkSettings, "deviceKey">;
  deviceKeyConfigured: boolean;
  deliveries: { pending: number; retrying: number; nextRetryAt: string | null };
  retryQueue: Array<{ taskId: string; taskName: string; occurrenceAt: string; attempts: number; lastError: string | null; nextAttemptAt: string }>;
};

export default function OverviewPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const session = await api<{ authenticated: boolean }>("/api/session");
    setAuthed(session.authenticated);
    if (!session.authenticated) { setOverview(null); return; }
    const data = await api<Overview>("/api/overview");
    setOverview(data);
  }, []);

  useEffect(() => { void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "无法加载")); }, [load]);
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => { void load().catch(() => undefined); }, 5_000);
    return () => clearInterval(t);
  }, [authed, load]);

  if (authed === null) return <div className="gate"><p className="muted">正在确认访问权限…</p></div>;
  if (!authed) return <Gate onAuthed={() => void load()} />;

  const tasks = overview?.tasks ?? [];
  const active = tasks.filter((t) => t.status === "active").length;
  const paused = tasks.filter((t) => t.status === "paused").length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const nextTask = [...tasks].filter((t) => t.nextRunAt).sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""))[0] ?? null;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>概览</h1>
          <p>北京时间调度 · 每条到期提醒落库为 delivery，失败按指数退避无限重试。</p>
        </div>
        <div className="cluster">
          <Link className="button" href="/tasks"><Plus size={16} /> 新建任务</Link>
          <button className="ghost icon-button" aria-label="刷新" title="刷新" onClick={() => void load()}><RefreshCw size={16} /></button>
        </div>
      </div>

      {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <span className="stat__label">待推送</span>
          <strong className="stat__value">{overview?.deliveries.pending ?? 0}</strong>
          <span className="stat__hint"><Inbox size={12} style={{ verticalAlign: -2 }} /> 队列中</span>
        </div>
        <div className="stat">
          <span className="stat__label">重试中</span>
          <strong className="stat__value">{overview?.deliveries.retrying ?? 0}</strong>
          <span className="stat__hint">指数退避 5s → 1h</span>
        </div>
        <div className="stat">
          <span className="stat__label">下次重试</span>
          <strong className="stat__value" style={{ fontSize: 16 }}>{formatTime(overview?.deliveries.nextRetryAt ?? null)}</strong>
          <span className="stat__hint"><Timer size={12} style={{ verticalAlign: -2 }} /> 最近的 delivery</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <p className="eyebrow">任务</p>
          <p style={{ fontSize: 22, fontWeight: 860, marginTop: 6 }}>{tasks.length} <span style={{ fontSize: 12, color: "var(--muted)" }}>总数</span></p>
          <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span className="badge active" style={{ padding: "2px 7px" }}>{active} 运行中</span></span>
            <span>{paused} 已暂停 · {completed} 已完成</span>
          </p>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <p className="eyebrow">最近一次执行</p>
          <p style={{ fontSize: 14, fontWeight: 750, marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
            <Clock3 size={16} /> {nextTask ? nextTask.name : "—"}
          </p>
          <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>下次 {formatTime(nextTask?.nextRunAt ?? null)} · {nextTask ? nextTask.cron : "暂无任务"}</p>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <p className="eyebrow">Bark</p>
          <p style={{ fontSize: 14, fontWeight: 750, marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
            <Bell size={16} /> {overview?.deviceKeyConfigured ? "已配置" : "未配置"} · {overview?.settings.group ?? "—"}
          </p>
          <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 6, overflowWrap: "anywhere" }}>{overview?.settings.endpoint ?? "—"}</p>
          <Link href="/settings" className="ghost" style={{ marginTop: 10, display: "inline-flex" }}><Settings2 size={14} /> 去配置</Link>
        </div>
      </div>

      <div className="cluster" style={{ marginBottom: 10 }}>
        <h2 style={{ fontSize: 15 }}><ListTodo size={16} style={{ verticalAlign: -2 }} /> 最近任务</h2>
        <Link href="/tasks" className="ghost" style={{ marginLeft: "auto", minHeight: 32, padding: "6px 10px", fontSize: 12 }}>查看全部</Link>
      </div>

      {!tasks.length ? (
        <div className="empty">还没有任务。去 <Link href="/tasks" style={{ textDecoration: "underline", color: "var(--accent)" }}>任务</Link> 新建一个吧。</div>
      ) : (
        <div className="tasks">
          {tasks.slice(0, 6).map((t) => (
            <article key={t.id} className="task" style={{ padding: 16 }}>
              <div className="task__head">
                <h2 style={{ fontSize: 14 }}>{t.name}</h2>
                <span className={`badge ${t.status}`}>{t.status === "active" ? "运行中" : t.status === "paused" ? "已暂停" : "已完成"}</span>
              </div>
              <p className="meta" style={{ fontSize: 12 }}><code>{t.cron}</code><span>下次 {formatTime(t.nextRunAt)}</span></p>
            </article>
          ))}
        </div>
      )}

      {!!overview?.retryQueue.length && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>重试队列</h2>
          <div className="stack" style={{ gap: 8 }}>
            {overview.retryQueue.map((item) => (
              <p key={`${item.taskId}-${item.occurrenceAt}`} className="muted" style={{ fontSize: 12 }}>
                {item.taskName} · 第 {item.attempts} 次失败 · {item.lastError ?? "—"} · 下次 {formatTime(item.nextAttemptAt)}
              </p>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}
