import { NextResponse } from "next/server";
import { logError } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const [{ authConfigurationReady }, { databaseIsWritable }, { schedulerHealth }] = await Promise.all([
      import("@/lib/auth"),
      import("@/lib/db"),
      import("@/lib/scheduler"),
    ]);
    if (!authConfigurationReady() || !databaseIsWritable() || !schedulerHealth()) {
      return NextResponse.json({ status: "unavailable" }, { status: 503 });
    }
    return NextResponse.json({ status: "ok" });
  } catch (error) {
    logError("health.failed", error);
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
