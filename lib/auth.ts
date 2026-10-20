import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const AUTH_COOKIE = "barker_session";
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
const dataDir = resolve(process.env.BARKER_DATA_DIR || "./data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

function loadOrCreateSecret(name: string, configuredValue?: string): string {
  if (configuredValue?.trim()) return configuredValue.trim();
  const path = join(dataDir, name);
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    const generated = randomBytes(32).toString("base64url");
    try {
      writeFileSync(path, `${generated}\n`, { mode: 0o600, flag: "wx" });
      return generated;
    } catch {
      if (existsSync(path)) return readFileSync(path, "utf8").trim();
      throw new Error(`Unable to persist Barker secret ${name}`);
    }
  }
}

const runtimePassword = loadOrCreateSecret("access-password.txt", process.env.BARKER_PASSWORD);
const sessionSecret = loadOrCreateSecret("session-secret.txt", process.env.BARKER_SESSION_SECRET);
let passwordPrinted = false;
const failedLogins = new Map<string, { count: number; firstFailureAt: number; lockedUntil: number }>();

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
  const activeWindow = state && now - state.firstFailureAt < 10 * 60_000 ? state : { count: 0, firstFailureAt: now, lockedUntil: 0 };
  activeWindow.count += 1;
  if (activeWindow.count >= 5) {
    activeWindow.lockedUntil = now + 10 * 60_000;
    activeWindow.count = 0;
  }
  failedLogins.set(clientKey, activeWindow);
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
  const forwarded = trustsProxyHeaders() ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
  const protocol = forwarded || new URL(request.url).protocol.replace(":", "");
  return protocol === "https";
}

export function setSessionCookie(token: string, isHttps = false): string {
  const secure = isHttps ? "; Secure" : "";
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_SECONDS}${secure}`;
}

export function clearSessionCookie(isHttps = false): string {
  const secure = isHttps ? "; Secure" : "";
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
