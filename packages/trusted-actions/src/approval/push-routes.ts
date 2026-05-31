import type { Context } from "hono";
import { getDb } from "../db/schema.js";
import type { PushSubscription } from "./push.js";

/**
 * Persistent push-subscription store, backed by the `push_subscriptions`
 * table. Survives restart so users don't have to re-subscribe every
 * time the executor bounces.
 */

export type SubStatus = "pending" | "active" | "rejected";

export interface SubscriptionRow extends PushSubscription {
  status: SubStatus;
  userAgent: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export function storeSubscription(subscription: PushSubscription, meta: { userAgent?: string | null } = {}): void {
  const db = getDb();
  // Idempotent upsert keyed by endpoint (the unique identifier from
  // the user agent's push manager). Re-subscribing with the same
  // endpoint preserves any prior status (e.g. if you previously
  // approved a device, it stays approved when it re-subscribes after
  // a reinstall).
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = COALESCE(excluded.user_agent, push_subscriptions.user_agent)`,
  ).run(subscription.endpoint, subscription.p256dh, subscription.auth, meta.userAgent ?? null);
}

/**
 * Active-only — used by the push fan-out. Rejected and pending devices
 * never receive approval pushes.
 */
export function listSubscriptions(): PushSubscription[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE status = 'active'`)
    .all() as PushSubscription[];
  return rows;
}

/** Admin view — every row, every status. Sorted newest first. */
export function listAllSubscriptions(): SubscriptionRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT endpoint, p256dh, auth, status, user_agent, created_at, decided_at
       FROM push_subscriptions
       ORDER BY created_at DESC`,
    )
    .all() as Array<{
    endpoint: string;
    p256dh: string;
    auth: string;
    status: SubStatus;
    user_agent: string | null;
    created_at: string;
    decided_at: string | null;
  }>;
  return rows.map((r) => ({
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    status: r.status,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }));
}

export function setSubscriptionStatus(endpoint: string, status: SubStatus): boolean {
  const db = getDb();
  const r = db
    .prepare(`UPDATE push_subscriptions SET status = ?, decided_at = datetime('now') WHERE endpoint = ?`)
    .run(status, endpoint);
  return r.changes > 0;
}

export function getSubscriptionStatus(endpoint: string): SubStatus | null {
  const db = getDb();
  const row = db.prepare(`SELECT status FROM push_subscriptions WHERE endpoint = ?`).get(endpoint) as
    | { status: SubStatus }
    | undefined;
  return row?.status ?? null;
}

export function deleteSubscription(endpoint: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

export function countSubscriptions(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as n FROM push_subscriptions WHERE status = 'active'`).get() as { n: number };
  return row.n;
}

/**
 * In-memory rate limit on PWA-side subscribe attempts so an attacker
 * can't spam the dashboard with pending rows. Bucket is per
 * client-ip, 5 attempts / 10 min. Reset on process restart, which is
 * acceptable for this lightweight ddos protection.
 */
const SUBSCRIBE_BUCKET = new Map<string, { count: number; resetAt: number }>();
const SUBSCRIBE_WINDOW_MS = 10 * 60 * 1000;
const SUBSCRIBE_MAX = 5;

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const entry = SUBSCRIBE_BUCKET.get(ip);
  if (!entry || entry.resetAt < now) {
    SUBSCRIBE_BUCKET.set(ip, { count: 1, resetAt: now + SUBSCRIBE_WINDOW_MS });
    return true;
  }
  if (entry.count >= SUBSCRIBE_MAX) return false;
  entry.count += 1;
  return true;
}

/**
 * Hono route: POST /internal/push/subscribe (TAI-side) and
 *             POST /push/subscribe (PWA-side, behind same-origin).
 *
 * New subscriptions arrive in status `pending` and never receive
 * pushes until an operator approves them via the TAI dashboard.
 * Internal calls from TAI (authenticated by the /internal/* shared
 * secret middleware) auto-approve since they're trusted.
 */
export async function handlePushSubscribe(c: Context): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  const isInternal = path.startsWith("/internal/");

  if (!isInternal) {
    // PWA path — rate-limit by client IP.
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0].trim() || "unknown";
    if (!rateLimitOk(ip)) {
      return c.json({ error: "Too many subscribe attempts. Try again in 10 minutes." }, 429);
    }
  }

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: "Missing required fields: endpoint, keys.p256dh, keys.auth" }, 400);
  }

  const userAgent = c.req.header("User-Agent") || null;
  storeSubscription(
    {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    },
    { userAgent },
  );

  // Internal calls auto-approve. PWA calls stay pending.
  if (isInternal) {
    setSubscriptionStatus(body.endpoint, "active");
  }

  return c.json(
    {
      stored: true,
      status: isInternal ? "active" : (getSubscriptionStatus(body.endpoint) ?? "pending"),
    },
    201,
  );
}

/**
 * Hono route: DELETE /push/subscribe — invoked by the PWA when the
 * user disables notifications or unsubscribes.
 */
export async function handlePushUnsubscribe(c: Context): Promise<Response> {
  let body: { endpoint?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.endpoint) {
    return c.json({ error: "Missing required field: endpoint" }, 400);
  }
  deleteSubscription(body.endpoint);
  return c.json({ deleted: true });
}
