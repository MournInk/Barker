"use client";

import { Bell, LayoutDashboard, ListTodo, LogOut, Menu, Settings2, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/ui";

const NAV = [
  { href: "/", label: "概览", icon: LayoutDashboard },
  { href: "/tasks", label: "任务", icon: ListTodo },
  { href: "/settings", label: "设置", icon: Settings2 },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => { setOpen(false); }, [pathname]);

  async function signOut() {
    try {
      await api("/api/session", { method: "DELETE" });
      router.push("/");
      router.refresh();
    } catch {
      // best effort
    }
  }

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar__brand">
          <span className="mark"><Bell size={18} /></span>
          <div>
            <h1>Barker</h1>
            <p>Asia/Shanghai · 可靠推送</p>
          </div>
        </div>
        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className={`nav__item ${active ? "active" : ""}`}>
                <Icon size={16} /> {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar__foot">
          <span className="chip">Bark · cron · SQLite WAL</span>
          <p className="muted">每条到期提醒落库为 delivery，失败无限重试，绝不丢弃。</p>
          <button className="ghost" style={{ justifyContent: "flex-start" }} onClick={() => void signOut()}>
            <LogOut size={16} /> 退出登录
          </button>
        </div>
      </aside>
      {open && <button className="sidebar-backdrop" aria-label="关闭菜单" onClick={() => setOpen(false)} />}

      <div className="shell-body">
        <header className="topbar">
          <div className="topbar__left">
            <button className="ghost icon-button mobile-nav-toggle" aria-label="菜单" onClick={() => setOpen((v) => !v)}>
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
            <div className="topbar__title">
              <b>Barker</b>
              <span>北京时间 · 可靠提醒</span>
            </div>
          </div>
          <div className="topbar__actions">
            <span className="chip" style={{ background: "#0a7a6314", color: "#0a7a63", borderColor: "#0a7a6328" }}>
              <Bell size={12} /> Next.js · Node 24
            </span>
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
