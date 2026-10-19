const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ spawnSync }, { pathToFileURL }] = await Promise.all([
    dynamicImport("node:child_process") as Promise<typeof import("node:child_process")>,
    dynamicImport("node:url") as Promise<typeof import("node:url")>,
  ]);
  const emitted = spawnSync(process.execPath, ["scripts/emit-node-runtime.mjs"], { stdio: "inherit" });
  if (emitted.status !== 0) throw new Error("Unable to prepare the Barker Node.js runtime");
  const { register } = await dynamicImport(pathToFileURL(`${process.cwd()}/.barker-node/register.js`).href) as { register: () => Promise<void> };
  await register();
}
