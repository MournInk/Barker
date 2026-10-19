export async function register(): Promise<void> {
  const [{ printRuntimePassword }, { startScheduler }] = await Promise.all([
    import("./lib/auth"),
    import("./lib/scheduler"),
  ]);
  printRuntimePassword();
  startScheduler();
}
