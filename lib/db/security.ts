import { randomUUID } from "node:crypto";
import { DomainError } from "../errors";
import { statement, transaction } from "./core";

const authState = globalThis as typeof globalThis & { barkerPasswordRevision?: number };

export function passwordRevision(): number { return authState.barkerPasswordRevision ?? 0; }

export function auditEvent(action: string, target: string): void {
  statement("INSERT INTO audit_events (id, action, target, created_at) VALUES (?, ?, ?, ?)").run(randomUUID(), action, target, new Date().toISOString());
  statement("DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events ORDER BY created_at DESC LIMIT -1 OFFSET 10000)").run();
}

export function listAuditEvents(): Array<{ id: string; action: string; target: string; createdAt: string }> {
  return statement("SELECT id, action, target, created_at createdAt FROM audit_events ORDER BY created_at DESC LIMIT 100").all() as ReturnType<typeof listAuditEvents>;
}

export function persistSession(id: string, expiresAt: number, fingerprint: string, now: number): void {
  transaction(() => {
    statement("DELETE FROM sessions WHERE expires_at <= ? OR fingerprint != ?").run(now, fingerprint);
    statement("INSERT INTO sessions (id, expires_at, fingerprint) VALUES (?, ?, ?)").run(id, expiresAt, fingerprint);
  });
}

export function sessionExists(id: string, fingerprint: string, now: number): boolean {
  return Boolean(statement("SELECT 1 FROM sessions WHERE id = ? AND fingerprint = ? AND expires_at > ?").get(id, fingerprint, now));
}

export function revokeOtherPasswordSessions(fingerprint: string): void {
  statement("DELETE FROM sessions WHERE fingerprint != ?").run(fingerprint);
}

export function removeSession(id: string): void { statement("DELETE FROM sessions WHERE id = ?").run(id); }

export function securityState(): { sessions: Array<{ id: string; expiresAt: number }>; tokens: Array<{ id: string; name: string; scope: string; expiresAt: number; createdAt: number }> } {
  return {
    sessions: statement("SELECT id, expires_at expiresAt FROM sessions WHERE expires_at > ? ORDER BY expires_at DESC").all(Date.now()) as ReturnType<typeof securityState>["sessions"],
    tokens: statement("SELECT id, name, scope, expires_at expiresAt, created_at createdAt FROM api_tokens WHERE expires_at > ? ORDER BY created_at DESC").all(Date.now()) as ReturnType<typeof securityState>["tokens"],
  };
}

export function passwordOverride(): string | null {
  return (statement("SELECT value FROM settings WHERE key = 'password_override'").get() as { value: string } | undefined)?.value ?? null;
}

export function savePasswordOverride(value: string): void {
  transaction(() => {
    statement("INSERT OR REPLACE INTO settings (key, value) VALUES ('password_override', ?)").run(value);
    statement("DELETE FROM sessions").run();
    statement("DELETE FROM api_tokens").run();
    auditEvent("security.password.change", "all-sessions-and-tokens");
  });
  authState.barkerPasswordRevision = passwordRevision() + 1;
}

export function saveApiToken(id: string, name: string, digest: string, scope: string, expiresAt: number): void {
  transaction(() => {
    statement("DELETE FROM api_tokens WHERE expires_at <= ?").run(Date.now());
    if ((statement("SELECT COUNT(*) total FROM api_tokens").get() as { total: number }).total >= 100) throw new DomainError("最多创建 100 个访问凭据", 409);
    statement("INSERT INTO api_tokens VALUES (?, ?, ?, ?, ?, ?)").run(id, name, digest, scope, expiresAt, Date.now());
    auditEvent("security.token.create", id);
  });
}

export function apiTokenValid(digest: string, write: boolean): boolean {
  return Boolean(statement("SELECT 1 FROM api_tokens WHERE digest = ? AND expires_at > ? AND (scope = 'write' OR ? = 0)").get(digest, Date.now(), Number(write)));
}

export function revokeCredential(id: string, kind: "session" | "token"): void {
  transaction(() => {
    statement(`DELETE FROM ${kind === "session" ? "sessions" : "api_tokens"} WHERE id = ?`).run(id);
    auditEvent(`security.${kind}.revoke`, id);
  });
}
