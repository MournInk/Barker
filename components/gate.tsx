"use client";

import { Button, Input, Label, TextField } from "@heroui/react";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/ui";
import { Glyph } from "./icons";
import { Notice } from "./primitives";

export function Gate({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/api/session", { method: "POST", body: JSON.stringify({ password }) }); setPassword(""); onAuthed(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <main className="access-page"><section className="access-story"><div className="brand"><span className="brand-mark"><Glyph name="bell" size={24} /></span><span>barker.</span></div><div className="access-story-copy"><span className="eyebrow">简单安排，准时抵达</span><h1>记住重要的，<br />专注眼前的。</h1><p>一个安静、可靠的提醒工作空间。<br />把每一次惦记，送到恰好的时刻。</p><div className="access-orbit" aria-hidden="true"><div className="orbit-ring" /><div className="orbit-ring inner" /><span className="orbit-center"><Glyph name="bell" size={52} /></span><span className="orbit-spark one" /><span className="orbit-spark two" /></div></div><p className="access-footnote"><Glyph name="shield" size={16} />私有部署 · 可靠投递 · 安心专注</p></section>
    <section className="access-form-section"><form onSubmit={signIn} className="access-form"><span className="access-lock"><Glyph name="lock" size={23} /></span><p className="eyebrow">你的专属工作空间</p><h2>欢迎回来</h2><p className="access-intro">输入服务启动时生成的密码，继续你的安排。</p><TextField className="field" name="password" type="password" isRequired><Label>访问密码</Label><Input fullWidth autoComplete="current-password" autoFocus placeholder="输入访问密码" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} maxLength={300} /></TextField>{error && <Notice>{error}</Notice>}<Button fullWidth type="submit" isPending={busy} isDisabled={!password}>进入工作空间<Glyph name="arrow" /></Button><div className="access-help"><Glyph name="shield" size={16} /><p>密码可在启动日志中查看，或通过<br /><code>BARKER_PASSWORD</code> 自行设置。</p></div></form><span className="access-copyright">Barker · 为每一个重要时刻</span></section>
  </main>;
}
