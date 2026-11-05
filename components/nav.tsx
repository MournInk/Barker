"use client";

import { Button, Dropdown, Label, Modal } from "@heroui/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Glyph, type IconName } from "./icons";
import { IconButton } from "./primitives";
import { useWorkspace } from "./workspace-context";
import { errorMessage } from "@/lib/ui";

const navigation: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/", label: "工作概览", icon: "squares" },
  { href: "/tasks", label: "所有提醒", icon: "calendar" },
  { href: "/deliveries", label: "投递记录", icon: "send" },
  { href: "/settings", label: "推送设置", icon: "gear" },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { dashboard, error, refresh, openTask, logout, notify } = useWorkspace();
  const [mobileOpen, setMobileOpen] = useState(false);
  const current = navigation.find((item) => item.href === path)?.label ?? "工作空间";
  const sidebar = <>
    <Link href="/" className="brand" onClick={() => setMobileOpen(false)} aria-label="Barker 工作概览"><span className="brand-mark"><Glyph name="bell" size={22} /></span><span>barker<span className="brand-period">.</span></span></Link>
    <Button className="sidebar-create" variant="outline" onPress={() => { setMobileOpen(false); openTask(); }}><Glyph name="plus" />新建提醒</Button>
    <p className="nav-section">我的工作空间</p>
    <nav aria-label="主导航">{navigation.map((item) => <Link href={item.href} key={item.href} className={`nav-item ${path === item.href ? "selected" : ""}`} aria-current={path === item.href ? "page" : undefined} onClick={() => setMobileOpen(false)}><Glyph name={item.icon} /><span>{item.label}</span>{item.href === "/tasks" && !!dashboard?.stats.active && <span className="nav-count">{dashboard.stats.active}</span>}{item.href === "/deliveries" && !!dashboard?.deliveries.retrying && <span className="nav-count caution">{dashboard.deliveries.retrying}</span>}</Link>)}</nav>
    <div className="sidebar-bottom"><div className="sidebar-note"><Glyph name="shield" size={22} /><h3>重要的事，不会遗漏</h3><p>提醒持久保存，失败自动重试。<br />让你安心专注当下。</p></div>
      <Dropdown><Button variant="ghost" className="account-button"><span className="account-avatar">B</span><span className="account-label">个人工作空间<small>安全访问已开启</small></span><Glyph name="chevronDown" size={14} /></Button><Dropdown.Popover className="account-menu"><Dropdown.Menu onAction={(key) => { setMobileOpen(false); if (key === "settings") router.push("/settings"); if (key === "logout") void logout().catch((error) => notify(errorMessage(error), "error")); }}><Dropdown.Item id="settings" textValue="推送设置"><Glyph name="gear" /><Label>推送设置</Label></Dropdown.Item><Dropdown.Item id="logout" textValue="退出工作空间"><Glyph name="logout" /><Label>退出工作空间</Label></Dropdown.Item></Dropdown.Menu></Dropdown.Popover></Dropdown>
    </div>
  </>;
  return <div className="app-layout">
    <a href="#main" className="skip-link">跳转到主要内容</a>
    <aside className="sidebar">{sidebar}</aside>
    <div className="main-layout"><header className="topbar"><div className="breadcrumb"><span className="mobile-toggle"><IconButton icon="menu" label="打开导航" onPress={() => setMobileOpen(true)} /></span><span className="breadcrumb-root">工作空间</span><Glyph name="chevron" size={12} /><span>{current}</span></div><div className="topbar-trailing"><span className={`sync-status ${error ? "offline" : ""}`}><span className="status-dot" />{error ? "同步中断" : dashboard ? "自动同步中" : "正在连接"}</span><span className="timezone">UTC +08:00</span><IconButton icon="refresh" label="刷新工作空间" onPress={() => void refresh()} /></div></header>
      <main id="main" className="workspace-main">{children}</main><footer className="workspace-footer"><span>留给生活更多从容。</span><span>Barker <span className="footer-dot" /> 按北京时间调度</span></footer>
    </div>
    <Modal.Backdrop isOpen={mobileOpen} onOpenChange={setMobileOpen}><Modal.Container placement="top" size="sm"><Modal.Dialog className="mobile-nav-dialog"><div className="mobile-nav-heading"><Modal.Heading>工作空间</Modal.Heading><IconButton icon="close" label="关闭导航" onPress={() => setMobileOpen(false)} /></div><div className="mobile-nav-content">{sidebar}</div></Modal.Dialog></Modal.Container></Modal.Backdrop>
  </div>;
}
