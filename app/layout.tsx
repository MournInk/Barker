import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { Workspace } from "@/components/workspace";
import "@fontsource-variable/manrope";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Barker · 让重要的事，如约而至", template: "%s · Barker" },
  description: "一个持久记录投递状态的 Bark 提醒工作空间。安排周期任务，追踪每次尝试并按策略重试。",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return <html lang="zh-CN"><body><Workspace>{children}</Workspace></body></html>;
}
