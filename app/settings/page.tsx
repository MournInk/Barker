"use client";

import { Check, Send } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Gate } from "@/components/gate";
import { Shell } from "@/components/nav";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BarkSettings } from "@/lib/types";
import { api } from "@/lib/ui";

type SettingsPayload = {
  settings: Omit<BarkSettings, "deviceKey">;
  deviceKeyConfigured: boolean;
  dataDir: string;
};

type SettingsPageData = { authenticated: boolean; payload: SettingsPayload | null };

async function fetchSettingsPage(): Promise<SettingsPageData> {
  const session = await api<{ authenticated: boolean }>("/api/session");
  if (!session.authenticated) return { authenticated: false, payload: null };
  return { authenticated: true, payload: await api<SettingsPayload>("/api/settings") };
}

export default function SettingsPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<BarkSettings>({
    endpoint: "https://api.day.app",
    deviceKey: "",
    title: "Barker 提醒",
    sound: "1107",
    group: "Barker",
    icon: "",
  });
  const [configured, setConfigured] = useState(false);
  const [dataDir, setDataDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const apply = useCallback((page: SettingsPageData) => {
    const payload = page.payload;
    setAuthed(page.authenticated);
    if (!payload) return;
    setSettings((cur) => ({ ...cur, ...payload.settings, deviceKey: "" }));
    setConfigured(payload.deviceKeyConfigured);
    setDataDir(payload.dataDir);
  }, []);

  const load = useCallback(async () => { apply(await fetchSettingsPage()); }, [apply]);

  useEffect(() => {
    let alive = true;
    void fetchSettingsPage().then(
      (page) => { if (alive) apply(page); },
      (err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "无法加载"); },
    );
    return () => { alive = false; };
  }, [apply]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSettings((cur) => ({ ...cur, deviceKey: "" }));
      setMessage("Bark 配置已保存");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setError(""); setMessage("");
    try { await api("/api/settings/test", { method: "POST", body: "{}" }); setMessage("测试推送已发出，请查看 Bark"); }
    catch (err) { setError(err instanceof Error ? err.message : "测试失败"); }
    finally { setBusy(false); }
  }

  if (authed === null) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4">
        <p className="text-sm text-muted-foreground">正在确认访问权限…</p>
      </div>
    );
  }
  if (!authed) return <Gate onAuthed={() => void load()} />;

  const sqlitePath = dataDir ? `${dataDir.replace(/\/+$/, "")}/barker.sqlite` : "—";

  return (
    <Shell>
      <div className="space-y-6">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">设置</h1>
            <Badge variant={configured ? "success" : "secondary"}>
              {configured ? "已配置" : "未配置"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">配置自建 Bark API。Device Key 留空表示保持不变。</p>
        </div>

        {message && (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <form onSubmit={save}>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Bark</CardTitle>
                <CardDescription>推送到自建 Bark API。Device Key 仅保存在服务端，不会回显。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="endpoint">API 地址</Label>
                  <Input
                    id="endpoint"
                    value={settings.endpoint}
                    onChange={(e) => setSettings({ ...settings, endpoint: e.target.value })}
                    required
                    placeholder="https://api.day.app"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="deviceKey">Device Key</Label>
                  <Input
                    id="deviceKey"
                    type="password"
                    value={settings.deviceKey}
                    placeholder={configured ? "••••••••（留空保持不变）" : "粘贴 Bark Device Key"}
                    onChange={(e) => setSettings({ ...settings, deviceKey: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {configured ? "已保存 Device Key；留空提交则保持不变。" : "尚未保存 Device Key，保存后才能测试推送。"}
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="title">默认标题</Label>
                    <Input
                      id="title"
                      value={settings.title}
                      onChange={(e) => setSettings({ ...settings, title: e.target.value })}
                      required
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="sound">提示音</Label>
                    <Input
                      id="sound"
                      value={settings.sound}
                      onChange={(e) => setSettings({ ...settings, sound: e.target.value })}
                      placeholder="如：1107"
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="group">分组</Label>
                    <Input
                      id="group"
                      value={settings.group}
                      onChange={(e) => setSettings({ ...settings, group: e.target.value })}
                      placeholder="Barker"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="icon">图标 URL</Label>
                    <Input
                      id="icon"
                      value={settings.icon}
                      onChange={(e) => setSettings({ ...settings, icon: e.target.value })}
                      placeholder="https://…（可空）"
                    />
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex-wrap justify-end gap-2">
                <p className="mr-auto text-xs text-muted-foreground">保存后可点“发送测试”验证推送链路是否通畅。</p>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void test()}>
                  <Send /> 发送测试
                </Button>
                <Button type="submit" disabled={busy}>
                  <Check /> 保存配置
                </Button>
              </CardFooter>
            </Card>
          </form>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>安全</CardTitle>
                <CardDescription>代理与会话</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm leading-6 text-muted-foreground">
                <p>
                  直连公网时不要启用 <code className="font-mono text-foreground">BARKER_TRUST_PROXY</code>
                  ，否则客户端可伪造 <code className="font-mono text-foreground">X-Forwarded-*</code> 绕过限流。
                </p>
                <p>
                  会话为 <code className="font-mono text-foreground">HttpOnly + SameSite=Lax</code>，有效期 12 小时。
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>数据</CardTitle>
                <CardDescription>持久化</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm leading-6 text-muted-foreground">
                <p>任务与推送队列持久化于（WAL）：</p>
                <code className="block break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground/80">
                  {sqlitePath}
                </code>
                <p>
                  备份时一并拷贝 <code className="font-mono text-foreground">.sqlite-wal/.sqlite-shm</code>。
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </Shell>
  );
}
