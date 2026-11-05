import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Fail the build rather than package runtime state or credentials. */
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (/^\.env(?:\.|$)|^barker\.sqlite(?:-|$)|^(?:access-password|session-secret)\.txt$/.test(entry.name)) {
      throw new Error(`Runtime data must not be included in standalone output: ${path}`);
    }
    if (entry.isDirectory()) inspect(path);
  }
}

inspect(".next/standalone");
console.log("Standalone output contains no runtime database, credential files or .env files.");
