"use client";

import { Button, Modal } from "@heroui/react";
import { useState } from "react";
import { useTime } from "./use-time";
import { useResource } from "./use-resource";
import { Notice } from "./primitives";

export function AgendaDetails({ date, onClose }: { date: string | null; onClose: () => void }) {
  const { formatTime } = useTime();
  const [cursors, setCursors] = useState<Array<{ occurrenceAt: string; taskId: string }>>([]);
  const query = new URLSearchParams();
  if (date) query.set("date", date);
  const cursor = cursors.at(-1);
  if (cursor) { query.set("after", cursor.occurrenceAt); query.set("task", cursor.taskId); }
  const { data, error } = useResource<{ items: Array<{ occurrenceAt: string; taskId: string; name: string }>; total: number; next: { occurrenceAt: string; taskId: string } | null }>(`/api/upcoming?${query}`, 0);
  return <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) onClose(); }}><Modal.Container size="lg" scroll="inside"><Modal.Dialog>
    <Modal.Header><Modal.Heading>{date ?? "未来七天"}完整排期</Modal.Heading></Modal.Header>
    <Modal.Body>{error && <Notice>{error}</Notice>}<p>共 {data?.total ?? "…"} 次；第 {cursors.length + 1} 页，每页最多 50 次。</p>
      <div className="management-list">{data?.items.map((item) => <div key={`${item.taskId}:${item.occurrenceAt}`}><strong>{item.name}</strong><time>{formatTime(item.occurrenceAt)}</time></div>)}</div>
    </Modal.Body>
    <Modal.Footer><Button variant="ghost" isDisabled={!cursors.length} onPress={() => setCursors((current) => current.slice(0, -1))}>上一页</Button><Button variant="outline" isDisabled={!data?.next} onPress={() => { if (data?.next) setCursors((current) => [...current, data.next!]); }}>下一页</Button><Button onPress={onClose}>关闭</Button></Modal.Footer>
  </Modal.Dialog></Modal.Container></Modal.Backdrop>;
}
