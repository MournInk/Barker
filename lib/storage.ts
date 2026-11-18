import { chmodSync, mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";

export const runtimeDataDir = resolve(/* turbopackIgnore: true */ process.env.BARKER_DATA_DIR || "./data");

/** Filesystem changes happen at runtime initialization, never on import. */
export function initializeStorage(): void {
  if (runtimeDataDir.split(sep).includes(".next")) throw new Error("BARKER_DATA_DIR must be outside .next");
  mkdirSync(runtimeDataDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDataDir, 0o700);
}

export function privateFile(path: string): void {
  try { chmodSync(/* turbopackIgnore: true */ path, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
