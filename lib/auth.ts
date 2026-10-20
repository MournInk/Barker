import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const AUTH_COOKIE = "barker_session";
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
/** A shorter secret is guessable enough to forge session cookies / log in. */
const MIN_SECRET_LENGTH = 16;
const dataDir = resolve(process.env.BARKER_DATA_DIR || "./data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

function readSecretFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
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
    return configured;
  }

  const path = join(dataDir, name);
  const existing = readSecretFile(path);
  if (existing.length >= MIN_SECRET_LENGTH) return existing;
  if (existsSync(path)) {
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
  } catch {
    const winner = readSecretFile(path);
    if (winner.length < MIN_SECRET_LENGTH) {
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

const runtimePassword = loadOrCreateSecret("access-password.txt", process.env.BARKER_PASSWORD);
const sessionSecret = loadOrCreateSecret("session-secret.txt", process.env.BARKER_SESSION_SECRET);
let passwordPrinted = false;
const failedLogins = new Map<string, { count: number; firstFailureAt: number; lockedUntil: number }>();
const FAILED_LOGIN_WINDOW_MS = 10 * 60_000;
const FAILED_LOGIN_LOCKOUT_MS = 10 * 60_000;
// With BARKER_TRUST_PROXY an attacker can rotate client keys freely, so keep the
// in-memory limiter bounded instead of letting it grow with every new address.
const MAX_FAILED_LOGIN_ENTRIES = 1000;

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
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

export function getAuthCookieName(): string {
  return AUTH_COOKIE;
}

export function printRuntimePassword(): void {
  if (passwordPrinted || process.env.BARKER_PASSWORD?.trim()) return;
  passwordPrinted = true;
  console.info(`\n🔐 Barker access password: ${runtimePassword}\n`);
  console.info("Set BARKER_PASSWORD to use your own password.\n");
}

export function verifyPassword(candidate: string, now = Date.now(), clientKey = "local"): boolean {
  const state = failedLogins.get(clientKey);
  if (state && state.lockedUntil > now) return false;
  const candidateDigest = createHmac("sha256", sessionSecret).update(candidate).digest();
  const expectedDigest = createHmac("sha256", sessionSecret).update(runtimePassword).digest();
  const matches = timingSafeEqual(candidateDigest, expectedDigest);
  if (matches) {
    failedLogins.delete(clientKey);
    return true;
  }
  const activeWindow = state && now - state.firstFailureAt < FAILED_LOGIN_WINDOW_MS ? state : { count: 0, firstFailureAt: now, lockedUntil: 0 };
  activeWindow.count += 1;
  if (activeWindow.count >= 5) {
    activeWindow.lockedUntil = now + FAILED_LOGIN_LOCKOUT_MS;
    activeWindow.count = 0;
  }
  failedLogins.set(clientKey, activeWindow);
  pruneFailedLogins(now);
  return false;
}

export function createSessionToken(now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_DURATION_SECONDS * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function isValidSessionToken(token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length) return false;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof decoded.exp === "number" && decoded.exp > now;
  } catch {
    return false;
  }
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
  return isValidSessionToken(getCookieValue(request.headers.get("cookie")));
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
