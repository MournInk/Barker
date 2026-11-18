import { redactSecrets } from "./errors";

const secrets = new Set<string>();

export function registerLogSecret(value: string): void {
  if (value) secrets.add(value);
}

export function logError(event: string, error: unknown, context: Record<string, string | number> = {}): void {
  const detail = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack, code: "code" in error ? error.code : undefined }
    : { message: String(error) };
  console.error(redactSecrets(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event, ...context, ...detail }), [...secrets], 8192));
}
