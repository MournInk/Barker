import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Barker · 可靠的 Bark 定时推送",
  description: "按 cron 周期将提醒可靠推送到自建 Bark API — 指数退避无限重试，绝不丢弃。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
