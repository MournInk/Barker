"use client";

import { ArrowRight, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Gate } from "@/components/gate";
import { Shell } from "@/components/nav";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { BarkSettings, Task } from "@/lib/types";
import { api, formatTime } from "@/lib/ui";

type Overview = {
  tasks: Task[];
  settings: Omit<BarkSettings, "deviceKey">;
  deviceKeyConfigured: boolean;
  deliveries: { pending: number; retrying: number; nextRetryAt: string | null };
  retryQueue: Array<{ taskId: string; taskName: string; occurrenceAt: string; attempts: number; lastError: string | null; nextAttemptAt: string }>;
};

type OverviewData = { authenticated: boolean; overview: Overview | null };

async function fetchOverview(): Promise<OverviewData> {
  const session = await api<{ authenticated: boolean }>("/api/session");
  if (!session.authenticated) return { authenticated: false, overview: null };
  return { authenticated: true, overview: await api<Overview>("/api/overview") };
}

const statusMeta: Record<Task["status"], { label: string; variant: "success" | "warning" | "secondary" }> = {
  active: { label: "运行中", variant: "success" },
  paused: { label: "已暂停", variant: "warning" },
  completed: { label: "已完成", variant: "secondary" },
};

export default function OverviewPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  const apply = useCallback((page: OverviewData) => {
    setAuthed(page.authenticated);
    setOverview(page.overview);
  }, []);

  const load = useCallback(async () => { apply(await fetchOverview()); }, [apply]);

  useEffect(() => {
    let alive = true;
    void fetchOverview().then(
      (page) => { if (alive) apply(page); },
      (err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "无法加载"); },
    );
    return () => { alive = false; };
  }, [apply]);

  useEffect(() => {
    if (!authed) return;
    let alive = true;
    const timer = setInterval(() => {
      void fetchOverview().then(
        (page) => { if (alive) apply(page); },
        () => undefined,
      );
    }, 5_000);
    return () => { alive = false; clearInterval(timer); };
  }, [apply, authed]);

  if (authed === null) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4">
        <p className="text-sm text-muted-foreground">正在确认访问权限…</p>
      </div>
    );
  }
  if (!authed) return <Gate onAuthed={() => void load()} />;

  const tasks = overview?.tasks ?? [];
  const active = tasks.filter((t) => t.status === "active").length;
  const paused = tasks.filter((t) => t.status === "paused").length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const retryQueue = overview?.retryQueue ?? [];

  return (
    <Shell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">概览</h1>
              <Badge variant={overview?.deviceKeyConfigured ? "success" : "secondary"}>
                {overview?.deviceKeyConfigured ? "Bark 已配置" : "Bark 未配置"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              北京时间调度 · 每条到期提醒落库为 delivery，失败按指数退避无限重试。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="刷新" title="刷新" onClick={() => void load()}>
              <RefreshCw />
            </Button>
            <Button asChild>
              <Link href="/tasks">
                <Plus /> 新建任务
              </Link>
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>加载失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card className="grid grid-cols-3 divide-x divide-border">
          <div className="p-4 sm:p-5">
            <p className="text-xs font-medium text-muted-foreground">待推送</p>
            <p className="mt-2 text-lg font-semibold tabular-nums leading-tight sm:text-2xl">{overview?.deliveries.pending ?? 0}</p>
            <p className="mt-1 hidden text-xs text-muted-foreground sm:block">队列中</p>
          </div>
          <div className="p-4 sm:p-5">
            <p className="text-xs font-medium text-muted-foreground">重试中</p>
            <p className="mt-2 text-lg font-semibold tabular-nums leading-tight sm:text-2xl">{overview?.deliveries.retrying ?? 0}</p>
            <p className="mt-1 hidden text-xs text-muted-foreground sm:block">5s → 1h 指数退避</p>
          </div>
          <div className="p-4 sm:p-5">
            <p className="text-xs font-medium text-muted-foreground">下次重试</p>
            <p className="mt-2 text-sm font-semibold tabular-nums leading-snug break-words sm:text-2xl">
              {formatTime(overview?.deliveries.nextRetryAt ?? null)}
            </p>
            <p className="mt-1 hidden text-xs text-muted-foreground sm:block">最近的 delivery</p>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-sm font-medium">最近任务</CardTitle>
              <Link
                href="/tasks"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                查看全部
              </Link>
            </div>
            <CardDescription className="text-xs">
              共 {tasks.length} 条 · 运行中 {active} · 已暂停 {paused} · 已完成 {completed}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tasks.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                还没有任务。去{" "}
                <Link href="/tasks" className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80">
                  任务
                </Link>{" "}
                新建一个吧。
              </p>
            ) : (
              <div className="divide-y divide-border">
                {tasks.slice(0, 6).map((task) => {
                  const status = statusMeta[task.status];
                  return (
                    <div key={task.id} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0 space-y-1">
                        <p className="truncate text-sm font-medium">{task.name}</p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <Badge variant={status.variant}>{status.label}</Badge>
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{task.cron}</code>
                          <span aria-hidden className="text-muted-foreground/40">·</span>
                          <span>下次 {formatTime(task.nextRunAt)}</span>
                        </div>
                      </div>
                      <Link
                        href="/tasks"
                        aria-label={`管理任务 ${task.name}`}
                        className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ArrowRight className="size-4" />
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {retryQueue.length > 0 && (
          <Alert>
            <AlertTitle>重试队列</AlertTitle>
            <AlertDescription>
              <ul className="mt-2 space-y-1">
                {retryQueue.map((item) => (
                  <li key={`${item.taskId}-${item.occurrenceAt}`} className="text-xs leading-5">
                    {item.taskName} · 第 {item.attempts} 次失败 · {item.lastError ?? "—"} · 下次{" "}
                    {formatTime(item.nextAttemptAt)}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </div>
    </Shell>
  );
}
