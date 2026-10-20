"use client";

import { Bell, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/ui";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "概览" },
  { href: "/tasks", label: "任务" },
  { href: "/settings", label: "设置" },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

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
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4 sm:px-6">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Barker 首页"
          >
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
              <Bell className="size-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight max-[380px]:hidden">Barker</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">北京时间 · 可靠提醒</span>
          </Link>

          <nav aria-label="主导航" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:gap-1">
            {NAV.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-2 text-sm whitespace-nowrap outline-none transition-colors sm:px-3 sm:py-1.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    active
                      ? "bg-secondary font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void signOut()}
            aria-label="退出登录"
            className="shrink-0 gap-2 text-muted-foreground hover:text-foreground"
          >
            <LogOut className="size-4" />
            <span className="hidden sm:inline">退出登录</span>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
