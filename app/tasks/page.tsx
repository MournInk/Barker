"use client";

import { Clock3, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Gate } from "@/components/gate";
import { Shell } from "@/components/nav";
import { Pagination } from "@/components/pagination";
import { TaskCard } from "@/components/task-card";
import { presetCron } from "@/lib/cron";
import type { RecurrencePreset, Task, TaskStatus } from "@/lib/types";
import { api, formatTime, localInputValue, toOffsetDateTime } from "@/lib/ui";

type LimitMode = "count" | "date";
const PRESETS: Array<{ value: RecurrencePreset; label: string }> = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "custom", label: "自定义" },
];

const PAGE_SIZE = 8;

export default function TasksPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [status, setStatus] = useState<"" | TaskStatus>("");
  const [editing, setEditing] = useState<Task | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<RecurrencePreset>("daily");
  const [startsAt, setStartsAt] = useState(localInputValue());
  const [cron, setCron] = useState("0 9 * * *");
  const [limitMode, setLimitMode] = useState<LimitMode>("count");
  const [repeatCount, setRepeatCount] = useState("30");
  const [endDate, setEndDate] = useState(localInputValue(new Date(Date.now() + 86_400_000)).slice(0, 10));
  const formRef = useRef<HTMLFormElement>(null);

  const generatedCron = useMemo(() => {
    if (preset === "custom") return cron;
    return presetCron(preset, new Date(`${startsAt}:00+08:00`));
  }, [cron, preset, startsAt]);

  const load = useCallback(async () => {
    const session = await api<{ authenticated: boolean }>("/api/session");
    setAuthed(session.authenticated);
    if (!session.authenticated) return;
    const url = new URL("/api/tasks", window.location.origin);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (status) url.searchParams.set("status", status);
    if (q.trim()) url.searchParams.set("q", q.trim());
    const data = await api<{ tasks: Task[]; total: number; page: number; pageSize: number }>(`${url.pathname}${url.search}`);
    setTasks(data.tasks);
    setTotal(data.total);
  }, [page, q, status]);

  useEffect(() => { void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "无法加载")); }, [load]);
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => { void load().catch(() => undefined); }, 5_000);
    return () => clearInterval(t);
  }, [authed, load]);

  function beginEdit(task: Task) {
    setEditing(task);
    setPreset(task.preset);
    setStartsAt(localInputValue(new Date(task.startsAt)));
    setCron(task.cron);
    setLimitMode(task.repeatCount ? "count" : "date");
    setRepeatCount(String(task.repeatCount ?? 30));
    setEndDate(task.endDate ?? localInputValue().slice(0, 10));
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function saveTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
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
      await api(editing ? `/api/tasks/${editing.id}` : "/api/tasks", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      setEditing(null);
      formEl.reset();
      // restore controlled defaults after reset
      setPreset("daily");
      setStartsAt(localInputValue());
      setCron("0 9 * * *");
      setLimitMode("count");
      setRepeatCount("30");
      setMessage(editing ? "任务已更新" : "任务已创建");
      setPage(1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally { setBusy(false); }
  }

  async function toggleStatus(task: Task) {
    setError("");
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: task.status === "paused" ? "active" : "paused" }) });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "状态更新失败"); }
  }

  async function removeTask(task: Task) {
    if (!window.confirm(`删除「${task.name}」？待发送的提醒必须先推送成功。`)) return;
    try { await api(`/api/tasks/${task.id}`, { method: "DELETE" }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "删除失败"); }
  }

  if (authed === null) return <div className="gate"><p className="muted">正在确认访问权限…</p></div>;
  if (!authed) return <Gate onAuthed={() => void load()} />;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Tasks</p>
          <h1>任务</h1>
          <p>每页 {PAGE_SIZE} 条，支持按状态与关键词筛选。下次时间按 Asia/Shanghai 显示。</p>
        </div>
        <div className="cluster">
          <button className="ghost icon-button" aria-label="刷新" title="刷新" onClick={() => void load()}><RefreshCw size={16} /></button>
        </div>
      </div>

      {message && <p className="notice" style={{ marginBottom: 12 }}>{message}</p>}
      {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="grid">
        <section className="stack">
          <form ref={formRef} className="card stack" onSubmit={saveTask}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 32, height: 32, display: "grid", placeItems: "center", borderRadius: 10, background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid #cfe9dd" }}>
                <Clock3 size={16} />
              </span>
              <h2 style={{ fontSize: 15 }}>{editing ? "编辑任务" : "新建任务"}</h2>
              {editing && <span className="badge completed" style={{ marginLeft: "auto" }}>{formatTime(editing.nextRunAt)}</span>}
            </div>

            <label>名称<input name="name" required maxLength={80} defaultValue={editing?.name ?? ""} key={editing?.id ?? "new"} placeholder="如：喝水 / 站立提醒" /></label>
            <label>解释<textarea name="description" maxLength={500} defaultValue={editing?.description ?? ""} key={`${editing?.id ?? "new"}-desc`} placeholder="推送正文，可空" /></label>
            <label>开始时间<input type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label>

            <div className="choice" role="group" aria-label="周期预设">
              {PRESETS.map((item) => (
                <button key={item.value} type="button" className={preset === item.value ? "selected" : ""} aria-pressed={preset === item.value} onClick={() => setPreset(item.value)}>
                  {item.label}
                </button>
              ))}
            </div>
            <label>
              Cron
              {preset === "custom" ? <input value={cron} onChange={(e) => setCron(e.target.value)} required placeholder="如：0 9 * * *" /> : <input value={generatedCron} readOnly />}
            </label>

            <div className="choice" role="group" aria-label="结束条件">
              <button type="button" className={limitMode === "count" ? "selected" : ""} aria-pressed={limitMode === "count"} onClick={() => setLimitMode("count")}>重复次数</button>
              <button type="button" className={limitMode === "date" ? "selected" : ""} aria-pressed={limitMode === "date"} onClick={() => setLimitMode("date")}>截止日期</button>
            </div>
            {limitMode === "count" ? (
              <label>次数<input type="number" min={1} value={repeatCount} onChange={(e) => setRepeatCount(e.target.value)} required /></label>
            ) : (
              <label>截止日期<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required /></label>
            )}

            <div className="cluster">
              <button className="button" disabled={busy}><Plus size={16} />{editing ? "保存修改" : "添加任务"}</button>
              {editing && <button type="button" className="ghost" onClick={() => setEditing(null)}>取消编辑</button>}
            </div>
            <p className="helper">预设按开始时间的墙钟时分生成 cron；自定义请输入标准五段格式。</p>
          </form>
        </section>

        <section style={{ minWidth: 0, display: "grid", gap: 12 }}>
          <div className="toolbar">
            <div className="toolbar__grow" style={{ display: "flex", gap: 8 }}>
              <input placeholder="搜索名称 / 解释" value={qInput} onChange={(e) => setQInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setQ(qInput); setPage(1); } }} />
              <button className="ghost" onClick={() => { setQ(qInput); setPage(1); }}><Search size={16} /></button>
            </div>
            <select value={status} onChange={(e) => { setStatus(e.target.value as never); setPage(1); }} style={{ minWidth: 140 }}>
              <option value="">全部状态</option>
              <option value="active">运行中</option>
              <option value="paused">已暂停</option>
              <option value="completed">已完成</option>
            </select>
            <span className="chip" style={{ background: "#0a7a6312", color: "#0a7a63", borderColor: "#0a7a6320" }}>共 {total} 条</span>
          </div>

          {!tasks.length ? (
            <div className="empty">没有匹配的任务。试试调整筛选或新建一个。</div>
          ) : (
            <div className="tasks">
              {tasks.map((t) => (
                <TaskCard key={t.id} task={t} onEdit={beginEdit} onToggle={toggleStatus} onDelete={removeTask} />
              ))}
            </div>
          )}

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </section>
      </div>
    </Shell>
  );
}
