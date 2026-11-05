"use client";

import { Button, Card, Dropdown, Input, Label, Tabs } from "@heroui/react";
import { useEffect, useState } from "react";
import { Glyph } from "@/components/icons";
import { Confirm, Empty, IconButton, Notice, TaskBadge } from "@/components/primitives";
import { Pagination } from "@/components/pagination";
import { useResource } from "@/components/use-resource";
import { useWorkspace } from "@/components/workspace-context";
import type { Task } from "@/lib/types";
import { api, errorMessage, formatTime, PRESET_LABELS } from "@/lib/ui";

const filters = [
  { id: "all", label: "全部提醒" },
  { id: "active", label: "进行中" },
  { id: "paused", label: "已暂停" },
  { id: "completed", label: "排期结束" },
  { id: "archived", label: "已归档" },
];
const PAGE_SIZE = 10;

export default function TasksPage() {
  const { openTask, refresh: refreshDashboard, notify } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [archive, setArchive] = useState<Task | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), q: search });
  if (filter !== "all") params.set("status", filter);
  const { data, error, refresh } = useResource<{ tasks: Task[]; total: number }>(`/api/tasks?${params}`);

  function returnToPreviousPageIfEmpty() {
    if (data?.tasks.length === 1 && page > 1) setPage(page - 1);
  }

  async function toggle(task: Task) {
    setBusy(task.id);
    try {
      await api(`/api/tasks/${task.id}`, {
        method: "PATCH", body: JSON.stringify({ status: task.status === "paused" ? "active" : "paused" }),
      });
      notify(task.status === "paused" ? "提醒已恢复，暂停期间不会补发。" : "提醒已暂停，已排队的消息会继续投递。");
      if (filter !== "all") returnToPreviousPageIfEmpty();
      await Promise.all([refresh(), refreshDashboard()]);
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy("");
    }
  }

  async function archiveTask() {
    if (!archive) return;
    setBusy(archive.id);
    try {
      await api(`/api/tasks/${archive.id}`, { method: "DELETE" });
      setArchive(null);
      returnToPreviousPageIfEmpty();
      notify("提醒已归档。投递记录和待发送消息均已保留。");
      await Promise.all([refresh(), refreshDashboard()]);
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">把惦记的事，安排妥当</p>
          <h1>所有提醒<span className="heading-period">。</span></h1>
          <p>管理你的工作与日常，让重要的事按时发生。</p>
        </div>
        <Button onPress={() => openTask()}><Glyph name="plus" size={17} />新建提醒</Button>
      </div>
      <Card className="tasks-panel">
        <div className="list-toolbar">
          <Tabs selectedKey={filter} onSelectionChange={(key) => { setFilter(String(key)); setPage(1); }} variant="secondary" className="filter-tabs">
            <Tabs.ListContainer>
              <Tabs.List aria-label="提醒状态">
                {filters.map((item) => <Tabs.Tab id={item.id} key={item.id}>{item.label}<Tabs.Indicator /></Tabs.Tab>)}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          <div className="search-field">
            <Glyph name="search" size={17} />
            <Input aria-label="搜索提醒" placeholder="搜索名称或内容…" value={query} onChange={(event) => setQuery(event.target.value)} variant="secondary" maxLength={200} />
          </div>
        </div>
        {error && <Notice>{error}<Button variant="ghost" size="sm" onPress={() => void refresh()}>重试</Button></Notice>}
        {!data ? <div className="loading-state">正在整理你的提醒…</div> : !data.tasks.length ? (
          <Empty
            title={search ? "没有找到相关提醒" : filter === "all" ? "给未来的自己，一个提醒" : "这里暂时没有提醒"}
            description={search ? "试试其他关键词，或切换提醒状态。" : filter === "archived" ? "归档会停止未来排期，但始终保留消息和历史记录。" : "不必把所有事都记在心里，让 Barker 帮你分担。"}
            action={filter === "all" && !search ? <Button variant="outline" onPress={() => openTask()}>创建第一个提醒</Button> : undefined}
          />
        ) : (
          <div className="table-scroll">
            <table className="task-table">
              <thead>
                <tr><th>提醒事项</th><th>重复周期</th><th>下一次提醒</th><th>投递进度</th><th>状态</th><th><span className="sr-only">操作</span></th></tr>
              </thead>
              <tbody>
                {data.tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <div className="task-name-cell">
                        <span className={`task-symbol ${task.status === "paused" || task.status === "archived" ? "subdued" : ""}`}>
                          <Glyph name={task.status === "archived" ? "archive" : "bell"} size={19} />
                        </span>
                        <div>
                          <strong>{task.name}</strong>
                          <p>{task.description || "给重要的事，留一个准时的提醒。"}</p>
                          {task.lastError && task.pendingCount > 0 && <span className="task-error"><Glyph name="warning" size={12} />有消息等待重试</span>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="schedule-cell"><Glyph name="refresh" size={13} />{PRESET_LABELS[task.preset]}</span>
                      <code className="cron-caption">{task.cron}</code>
                    </td>
                    <td><span className="next-run-cell">{task.status === "active" ? formatTime(task.nextRunAt) : task.status === "paused" ? "恢复后继续" : "—"}</span></td>
                    <td>
                      <span className="progress-count">{task.sentCount}<span> / {task.repeatCount ?? "按日期"}</span></span>
                      <small className="progress-caption">{task.pendingCount ? `${task.pendingCount} 条等待投递` : task.endDate ? `截至 ${task.endDate}` : "已送达"}</small>
                    </td>
                    <td><TaskBadge task={task} /></td>
                    <td><TaskActions task={task} busy={busy === task.id} onToggle={() => void toggle(task)} onArchive={() => setArchive(task)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={page} total={data.total} pageSize={PAGE_SIZE} onChange={setPage} />}
      </Card>
      <div className="page-note"><Glyph name="shield" size={16} /><p>暂停只停止未来排期，队列中的提醒仍会继续投递；归档不会删除任何消息。</p></div>
      {archive && (
        <Confirm title={`归档「${archive.name}」？`} confirmLabel="确认归档" onClose={() => setArchive(null)} onConfirm={() => void archiveTask()} busy={busy === archive.id}>
          <p>未来的排期将停止。已经到期的提醒会继续投递，全部历史记录都会保留，你也可以随时复制为新提醒。</p>
        </Confirm>
      )}
    </div>
  );
}

function TaskActions({ task, busy, onToggle, onArchive }: { task: Task; busy: boolean; onToggle: () => void; onArchive: () => void }) {
  const { openTask } = useWorkspace();
  const editable = task.status === "active" || task.status === "paused";
  return (
    <div className="row-actions">
      {editable && <IconButton label={`编辑 ${task.name}`} icon="edit" onPress={() => openTask(task)} isDisabled={busy} />}
      <Dropdown>
        <IconButton label={`更多操作 ${task.name}`} icon="more" isDisabled={busy} />
        <Dropdown.Popover>
          <Dropdown.Menu aria-label={`${task.name}的操作`} onAction={(key) => {
            if (key === "toggle") onToggle();
            if (key === "copy") openTask(task, true);
            if (key === "archive") onArchive();
          }}>
            {editable && <Dropdown.Item id="toggle" textValue={task.status === "paused" ? "恢复提醒" : "暂停提醒"}>
              <Glyph name={task.status === "paused" ? "play" : "pause"} /><Label>{task.status === "paused" ? "恢复提醒" : "暂停提醒"}</Label>
            </Dropdown.Item>}
            <Dropdown.Item id="copy" textValue="复制为新提醒"><Glyph name="copy" /><Label>复制为新提醒</Label></Dropdown.Item>
            {task.status !== "archived" && <Dropdown.Item id="archive" textValue="归档提醒"><Glyph name="archive" /><Label>归档提醒</Label></Dropdown.Item>}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}
