"use client";

import { Button, Card, Chip } from "@heroui/react";
import Link from "next/link";
import { useState } from "react";
import { Glyph, type IconName } from "@/components/icons";
import { Empty, TaskBadge } from "@/components/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { localDateValue, PRESET_LABELS } from "@/lib/ui";
import { useTime } from "@/components/use-time";
import type { DeliveryStatus } from "@/lib/types";
import { AgendaDetails } from "@/components/agenda-details";

const deliveryLabels: Record<DeliveryStatus, string> = { sent: "Bark 已接收", pending: "等待投递", sending: "正在发送", cancelled: "已取消", expired: "已过期" };

export default function OverviewPage() {
  const { dashboard, error: dashboardError, openTask } = useWorkspace();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const { timeZone: zone, formatTime, clockTime } = useTime();
  const upcoming = (dashboard?.tasks ?? []).filter((task) => task.status === "active" && task.nextRunAt).sort((left, right) => left.nextRunAt!.localeCompare(right.nextRunAt!));
  const displayed = (dashboard?.upcoming ?? []).filter((item) => !selectedDay || localDateValue(new Date(item.occurrenceAt), zone) === selectedDay).flatMap((item) => {
    const task = dashboard?.tasks.find((task) => task.id === item.taskId);
    return task ? [{ ...task, nextRunAt: item.occurrenceAt }] : [];
  });
  const total = selectedDay ? dashboard?.upcomingDays.find((day) => day.date === selectedDay)?.total ?? 0 : dashboard?.upcomingDays.reduce((sum, day) => sum + day.total, 0) ?? 0;
  const hidden = Math.max(0, total - 4);
  const next = upcoming[0];
  const days = dashboard?.upcomingDays ?? [];
  const metrics: Array<{ label: string; value: number | undefined; detail: string; icon: IconName; caution?: boolean }> = [
    { label: "进行中的提醒", value: dashboard?.stats.active, detail: "按各自时区继续排期", icon: "calendar" },
    { label: "今日 Bark 已接收", value: dashboard?.stats.todaySent, detail: `以 ${zone} 统计`, icon: "circleCheck" },
    { label: "等待投递", value: dashboard?.deliveries.pending, detail: "包含正在发送的消息", icon: "send" },
    { label: "自动重试中", value: dashboard?.deliveries.retrying, detail: dashboard?.deliveries.retrying ? "查看记录了解失败原因" : "目前没有需要重试的消息", icon: "refresh", caution: Boolean(dashboard?.deliveries.retrying) },
  ];
  const maxActivity = Math.max(1, ...(dashboard?.activity.map((day) => day.sent) ?? [1]));
  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">为重要的事，留一个位置</p><h1>日常有序，心里有数<span className="heading-period">。</span></h1><p>查看下一条提醒和投递状态。</p></div><Button onPress={() => openTask()}><Glyph name="plus" size={17} />新建提醒</Button></div>
    {dashboard && !dashboard.deviceKeyConfigured && <div className="setup-banner"><span className="setup-symbol"><Glyph name="link" size={20} /></span><div><strong>连接 Bark 设备</strong><p>配置后，队列中的提醒会按策略投递。</p></div><Link href="/settings" className="text-action">连接 Bark<Glyph name="arrow" size={16} /></Link></div>}
    <div className="hero-grid">
      <Card className="next-panel">
        <div className="section-top"><h2>下一个时刻</h2><span className="mini-label">{zone}</span></div>
        {next ? <>
          <div className="next-time">{clockTime(next.nextRunAt!)}<span>{formatTime(next.nextRunAt!, { hour: undefined, minute: undefined })}</span></div>
          <div className="next-task"><span className="task-symbol"><Glyph name="bell" size={21} /></span><div><h3>{next.name}</h3><p>{next.description || "下一次触发时，Barker 会将提醒加入投递队列。"}</p></div></div>
          <div className="next-bottom"><span><Glyph name="refresh" size={14} />{PRESET_LABELS[next.preset]}</span><Link href="/tasks" className="text-action">管理提醒<Glyph name="arrow" size={15} /></Link></div>
        </> : <div className="next-empty"><Glyph name="clock" size={33} /><h3>暂无下一条提醒</h3><Button variant="ghost" onPress={() => openTask()}>开始安排</Button></div>}
      </Card>
    </div>
    <section className="metrics-grid" aria-label="提醒概况">{metrics.map((metric) => <Card key={metric.label} className="metric-card"><div><p>{metric.label}</p><strong className={metric.caution ? "text-warning" : ""}>{metric.value ?? "—"}<small>条</small></strong><span>{metric.detail}</span></div><span className={`metric-symbol ${metric.caution ? "caution" : ""}`}><Glyph name={metric.icon} size={21} /></span></Card>)}</section>
    <Card className="upcoming-panel"><div className="section-top"><div><h2>接下来的安排</h2><p>未来七天的排期，时间按 {zone} 显示。</p></div><Link href="/tasks" className="text-action">全部提醒<Glyph name="arrow" size={15} /></Link></div>
      <div className="week-strip"><button className={`week-all ${selectedDay === null ? "chosen" : ""}`} onClick={() => setSelectedDay(null)} aria-pressed={selectedDay === null}>全部<small>提醒</small></button>{days.map((day, index) => {
        const date = day.date;
        const count = dashboard?.upcomingDays.find((item) => item.date === date)?.total ?? 0;
        return <button key={date} className={selectedDay === date ? "chosen" : ""} aria-pressed={selectedDay === date} onClick={() => setSelectedDay(date)}><small>{index === 0 ? "今天" : new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00Z`))}</small><span>{Number(date.slice(8))}</span><small>{count} 条</small></button>;
      })}</div>
      {!dashboard ? dashboardError ? null : <div className="loading-state">正在同步你的安排…</div> : !displayed.length ? <Empty title="这里暂时没有提醒" description="新建周期提醒，或选择其他日期。" action={<Button variant="outline" onPress={() => openTask()}>新建提醒</Button>} /> : <div className="upcoming-list">{displayed.slice(0, 4).map((task) => (
        <button className="upcoming-row" key={`${task.id}:${task.nextRunAt}`} onClick={() => openTask(task)}>
          <span className="upcoming-time">{clockTime(task.nextRunAt!)}<small>{localDateValue(new Date(task.nextRunAt!), zone).replaceAll("-", "/")}</small></span>
          <span className="upcoming-copy"><strong>{task.name}</strong><small>{PRESET_LABELS[task.preset]}<span>·</span>{task.description || (task.sentCount ? `${task.sentCount} 次 Bark 已接收` : "尚未投递")}</small></span>
          <TaskBadge task={task} /><Glyph name="chevron" size={14} className="row-chevron" />
        </button>
      ))}</div>}
      {hidden > 0 && <p className="forecast-overflow">{selectedDay ? "当天" : "七天内"}共 {total} 条，另有 {hidden} 条未展开。<Button size="sm" variant="ghost" onPress={() => setDetails(true)}>查看完整排期</Button></p>}
    </Card>
    <div className="overview-bottom-grid"><Card className="activity-panel"><div className="section-top"><h2>投递节奏</h2><span className="mini-label">最近 7 天</span></div><div className="activity-total"><strong>{dashboard?.activity.reduce((sum, day) => sum + day.sent, 0) ?? "—"}</strong><span>条 Bark 已接收</span></div><div className="activity-chart" role="img" aria-label={dashboard?.activity.map((day) => `${day.date}：${day.sent}条`).join("；") ?? "正在加载"}>{dashboard?.activity.map((day, index) => <div className="activity-column" key={day.date}><div className={`activity-bar ${index === 6 ? "today" : ""}`} style={{ height: `${Math.max(3, day.sent / maxActivity * 88)}px` }} title={`${day.date} · ${day.sent} 条`} /><span>{index === 6 ? "今天" : day.date.slice(5).replace("-", "/")}</span></div>)}</div></Card>
      <Card className="recent-panel"><div className="section-top"><div><h2>最近投递</h2><p>按最近一次投递活动排序。</p></div><Link href="/deliveries" className="text-action">查看记录<Glyph name="arrow" size={15} /></Link></div>{dashboard?.recent.length ? <div className="recent-list">{dashboard.recent.map((item) => <div key={item.id} className="recent-row"><span className={`delivery-symbol ${item.status === "sent" ? "delivered" : item.status === "pending" && item.lastError ? "retrying" : ""}`}><Glyph name={item.status === "sent" ? "check" : "clock"} size={17} /></span><div><strong>{item.taskName}</strong><small>{item.status === "pending" && item.lastError ? "等待重试" : deliveryLabels[item.status]}</small></div><time dateTime={item.updatedAt}>{formatTime(item.updatedAt)}</time><Chip variant="soft" color={item.status === "sent" ? "success" : "default"} size="sm">{deliveryLabels[item.status]}</Chip></div>)}</div> : <div className="inline-empty"><Glyph name="inbox" size={20} /><p>{dashboard ? "暂无投递记录。" : dashboardError ? "暂时无法读取投递记录。" : "正在读取投递记录…"}</p></div>}</Card>
    </div>
    {details && <AgendaDetails date={selectedDay} onClose={() => setDetails(false)} />}
  </div>;
}
