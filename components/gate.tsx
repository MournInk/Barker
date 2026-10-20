"use client";

import { Bell } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/ui";

export function Gate({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/session", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm p-6">
        <form onSubmit={signIn} className="space-y-5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
              <Bell className="size-4" />
            </span>
            <div className="min-w-0">
              <h1 className="text-base font-medium">输入访问密码</h1>
              <p className="text-xs text-muted-foreground">Barker · 北京时间可靠提醒</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="access-password" className="text-xs text-muted-foreground">
              访问密码
            </Label>
            <Input
              id="access-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              aria-label="访问密码"
              placeholder="••••••••"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "验证中…" : "进入"}
          </Button>

          <p className="text-xs leading-relaxed text-muted-foreground">
            密码在服务启动日志（<code className="font-mono">docker logs</code>）中打印，也可通过{" "}
            <code className="font-mono">BARKER_PASSWORD</code> 固定。
          </p>
        </form>
      </Card>
    </main>
  );
}
