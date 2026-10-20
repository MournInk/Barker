"use client";

import { Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Gate } from "@/components/gate";
import { Shell } from "@/components/nav";
import { Pagination } from "@/components/pagination";
import { TaskCard } from "@/components/task-card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { presetCron } from "@/lib/cron";
import type { RecurrencePreset, Task, TaskStatus } from "@/lib/types";
import { api, localDateValue, localInputValue, toOffsetDateTime } from "@/lib/ui";

type LimitMode = "count" | "date";
const PRESETS: Array<{ value: RecurrencePreset; label: string }> = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "custom", label: "自定义" },
];

const PAGE_SIZE = 8;

type TaskPageData = { authenticated: boolean; tasks: Task[]; total: number };

export default function TasksPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [status, setStatus] = useState<"" | TaskStatus>("");
  const [editing, setEditing] = useState<Task | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<RecurrencePreset>("daily");
  const [startsAt, setStartsAt] = useState(localInputValue());
  const [cron, setCron] = useState("0 9 * * *");
  const [limitMode, setLimitMode] = useState<LimitMode>("count");
  const [repeatCount, setRepeatCount] = useState("30");
  // Filled with the default (tomorrow in Asia/Shanghai) when 截止日期 mode is picked, so no impure date is computed during render.
  const [endDate, setEndDate] = useState("");

  const generatedCron = useMemo(() => {
    if (preset === "custom") return cron;
    return presetCron(preset, new Date(toOffsetDateTime(startsAt)));
  }, [cron, preset, startsAt]);

  const fetchCurrent = useCallback(async (): Promise<TaskPageData> => {
    const session = await api<{ authenticated: boolean }>("/api/session");
    if (!session.authenticated) return { authenticated: false, tasks: [], total: 0 };
    const url = new URL("/api/tasks", window.location.origin);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (status) url.searchParams.set("status", status);
    if (q.trim()) url.searchParams.set("q", q.trim());
    const data = await api<{ tasks: Task[]; total: number; page: number; pageSize: number }>(`${url.pathname}${url.search}`);
    return { authenticated: true, tasks: data.tasks, total: data.total };
  }, [page, q, status]);

  const apply = useCallback((data: TaskPageData) => {
    setAuthed(data.authenticated);
    setTasks(data.tasks);
    setTotal(data.total);
  }, []);

  const load = useCallback(async () => { apply(await fetchCurrent()); }, [apply, fetchCurrent]);

  useEffect(() => {
    let alive = true;
    void fetchCurrent().then(
      (data) => { if (alive) apply(data); },
      (err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "无法加载"); },
    );
    return () => { alive = false; };
  }, [apply, fetchCurrent]);

  useEffect(() => {
    if (!authed) return;
    let alive = true;
    const timer = setInterval(() => {
      void fetchCurrent().then((data) => { if (alive) apply(data); }, () => undefined);
    }, 5_000);
    return () => { alive = false; clearInterval(timer); };
  }, [apply, authed, fetchCurrent]);

  function resetForm() {
    setPreset("daily");
    setStartsAt(localInputValue());
    setCron("0 9 * * *");
    setLimitMode("count");
    setRepeatCount("30");
    setEndDate("");
  }

  function startCreate() {
    setEditing(null);
    setError("");
    resetForm();
    setDialogOpen(true);
  }

  function beginEdit(task: Task) {
    setEditing(task);
    setError("");
    setPreset(task.preset);
    setStartsAt(localInputValue(new Date(task.startsAt)));
    setCron(task.cron);
    setLimitMode(task.repeatCount ? "count" : "date");
    setRepeatCount(String(task.repeatCount ?? 30));
    setEndDate(task.endDate ?? localDateValue());
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditing(null);
    resetForm();
  }

  function applySearch() {
    setQ(qInput);
    setPage(1);
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
    const wasEditing = editing !== null;
    setBusy(true); setError(""); setMessage("");
    try {
      await api(editing ? `/api/tasks/${editing.id}` : "/api/tasks", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      setEditing(null);
      formEl.reset();
      // restore controlled defaults after reset
      resetForm();
      setMessage(wasEditing ? "任务已更新" : "任务已创建");
      setDialogOpen(false);
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

  if (authed === null) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4">
        <p className="text-sm text-muted-foreground">正在确认访问权限…</p>
      </div>
    );
  }
  if (!authed) return <Gate onAuthed={() => void load()} />;

  return (
    <Shell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">任务</h1>
            <p className="text-sm text-muted-foreground">
              每页 {PAGE_SIZE} 条 · 按状态与关键词筛选 · Asia/Shanghai
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="刷新" title="刷新" onClick={() => void load()}>
              <RefreshCw />
            </Button>
            <Button onClick={startCreate}>
              <Plus />
              新建任务
            </Button>
          </div>
        </div>

        {message && <Alert className="px-3 py-2">{message}</Alert>}
        {error && !dialogOpen && (
          <Alert variant="destructive" className="px-3 py-2">
            {error}
          </Alert>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Input
              placeholder="搜索名称 / 解释"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applySearch();
                }
              }}
              className="w-full sm:w-64"
            />
            <Button variant="outline" type="button" onClick={applySearch}>
              <Search />
              搜索
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <Select
              value={status || "all"}
              onValueChange={(value) => {
                setStatus(value === "all" ? "" : (value as TaskStatus));
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[140px]" aria-label="状态筛选">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">运行中</SelectItem>
                <SelectItem value="paused">已暂停</SelectItem>
                <SelectItem value="completed">已完成</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">共 {total} 条</span>
          </div>
        </div>

        {tasks.length > 0 ? (
          <Card className="divide-y divide-border overflow-hidden">
            {tasks.map((t) => (
              <TaskCard key={t.id} task={t} onEdit={beginEdit} onToggle={toggleStatus} onDelete={removeTask} />
            ))}
          </Card>
        ) : (
          <Card className="flex flex-col items-center gap-3 px-5 py-10 text-center">
            <p className="text-sm text-muted-foreground">没有匹配的任务。试试调整筛选或新建一个。</p>
            <Button type="button" onClick={startCreate}>
              <Plus /> 新建任务
            </Button>
          </Card>
        )}

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />

        <Dialog
          open={dialogOpen}
          onOpenChange={(next) => {
            if (next) setDialogOpen(true);
            else closeDialog();
          }}
        >
          <DialogContent>
            <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editing ? "编辑任务" : "新建任务"}</DialogTitle>
              <DialogDescription>预设按开始时间的墙钟时分生成 cron；自定义请输入标准五段格式。</DialogDescription>
            </DialogHeader>
            <form onSubmit={saveTask} className="grid gap-4">
              {error && (
                <Alert variant="destructive" className="px-3 py-2">
                  {error}
                </Alert>
              )}
              <div className="grid gap-2">
                <Label htmlFor="task-name">名称</Label>
                <Input
                  id="task-name"
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={editing?.name ?? ""}
                  key={editing?.id ?? "new"}
                  placeholder="如：喝水 / 站立提醒"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="task-description">解释</Label>
                <Textarea
                  id="task-description"
                  name="description"
                  maxLength={500}
                  rows={3}
                  defaultValue={editing?.description ?? ""}
                  key={`${editing?.id ?? "new"}-desc`}
                  placeholder="推送正文，可空"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="task-starts-at">开始时间</Label>
                <Input
                  id="task-starts-at"
                  type="datetime-local"
                  required
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label>周期</Label>
                <Select value={preset} onValueChange={(value) => setPreset(value as RecurrencePreset)}>
                  <SelectTrigger aria-label="周期预设">
                    <SelectValue placeholder="每天" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESETS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="task-cron">Cron</Label>
                <Input
                  id="task-cron"
                  className={preset === "custom" ? "font-mono" : "cursor-default bg-muted/50 font-mono text-muted-foreground"}
                  value={preset === "custom" ? cron : generatedCron}
                  readOnly={preset !== "custom"}
                  required={preset === "custom"}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="如：0 9 * * *"
                />
                {preset !== "custom" && (
                  <p className="text-xs text-muted-foreground">由「开始时间」与周期自动生成；选择“自定义”可手动编辑。</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label>结束条件</Label>
                <Select
                  value={limitMode}
                  onValueChange={(value) => {
                    const mode = value as LimitMode;
                    setLimitMode(mode);
                    if (mode === "date") setEndDate((cur) => cur || localDateValue(new Date(Date.now() + 86_400_000)));
                  }}
                >
                  <SelectTrigger aria-label="结束条件">
                    <SelectValue placeholder="重复次数" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">重复次数</SelectItem>
                    <SelectItem value="date">截止日期</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {limitMode === "count" ? (
                <div className="grid gap-2">
                  <Label htmlFor="task-repeat-count">次数</Label>
                  <Input
                    id="task-repeat-count"
                    type="number"
                    min={1}
                    required
                    value={repeatCount}
                    onChange={(e) => setRepeatCount(e.target.value)}
                  />
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="task-end-date">截止日期</Label>
                  <Input
                    id="task-end-date"
                    type="date"
                    required
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              )}
              <DialogFooter className="sticky -bottom-6 -mx-6 -mb-6 mt-2 border-t bg-background px-6 py-3">
                <Button type="button" variant="outline" onClick={closeDialog}>
                  取消
                </Button>
                <Button type="submit" disabled={busy}>
                  保存
                </Button>
              </DialogFooter>
            </form>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </Shell>
  );
}
