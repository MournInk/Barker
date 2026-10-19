export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ printRuntimePassword }, { startScheduler }] = await Promise.all([
    import("./lib/auth"),
    import("./lib/scheduler"),
  ]);
  printRuntimePassword();
  startScheduler();
}
