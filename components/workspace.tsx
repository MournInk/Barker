"use client";

import { I18nProvider } from "react-aria";
import { Button } from "@heroui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { Dashboard, Task } from "@/lib/types";
import { api, errorMessage } from "@/lib/ui";
import { Gate } from "./gate";
import { Shell } from "./nav";
import { Notice } from "./primitives";
import { useResource } from "./use-resource";
import { WorkspaceContext } from "./workspace-context";
import { TaskEditor } from "./task-editor";
import { Glyph } from "./icons";

export function Workspace({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  async function checkSession() {
    try {
      const data = await api<{ authenticated: boolean }>("/api/session");
      setError(""); setAuthenticated(data.authenticated);
    } catch (error) { setError(errorMessage(error)); }
  }
  useEffect(() => {
    let alive = true;
    void api<{ authenticated: boolean }>("/api/session").then((data) => {
      if (alive) setAuthenticated(data.authenticated);
    }).catch((error) => { if (alive) setError(errorMessage(error)); });
    const expired = () => setAuthenticated(false);
    window.addEventListener("barker:unauthorized", expired);
    return () => { alive = false; window.removeEventListener("barker:unauthorized", expired); };
  }, []);
  return <I18nProvider locale="zh-CN">{authenticated === null ? <main className="boot-screen"><span className="brand-mark"><Glyph name="bell" size={25} /></span>{error ? <><Notice>{error}</Notice><Button variant="secondary" onPress={() => void checkSession()}>重新连接</Button></> : <p>正在打开你的工作空间…</p>}</main> : !authenticated ? <Gate onAuthed={() => setAuthenticated(true)} /> : <AuthenticatedWorkspace logout={async () => { await api("/api/session", { method: "DELETE" }); setAuthenticated(false); }}>{children}</AuthenticatedWorkspace>}</I18nProvider>;
}

function AuthenticatedWorkspace({ children, logout }: { children: ReactNode; logout: () => Promise<void> }) {
  const { data: dashboard, error, refresh } = useResource<Dashboard>("/api/overview");
  const [editor, setEditor] = useState<{ task?: Task; duplicate?: boolean } | null>(null);
  const [notice, setNotice] = useState<{ message: string; kind: "error" | "success" } | null>(null);
  useEffect(() => {
    if (notice?.kind !== "success") return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  return <WorkspaceContext.Provider value={{ dashboard, error, refresh, logout, openTask: (task, duplicate) => setEditor({ task, duplicate }), notify: (message, kind = "success") => setNotice({ message, kind }) }}>
    <Shell><div className="workspace-notices">{error && <Notice>暂时无法同步，当前显示上次数据。{error}<Button size="sm" variant="ghost" onPress={() => void refresh()}>重试</Button></Notice>}{notice && <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.message}</Notice>}</div>{children}</Shell>
    {editor && <TaskEditor task={editor.task} duplicate={editor.duplicate} onClose={() => setEditor(null)} />}
  </WorkspaceContext.Provider>;
}
