"use client";

import { Button, Card, Chip, Tabs } from "@heroui/react";
import { useState } from "react";
import { Glyph } from "@/components/icons";
import { Empty, Notice } from "@/components/primitives";
import { Pagination } from "@/components/pagination";
import { useResource } from "@/components/use-resource";
import { useWorkspace } from "@/components/workspace-context";
import type { Delivery } from "@/lib/types";
import { api, errorMessage, formatTime } from "@/lib/ui";

const filters = [{ id: "all", label: "全部记录" }, { id: "sent", label: "已送达" }, { id: "pending", label: "待投递" }, { id: "retrying", label: "重试中" }, { id: "sending", label: "发送中" }];

export default function DeliveriesPage() {
  const { dashboard, refresh: refreshDashboard, notify } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const params = new URLSearchParams({ page: String(page), pageSize: "12" });
  if (filter !== "all") params.set("status", filter);
  const { data, error, refresh } = useResource<{ deliveries: Delivery[]; total: number }>(`/api/deliveries?${params}`);
  async function retry(item: Delivery) {
    setBusy(item.id);
    try { await api(`/api/deliveries/${item.id}/retry`, { method: "POST", body: "{}" }); notify("已提前加入投递队列，将由调度器立即处理。"); await Promise.all([refresh(), refreshDashboard()]); }
    catch (error) { notify(errorMessage(error), "error"); }
    finally { setBusy(""); }
  }
  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">每一条提醒，都有回音</p><h1>投递记录<span className="heading-period">。</span></h1><p>追踪从排期到送达的完整过程，失败的消息始终留在这里。</p></div><Chip variant="soft" color={dashboard?.deliveries.retrying ? "warning" : "success"}><Glyph name={dashboard?.deliveries.retrying ? "refresh" : "shield"} size={14} /><Chip.Label>{dashboard?.deliveries.retrying ? `${dashboard.deliveries.retrying} 条自动重试中` : "所有提醒安全保存"}</Chip.Label></Chip></div>
    <Card className="deliveries-panel"><div className="list-toolbar"><Tabs selectedKey={filter} onSelectionChange={(key) => { setFilter(String(key)); setPage(1); }} variant="secondary" className="filter-tabs"><Tabs.ListContainer><Tabs.List aria-label="投递状态">{filters.map((item) => <Tabs.Tab id={item.id} key={item.id}>{item.label}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer></Tabs><span className="mini-label">自动刷新 · 5 秒</span></div>{error && <Notice>{error}<Button variant="ghost" size="sm" onPress={() => void refresh()}>重试</Button></Notice>}
      {!data ? <div className="loading-state">正在读取投递记录…</div> : !data.deliveries.length ? <Empty title={filter === "all" ? "第一条回音，还在路上" : "没有此状态的记录"} description={filter === "retrying" ? "目前没有需要重试的提醒，你可以安心专注当下。" : "提醒触发后，会自动在这里记录投递状态。"} icon="inbox" /> : <div className="delivery-list">{data.deliveries.map((item) => <article className="delivery-record" key={item.id}><span className={`delivery-symbol ${item.status === "sent" ? "delivered" : item.lastError ? "retrying" : ""}`}><Glyph name={item.status === "sent" ? "check" : item.lastError ? "refresh" : "send"} size={19} /></span><div className="delivery-content"><div className="delivery-record-heading"><h2>{item.taskName}</h2><Chip size="sm" variant="soft" color={item.status === "sent" ? "success" : item.lastError ? "warning" : "default"}>{item.status === "sent" ? "已送达" : item.status === "sending" ? "发送中" : item.lastError ? "重试中" : "待投递"}</Chip></div><p>{item.description || "计划提醒时间已到。"}</p><div className="delivery-meta"><span>计划时间 <time>{formatTime(item.occurrenceAt)}</time></span><span>{item.status === "sent" ? `送达于 ${formatTime(item.deliveredAt)}` : item.status === "sending" ? "正在等待 Bark 响应" : `下次尝试 ${formatTime(item.nextAttemptAt)}`}</span><span>已尝试 {item.attempts} 次</span></div>{item.lastError && item.status !== "sent" && <div className="delivery-error"><Glyph name="warning" size={14} /><span>{item.lastError}</span></div>}</div>{item.status === "pending" && item.attempts > 0 && <Button variant="outline" size="sm" isPending={busy === item.id} onPress={() => void retry(item)}>立即重试</Button>}</article>)}</div>}
      {data && <Pagination page={page} total={data.total} pageSize={12} onChange={setPage} />}
    </Card><div className="delivery-policy"><div><Glyph name="shield" size={20} /><h3>可靠，不止于准时</h3></div><p>到期提醒先持久化，再发送。失败后以 5 秒至 1 小时的间隔持续重试；重启后自动接续，不会因次数上限而丢弃。</p><p>网络中断时可能无法确认 Bark 是否已收到，重试可能产生重复通知。Barker 提供至少一次投递，而非恰好一次保证。</p></div>
  </div>;
}
