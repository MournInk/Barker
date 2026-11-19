"use client";

import { Button, Card, Input } from "@heroui/react";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/ui";
import { useTime } from "./use-time";
import { Confirm, Field, Notice, Pick } from "./primitives";
import { useResource } from "./use-resource";
import { useUnsaved } from "./use-unsaved";

interface Security {
  sessions: Array<{ id: string; expiresAt: number }>;
  tokens: Array<{ id: string; name: string; scope: string; expiresAt: number }>;
}

export function SecurityManager() {
  const { formatTime } = useTime();
  const { data, error, refresh } = useResource<Security>("/api/security", 0);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("read");
  const [days, setDays] = useState("30");
  const [token, setToken] = useState("");
  const [feedback, setFeedback] = useState<{ message: string; kind: "success" | "error" } | null>(null);
  const [revocation, setRevocation] = useState<{ id: string; kind: "session" | "token"; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useUnsaved(Boolean(current || next || name));
  async function mutate(body: object): Promise<boolean> {
    setBusy(true); setFeedback(null);
    try {
      const response = await api<{ token?: string }>("/api/security", { method: "POST", body: JSON.stringify(body) });
      setToken(response.token ?? ""); setFeedback({ message: "访问设置已更新。", kind: "success" }); await refresh(); return true;
    } catch (error) { setFeedback({ message: errorMessage(error), kind: "error" }); return false; }
    finally { setBusy(false); }
  }
  async function password(event: FormEvent) {
    event.preventDefault();
    if (await mutate({ action: "password", current, next })) { setCurrent(""); setNext(""); }
  }
  async function credential(event: FormEvent) {
    event.preventDefault();
    if (await mutate({ action: "token", name, scope, days: Number(days) })) setName("");
  }
  async function revoke() {
    if (!revocation) return;
    await mutate({ action: "revoke", kind: revocation.kind, id: revocation.id });
    setRevocation(null);
  }
  return <Card className="management-card">
    <h2>访问安全</h2><p>修改密码会撤销其他会话与全部 API 凭据。服务端环境密码变更后，环境配置重新生效。</p>
    {error && <Notice>{error}</Notice>}
    {feedback && <Notice kind={feedback.kind}>{feedback.message}</Notice>}
    <form className="management-form" onSubmit={password}><fieldset disabled={busy}>
      <Field label="当前访问密码" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} maxLength={300} autoComplete="current-password" required />
      <Field label="新访问密码" type="password" value={next} onChange={(event) => setNext(event.target.value)} minLength={16} maxLength={300} autoComplete="new-password" required />
    </fieldset><Button type="submit" variant="outline" isDisabled={busy}>修改访问密码</Button></form>
    <details><summary>API 凭据与有效会话</summary>
      <form className="management-form" onSubmit={credential}><fieldset disabled={busy}>
        <Field label="凭据名称" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        <Pick label="凭据权限" value={scope} onChange={setScope} options={[{ value: "read", label: "只读" }, { value: "write", label: "读写" }]} />
        <Field label="有效天数" type="number" value={days} onChange={(event) => setDays(event.target.value)} min={1} max={365} required />
      </fieldset><Button type="submit" variant="outline" isDisabled={busy}>创建 API 凭据</Button></form>
      {token && <Notice kind="info"><p>凭据只显示一次，请复制保存。请求头使用 Authorization: Bearer。</p><Input aria-label="新 API 凭据" value={token} readOnly /></Notice>}
      <div className="management-list">{data?.tokens.map((item) => <div key={item.id}><span><strong>{item.name} · {item.scope === "read" ? "只读" : "读写"}</strong><small>到期 {formatTime(new Date(item.expiresAt).toISOString())}</small></span><Button size="sm" variant="danger-soft" isDisabled={busy} onPress={() => setRevocation({ id: item.id, kind: "token", name: item.name })}>撤销凭据</Button></div>)}</div>
      <div className="management-list">{data?.sessions.map((item) => <div key={item.id}><span><strong>会话 {item.id.slice(0, 8)}</strong><small>到期 {formatTime(new Date(item.expiresAt).toISOString())}</small></span><Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setRevocation({ id: item.id, kind: "session", name: `会话 ${item.id.slice(0, 8)}` })}>撤销会话</Button></div>)}</div>
    </details>
    {revocation && <Confirm title={`撤销「${revocation.name}」？`} confirmLabel="确认撤销" onClose={() => setRevocation(null)} onConfirm={() => void revoke()} busy={busy}>
      <p>{revocation.kind === "token" ? "使用此 API 凭据的客户端将失去访问权限。" : "此会话将立即退出，需要重新登录。"}</p>
    </Confirm>}
  </Card>;
}

export function AuditLog() {
  const { formatTime } = useTime();
  const { data, error } = useResource<{ events: Array<{ id: string; action: string; target: string; createdAt: string }> }>("/api/audit", 15000);
  return <Card className="management-card"><h2>操作审计</h2><p>最近 100 次操作；服务器保留最近 10000 条，不记录密码或消息正文。</p>{error && <Notice>{error}</Notice>}<div className="audit-list">{data?.events.map((item) => <div key={item.id}><time>{formatTime(item.createdAt)}</time><strong>{item.action}</strong><code>{item.target}</code></div>)}</div></Card>;
}
