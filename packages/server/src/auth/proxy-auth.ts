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
  /** When true, GET routes also require auth. Default true when enabled. */
  required_for_read?: boolean;
}

const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 1 week
const SESSION_COOKIE = "tai_session";

export function makeProxyAuthMiddleware(config: ProxyAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!config.enabled) return next();
    if (!config.password) {
      // Misconfiguration — fail closed.
      return c.json({ error: "proxyAuth enabled but no password configured" }, 500);
    }

    // 1. Bearer token: direct password compare.
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const presented = authHeader.slice(7);
      if (constantTimeEquals(presented, config.password)) {
        return next();
      }
    }

    // 2. Session cookie: HMAC-verified blob.
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie && verifySessionToken(cookie, config.password)) {
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
