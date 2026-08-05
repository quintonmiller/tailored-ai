import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

/**
 * Hosted-proxy auth.
 *
 * When `enabled: true`, gates the WHOLE dashboard (including GET routes)
 * so exposing the server over the internet doesn't leak chat history,
 * tasks, or memory. The existing `server.apiKey` middleware in index.ts
 * only covers mutating methods, which is fine on LAN but not when proxied.
 *
 * Two accepted credentials:
 *   1. `Authorization: Bearer <password>` — for programmatic clients
 *      and CLI tooling. Constant-time compared against `config.password`.
 *   2. `Cookie: tai_session=<exp>.<hmac>` — for browser sessions, minted
 *      by the login endpoint after verifying the password. The HMAC is
 *      keyed by the password itself, so rotating the password invalidates
 *      every issued session. The password is NEVER embedded cleartext.
 */
export interface ProxyAuthConfig {
  enabled: boolean;
  password: string;
}

const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 1 week
export const SESSION_COOKIE = "tai_session";

/** Endpoints that must stay reachable without a session, or nobody could ever
 * get one. Matched against the concrete request path. */
export const AUTH_PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);

/**
 * Does this request carry a valid proxy-auth credential?
 *
 * Split out of the middleware so the main auth middleware in index.ts can
 * consult it as one of several accepted credentials, rather than running two
 * competing gates whose interaction nobody can predict.
 */
export function hasValidProxyAuth(
  config: ProxyAuthConfig,
  opts: { bearer: string; cookie: string | undefined },
): boolean {
  if (!config.password) return false;
  if (opts.bearer && constantTimeEquals(opts.bearer, config.password)) return true;
  return !!opts.cookie && verifySessionToken(opts.cookie, config.password);
}

/** Verify a login attempt. Separate from session minting so the caller can
 * rate-limit between the two. */
export function verifyPassword(config: ProxyAuthConfig, presented: string): boolean {
  if (!config.password || !presented) return false;
  return constantTimeEquals(presented, config.password);
}

/**
 * Failed-login throttle, per client.
 *
 * A password endpoint on an internet-facing box with no throttle is a
 * brute-force target, and this one guards every session, memory and tool
 * result the agent holds. In-memory and per-process on purpose: TAI runs as a
 * single instance (SQLite takes one writer), so there is no second replica for
 * a shared store to coordinate with.
 */
export class LoginThrottle {
  private attempts = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  /** Seconds the caller must wait, or 0 when the attempt may proceed. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.attempts.get(key);
    if (!entry) return 0;
    if (now >= entry.until) {
      this.attempts.delete(key);
      return 0;
    }
    if (entry.count < this.maxAttempts) return 0;
    return Math.ceil((entry.until - now) / 1000);
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.attempts.get(key);
    if (!entry || now >= entry.until) {
      this.attempts.set(key, { count: 1, until: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  /** A correct password clears the record, so one bad day at the keyboard
   * doesn't lock you out for the rest of the window. */
  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}

/**
 * Standalone middleware form.
 *
 * The server mounts its auth as a single gate (see index.ts) so the
 * interaction between `authToken` and `proxyAuth` is decidable in one place.
 * This is kept for embedders who want proxy auth in front of their own Hono
 * app without adopting the rest of TAI's server.
 */
export function makeProxyAuthMiddleware(config: ProxyAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!config.enabled) return next();
    if (!config.password) {
      // Misconfiguration — fail closed.
      return c.json({ error: "proxyAuth enabled but no password configured" }, 500);
    }
    if (AUTH_PUBLIC_PATHS.has(c.req.path)) return next();

    const authHeader = c.req.header("Authorization") ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (hasValidProxyAuth(config, { bearer, cookie: getCookie(c, SESSION_COOKIE) })) {
      return next();
    }

    return c.json({ error: "Unauthorized" }, 401);
  };
}

/**
 * Mint a session token. Use after the login endpoint has verified the
 * presented password. The token is `<exp>.<hmac>` (both URL-safe).
 */
export function createSessionToken(
  password: string,
  ttlSec = SESSION_TTL_SEC,
): { token: string; expiresAt: Date; cookieName: string; maxAgeSec: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = sign(String(exp), password);
  return {
    token: `${exp}.${sig}`,
    expiresAt: new Date(exp * 1000),
    cookieName: SESSION_COOKIE,
    maxAgeSec: ttlSec,
  };
}

function verifySessionToken(token: string, password: string): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return false;
  if (exp <= Math.floor(Date.now() / 1000)) return false;
  const expected = sign(expStr, password);
  return constantTimeEquals(sig, expected);
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
