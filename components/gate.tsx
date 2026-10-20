"use client";

import { Bell } from "lucide-react";
import { useState, type FormEvent } from "react";
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
    <main className="gate">
      <form className="card stack" onSubmit={signIn}>
        <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
          <span style={{ width: 40, height: 40, display: "grid", placeItems: "center", borderRadius: 10, background: "var(--accent)", color: "#fff" }}>
            <Bell size={20} />
          </span>
          <div>
            <p className="eyebrow">Barker</p>
            <h1>输入启动密码</h1>
          </div>
        </div>
        <label>
          启动日志中的访问密码
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="button" disabled={busy}>进入</button>
        <p className="helper">密码在 `docker logs` / 服务启动日志中打印，也可通过 `BARKER_PASSWORD` 固定。</p>
      </form>
    </main>
  );
}
