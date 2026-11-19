import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Resolve before Next's standalone entry changes cwd. Shell settings win. */
export function loadRuntimeEnvironment(directory = process.cwd()) {
  for (const name of [".env.production.local", ".env.local", ".env.production", ".env"]) {
    const file = resolve(directory, name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function runtimeDirectory(directory = process.cwd(), configured = process.env.BARKER_DATA_DIR) {
  const data = resolve(directory, configured || "data");
  if (data.split(sep).includes(".next")) throw new Error("BARKER_DATA_DIR must be outside .next; builds remove that directory");
  return data;
}

export function checkLegacyData(directory = process.cwd()) {
  const legacy = resolve(directory, ".next/standalone/data/barker.sqlite");
  if (existsSync(legacy)) {
    throw new Error(`Legacy runtime database found at ${legacy}. Stop the old server and run pnpm data:backup <new-backup-dir> .next/standalone/data, then pnpm data:restore <new-dir-outside-.next> <new-backup-dir> from the project root. Move the old data directory out of .next before building.`);
  }
}
