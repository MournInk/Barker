"use client";

import { Button, Card, Chip, Input, Tabs, TextArea } from "@heroui/react";
import { useState } from "react";
import { Glyph } from "@/components/icons";
import { Confirm, Empty, Notice } from "@/components/primitives";
import { Pagination } from "@/components/pagination";
import { Selection } from "@/components/selection";
import { useResource } from "@/components/use-resource";
import { useWorkspace } from "@/components/workspace-context";
import type { Delivery, DeliveryAttempt, DeliveryStatus } from "@/lib/types";
import { api, errorMessage } from "@/lib/ui";
import { useTime } from "@/components/use-time";

const labels: Record<DeliveryStatus, string> = { pending: "待投递", sending: "发送中", sent: "Bark 已接收", cancelled: "已取消", expired: "已过期" };
const filters = [{ id: "all", label: "全部记录" }, ...Object.entries(labels).map(([id, label]) => ({ id, label })), { id: "retrying", label: "重试中" }];

export default function DeliveriesPage() {
  const { formatTime } = useTime();
  const { dashboard, refresh: refreshDashboard, notify } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const [cancel, setCancel] = useState<Delivery | null>(null);
  const [expanded, setExpanded] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [edit, setEdit] = useState<Delivery | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const params = new URLSearchParams({ page: String(page), pageSize: "12", q: search });
  if (filter !== "all") params.set("status", filter);
  const { data, error, refresh } = useResource<{ deliveries: Delivery[]; total: number; page: number }>(`/api/deliveries?${params}`);
  const pending = data?.deliveries.filter((item) => item.status === "pending") ?? [];
  const selectedIds = pending.filter((item) => selected.includes(item.id)).map((item) => item.id);
  async function mutate(item: Delivery, action: "retry" | "cancel") {
    setBusy(item.id);
    try {
      await api(`/api/deliveries/${item.id}/${action}`, { method: "POST", body: "{}" });
      setCancel(null);
      notify(action === "retry" ? "已提前加入投递队列；服务限流时仍会遵守等待时间。" : "已取消本条消息，记录已保留。未来排期不受影响。");
      void Promise.allSettled([refresh(), refreshDashboard()]);
    } catch (error) { notify(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }
  async function bulk(action: string) {
    if (!selectedIds.length) { setBulkConfirm(false); return; }
    setBusy("bulk");
    try {
      const result = await api<{ results: Array<{ success: boolean }> }>("/api/deliveries", { method: "PATCH", body: JSON.stringify({ action, ids: selectedIds }) });
      notify(`已处理 ${result.results.filter((item) => item.success).length} 条消息；状态已变化的记录已跳过。`);
      setSelected([]); setBulkConfirm(false); await Promise.all([refresh(), refreshDashboard()]);
    } catch (error) { notify(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }
  async function saveEdit() {
    if (!edit) return;
    setBusy(edit.id);
    try {
      await api(`/api/deliveries/${edit.id}`, { method: "PATCH", body: JSON.stringify({ title: edit.taskName, body: edit.description, updatedAt: edit.updatedAt }) });
      setEdit(null); notify("内容已修正，消息等待重试。"); await refresh();
    } catch (error) { notify(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }
  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">每一条提醒，都有回音</p><h1>投递记录<span className="heading-period">。</span></h1><p>查看通知和每次尝试，按需要重试或取消等待中的消息。</p></div><Chip variant="soft" color={dashboard?.deliveries.retrying ? "warning" : "default"}><Chip.Label>{dashboard?.deliveries.retrying ? `${dashboard.deliveries.retrying} 条自动重试中` : "投递记录已持久保存"}</Chip.Label></Chip></div>
    <Card className="deliveries-panel"><div className="list-toolbar"><Tabs selectedKey={filter} onSelectionChange={(key) => { setFilter(String(key)); setPage(1); setSelected([]); }} variant="secondary" className="filter-tabs"><Tabs.ListContainer><Tabs.List aria-label="投递状态">{filters.map((item) => <Tabs.Tab id={item.id} key={item.id}>{item.label}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer></Tabs><span className="mini-label">请求完成 5 秒后刷新</span></div>
      <div className="bulk-toolbar">
        <Selection label="选择本页待投递消息" selected={pending.length > 0 && selectedIds.length === pending.length} onChange={(value) => setSelected(value ? pending.map((item) => item.id) : [])} />
        <Input aria-label="搜索投递记录" placeholder="搜索标题或正文" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); setSelected([]); }} maxLength={200} />
        <Button size="sm" variant="ghost" isDisabled={!selectedIds.length || Boolean(busy)} onPress={() => void bulk("retry")}>批量重试</Button>
        <Button size="sm" variant="danger-soft" isDisabled={!selectedIds.length || Boolean(busy)} onPress={() => setBulkConfirm(true)}>批量取消</Button>
      </div>
      {error && <Notice>{error}<Button variant="ghost" size="sm" onPress={() => void refresh()}>重试</Button></Notice>}
      {!data ? error ? null : <div className="loading-state">正在读取投递记录…</div> : !data.deliveries.length ? <Empty title="没有此状态的记录" description="提醒触发后，会在这里记录投递和尝试状态。" icon="inbox" /> : <div className="delivery-list">{data.deliveries.map((item) => {
        const retrying = item.status === "pending" && item.attempts > 0;
        return <article className="delivery-record" key={item.id}>
          {item.status === "pending" && <Selection label={`选择投递 ${item.taskName}`} selected={selected.includes(item.id)} onChange={(value) => setSelected((current) => value ? [...current, item.id] : current.filter((id) => id !== item.id))} />}
          <span className={`delivery-symbol ${item.status === "sent" ? "delivered" : retrying ? "retrying" : ""}`}><Glyph name={item.status === "sent" ? "check" : retrying ? "refresh" : "clock"} size={19} /></span>
          <div className="delivery-content"><div className="delivery-record-heading"><h2>{item.taskName}</h2><Chip size="sm" variant="soft" color={item.status === "sent" ? "success" : retrying ? "warning" : "default"}>{item.manualOnly ? "等待人工处理" : retrying ? "重试中" : labels[item.status]}</Chip></div><p>{item.description || "计划提醒时间已到。"}</p>
            <div className="delivery-meta"><span>计划时间 <time>{formatTime(item.occurrenceAt)}</time></span><span>{item.status === "sent" ? `Bark 接收于 ${formatTime(item.deliveredAt)}` : item.status === "pending" ? `下次尝试 ${formatTime(item.nextAttemptAt)}` : item.status === "sending" ? "正在等待 Bark 响应" : `${labels[item.status]} · ${formatTime(item.updatedAt)}`}</span><span>已完成尝试 {item.attempts} 次</span>{item.expiresAt && <span>到期 {formatTime(item.expiresAt)}</span>}</div>
            {item.lastError && item.status !== "sent" && <div className="delivery-error"><Glyph name="warning" size={14} /><span>{item.lastError}</span></div>}
            {item.manualOnly && <p className="field-hint">永久错误已停止自动重试。请修正内容或设备配置后重试。</p>}
            {item.status === "pending" && <Button size="sm" variant="ghost" onPress={() => setEdit(item)}>修正消息内容</Button>}
            <Button variant="ghost" size="sm" aria-expanded={expanded === item.id} onPress={() => setExpanded(expanded === item.id ? "" : item.id)}>尝试历史{expanded === item.id ? "（收起）" : ""}</Button>
            {expanded === item.id && <AttemptHistory id={item.id} />}
          </div><div className="delivery-actions">{retrying && <Button variant="outline" size="sm" isPending={busy === item.id} isDisabled={Boolean(busy)} onPress={() => void mutate(item, "retry")}>立即重试</Button>}{item.status === "pending" && <Button variant="ghost" size="sm" isDisabled={Boolean(busy)} onPress={() => setCancel(item)}>取消投递</Button>}</div>
        </article>;
      })}</div>}
      {data && <Pagination page={data.page} total={data.total} pageSize={12} onChange={(target) => { setPage(target); setSelected([]); }} />}
    </Card><div className="delivery-policy"><div><Glyph name="shield" size={20} /><h3>保存记录，按策略重试</h3></div><p>到期提醒先持久化，再发送。失败后按 5 秒至 1 小时退避，并遵守 Bark 的 Retry-After；过期或手动取消的消息停止投递。</p><p>网络中断时可能无法确认 Bark 是否已收到，重试可能产生重复通知。「Bark 已接收」表示 API 确认接收，设备是否展示取决于 Bark 和系统通知设置。</p></div>
    {cancel && <Confirm title={`取消「${cancel.taskName}」这次投递？`} confirmLabel="取消投递" onClose={() => setCancel(null)} onConfirm={() => void mutate(cancel, "cancel")} busy={busy === cancel.id}><p>仅取消这一条等待中的消息，保留正文和尝试历史。任务未来的排期继续运行；正在发送的请求无法撤回。</p></Confirm>}
    {bulkConfirm && <Confirm title="取消选中的待投递消息？" confirmLabel="批量取消" onClose={() => setBulkConfirm(false)} onConfirm={() => void bulk("cancel")} busy={busy === "bulk"}><p>仅处理当前页选中的等待消息，记录会保留。</p></Confirm>}
    {edit && <Confirm title="修正消息内容" confirmLabel="保存并重试" onClose={() => setEdit(null)} onConfirm={() => void saveEdit()} busy={busy === edit.id}><Input aria-label="修正标题" value={edit.taskName} onChange={(event) => setEdit({ ...edit, taskName: event.target.value })} maxLength={80} /><TextArea aria-label="修正正文" value={edit.description} onChange={(event) => setEdit({ ...edit, description: event.target.value })} maxLength={2000} /></Confirm>}
  </div>;
}

function AttemptHistory({ id }: { id: string }) {
  const { formatTime } = useTime();
  const { data, error } = useResource<{ attempts: DeliveryAttempt[] }>(`/api/deliveries/${id}/attempts`, 5000);
  const names = { sending: "发送中", sent: "Bark 已接收", failed: "失败", interrupted: "进程中断，结果未知" };
  if (error) return <Notice>{error}</Notice>;
  if (!data) return <p className="field-hint">正在读取尝试历史…</p>;
  return <div className="attempt-history">{data.attempts.length ? <ol>{data.attempts.map((attempt) => <li key={attempt.id}><strong>{names[attempt.outcome]}</strong><time>{formatTime(attempt.startedAt)}</time>{attempt.error && <p>{attempt.error}</p>}</li>)}</ol> : <p>尚无尝试历史。升级前的记录仅保留累计次数。</p>}<p>显示最近 100 次尝试。</p></div>;
}
