import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Workspace } from "@/components/workspace";
import "@fontsource-variable/manrope";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Barker · 让重要的事，如约而至", template: "%s · Barker" },
  description: "一个安静、可靠的 Bark 提醒工作空间。安排周期任务，追踪每次投递，失败持续重试。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body><Workspace>{children}</Workspace></body></html>;
}
