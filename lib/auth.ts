import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiTokenValid, auditEvent, passwordOverride, persistSession, removeSession, revokeOtherPasswordSessions, saveApiToken, savePasswordOverride, sessionExists } from "./db";
import { DomainError } from "./errors";
import { initializeStorage, privateFile, runtimeDataDir } from "./storage";
import { registerLogSecret } from "./logging";

const AUTH_COOKIE = "barker_session";
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
/** A shorter secret is guessable enough to forge session cookies / log in. */
const MIN_SECRET_LENGTH = 16;
export const MAX_SECRET_LENGTH = 300;
let generatedPassword = false;

function readSecretFile(path: string): string {
  try {
    return readFileSync(/* turbopackIgnore: true */ path, "utf8").trim();
  } catch {
    return "";
  }
}

function loadOrCreateSecret(name: string, configuredValue?: string): string {
  const configured = configuredValue?.trim();
  if (configured) {
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new Error(`Barker secret ${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (configured.length > MAX_SECRET_LENGTH) throw new Error(`Barker secret ${name} must be at most ${MAX_SECRET_LENGTH} characters`);
    return configured;
  }

  const path = join(/* turbopackIgnore: true */ runtimeDataDir, name);
  privateFile(path);
  const existing = readSecretFile(path);
  if (existing.length > MAX_SECRET_LENGTH) throw new Error(`Barker secret ${name} must be at most ${MAX_SECRET_LENGTH} characters`);
  if (existing.length >= MIN_SECRET_LENGTH) return existing;
  if (existsSync(/* turbopackIgnore: true */ path)) {
    // Fail fast instead of silently accepting an empty/truncated secret (an empty
    // session secret lets anyone forge a valid cookie, an empty password lets
    // anyone log in). A crash during first write is the realistic cause.
    throw new Error(
      `Barker secret file ${path} is empty or too short. Delete it and restart to regenerate a fresh secret.`,
    );
  }

  const generated = randomBytes(32).toString("base64url");
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${generated}\n`, { mode: 0o600, flag: "wx" });
  try {
    // link() is atomic create-if-absent: concurrent workers all agree on the
    // winner instead of each keeping its own secret.
    linkSync(temporary, path);
    if (name === "access-password.txt") generatedPassword = true;
  } catch {
    const winner = readSecretFile(path);
    if (winner.length < MIN_SECRET_LENGTH || winner.length > MAX_SECRET_LENGTH) {
      throw new Error(`Unable to persist Barker secret ${name}`);
    }
    return winner;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // best effort cleanup of the temporary file
    }
  }
  return generated;
}

let runtimePassword = "";
let sessionSecret = "";
let passwordFingerprint = "";
let initialized = false;
let credential: { hash: string; salt: string } | null = null;

export function initializeAuth(): void {
  if (initialized) { refreshCredential(); return; }
  initializeStorage();
  runtimePassword = loadOrCreateSecret("access-password.txt", process.env.BARKER_PASSWORD);
  sessionSecret = loadOrCreateSecret("session-secret.txt", process.env.BARKER_SESSION_SECRET);
  registerLogSecret(runtimePassword);
  registerLogSecret(sessionSecret);
  initialized = true;
  refreshCredential();
}

function refreshCredential(): void {
  const raw = passwordOverride();
  const override = raw ? JSON.parse(raw) as { source: string; hash: string; salt: string } : null;
  const source = createHmac("sha256", sessionSecret).update(runtimePassword).digest("hex");
  credential = override?.source === source ? override : null;
  const nextFingerprint = createHmac("sha256", sessionSecret).update(credential?.hash ?? runtimePassword).digest("hex");
  if (nextFingerprint !== passwordFingerprint) {
    passwordFingerprint = nextFingerprint;
    revokeOtherPasswordSessions(passwordFingerprint);
  }
}
let passwordPrinted = false;
const failedLogins = new Map<string, { count: number; firstFailureAt: number; lockedUntil: number }>();
const FAILED_LOGIN_WINDOW_MS = 10 * 60_000;
const FAILED_LOGIN_LOCKOUT_MS = 10 * 60_000;
// With BARKER_TRUST_PROXY an attacker can rotate client keys freely, so keep the
// in-memory limiter bounded instead of letting it grow with every new address.
const MAX_FAILED_LOGIN_ENTRIES = 1000;
let globalFailures = { count: 0, firstFailureAt: 0, lockedUntil: 0 };

function pruneFailedLogins(now: number): void {
  // Drop clients whose failure window and lockout have both expired.
  for (const [clientKey, state] of failedLogins) {
    if (now - state.firstFailureAt >= FAILED_LOGIN_WINDOW_MS && state.lockedUntil <= now) failedLogins.delete(clientKey);
  }
  const overflow = failedLogins.size - MAX_FAILED_LOGIN_ENTRIES;
  if (overflow <= 0) return;
  // Then evict the oldest windows (preferring long-dead clients) until back under the cap.
  const oldestKeys = [...failedLogins]
    .sort(([, left], [, right]) => left.firstFailureAt - right.firstFailureAt)
    .slice(0, overflow)
    .map(([clientKey]) => clientKey);
  for (const clientKey of oldestKeys) failedLogins.delete(clientKey);
}

function sign(value: string): string {
  initializeAuth();
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

export function getAuthCookieName(): string {
  return AUTH_COOKIE;
}

export function printRuntimePassword(): void {
  initializeAuth();
  if (passwordPrinted || !generatedPassword) return;
  passwordPrinted = true;
  console.info(`\n🔐 Barker access password: ${runtimePassword}\n`);
  console.info("Set BARKER_PASSWORD to use your own password.\n");
}

export function authConfigurationReady(): boolean {
  initializeAuth();
  return runtimePassword.length >= MIN_SECRET_LENGTH && sessionSecret.length >= MIN_SECRET_LENGTH;
}

export function verifyPassword(candidate: string, now = Date.now(), clientKey = "local"): boolean {
  initializeAuth();
  if (loginRetryAfter(clientKey, now) > 0) return false;
  const state = failedLogins.get(clientKey);
  const candidateDigest = credential ? scryptSync(candidate, credential.salt, 32) : createHmac("sha256", sessionSecret).update(candidate).digest();
  const expectedDigest = credential ? Buffer.from(credential.hash, "hex") : createHmac("sha256", sessionSecret).update(runtimePassword).digest();
  const matches = timingSafeEqual(candidateDigest, expectedDigest);
  if (matches) {
    failedLogins.delete(clientKey);
    return true;
  }
  if (state && state.lockedUntil > now) return false;
  const activeWindow = state && now - state.firstFailureAt < FAILED_LOGIN_WINDOW_MS ? state : { count: 0, firstFailureAt: now, lockedUntil: 0 };
  activeWindow.count += 1;
  if (activeWindow.count >= 5) {
    activeWindow.lockedUntil = now + FAILED_LOGIN_LOCKOUT_MS;
    activeWindow.count = 0;
  }
  failedLogins.set(clientKey, activeWindow);
  if (now - globalFailures.firstFailureAt >= FAILED_LOGIN_WINDOW_MS) globalFailures = { count: 0, firstFailureAt: now, lockedUntil: 0 };
  globalFailures.count += 1;
  if (globalFailures.count >= MAX_FAILED_LOGIN_ENTRIES) globalFailures.lockedUntil = now + FAILED_LOGIN_LOCKOUT_MS;
  pruneFailedLogins(now);
  return false;
}

export function loginRetryAfter(clientKey: string, now = Date.now()): number {
  const until = Math.max(failedLogins.get(clientKey)?.lockedUntil ?? 0, globalFailures.lockedUntil);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function createSessionToken(now = Date.now()): string {
  initializeAuth();
  const id = randomUUID();
  const exp = now + SESSION_DURATION_SECONDS * 1000;
  persistSession(id, exp, passwordFingerprint, now);
  auditEvent("session.create", id);
  const payload = Buffer.from(JSON.stringify({ id, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function isValidSessionToken(token: string | null | undefined, now = Date.now()): boolean {
  if (!token || token.length > 1024) return false;
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length) return false;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  let decoded: { id?: string; exp?: number } | null;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof decoded; }
  catch { return false; }
  return Boolean(decoded && typeof decoded.id === "string" && typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
    && decoded.exp > now && sessionExists(decoded.id, passwordFingerprint, now));
}

export function revokeSessionToken(token: string | null): void {
  if (!isValidSessionToken(token)) return;
  const decoded = JSON.parse(Buffer.from(token!.split(".")[0], "base64url").toString("utf8")) as { id: string };
  removeSession(decoded.id);
  auditEvent("session.logout", decoded.id);
}

export function getCookieValue(header: string | null, name = AUTH_COOKIE): string | null {
  if (!header) return null;
  for (const cookie of header.split(";")) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function requestIsAuthorized(request: Request): boolean {
  const bearer = request.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const value = bearer.slice(7);
    if (value.length > 128) return false;
    return apiTokenValid(createHash("sha256").update(value).digest("hex"), !["GET", "HEAD"].includes(request.method));
  }
  return isValidSessionToken(getCookieValue(request.headers.get("cookie")));
}

export function changePassword(current: string, next: string, clientKey: string): void {
  if (next.length < MIN_SECRET_LENGTH || next.length > MAX_SECRET_LENGTH || next.trim() !== next) throw new DomainError("新密码应为 16–300 字符且不能有首尾空格");
  if (!verifyPassword(current, Date.now(), clientKey)) throw new DomainError("当前密码错误或尝试次数过多", loginRetryAfter(clientKey) ? 429 : 403);
  const salt = randomBytes(32).toString("hex");
  savePasswordOverride(JSON.stringify({ source: createHmac("sha256", sessionSecret).update(runtimePassword).digest("hex"), salt, hash: scryptSync(next, salt, 32).toString("hex") }));
  registerLogSecret(next);
  refreshCredential();
}

export function createApiToken(name: string, scope: "read" | "write", days: number): string {
  const token = randomBytes(32).toString("base64url");
  saveApiToken(randomUUID(), name, createHash("sha256").update(token).digest("hex"), scope, Date.now() + days * 86_400_000);
  return token;
}

export function trustsProxyHeaders(): boolean {
  const value = process.env.BARKER_TRUST_PROXY?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function clientKeyFor(request: Request): string {
  if (trustsProxyHeaders()) {
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return "local";
}

export function requestUsesHttps(request: Request): boolean {
  // `request.url` is built by Next from x-forwarded-proto, i.e. attacker-spoofable,
  // so never derive Secure-cookie decisions from it. Only an explicitly trusted
  // proxy (or the BARKER_COOKIE_SECURE override) may claim HTTPS.
  const forced = process.env.BARKER_COOKIE_SECURE?.trim().toLowerCase();
  if (forced === "1" || forced === "true" || forced === "yes") return true;
  if (!trustsProxyHeaders()) return false;
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https";
}

export function setSessionCookie(token: string, isHttps = false): string {
  const secure = isHttps ? "; Secure" : "";
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_SECONDS}${secure}`;
}

export function clearSessionCookie(isHttps = false): string {
  const secure = isHttps ? "; Secure" : "";
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function __failedLoginsSizeForTests(): number {
  return failedLogins.size;
}

export function __pruneFailedLoginsForTests(now: number): number {
  pruneFailedLogins(now);
  return failedLogins.size;
}
