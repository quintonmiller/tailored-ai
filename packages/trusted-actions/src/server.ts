import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { type ActionHandler, get as getAction, listTypes } from "./actions/registry.js";
import { generateToken } from "./approval/crypto.js";
import { type PushSubscription, sendApprovalPush } from "./approval/push.js";
import {
  deleteSubscription,
  getSubscriptionStatus,
  handlePushSubscribe,
  handlePushUnsubscribe,
  listAllSubscriptions,
  listSubscriptions,
  setSubscriptionStatus,
} from "./approval/push-routes.js";
import {
  consumeApproval,
  createApproval,
  findActionByToken,
  findPendingForSubscriber,
} from "./approval/token-store.js";
import { loadVapidKeys } from "./approval/vapid-store.js";
import { writeAudit } from "./audit/log.js";
import { checkCaps, readCapsFromEnv } from "./caps/enforcer.js";
import { getDb } from "./db/schema.js";
import type { ReadAction } from "./read-actions/types.js";

const app = new Hono();

// ── Defaults ────────────────────────────────────────────────────────────────

const APPROVAL_TTL_MS = 60 * 60 * 1000; // 1h

function approvalUrlBase(): string {
  return process.env.TA_PUBLIC_BASE_URL || `http://localhost:${process.env.TA_PORT ?? "3100"}`;
}

// ── Middleware ──────────────────────────────────────────────────────────────

// TAI-to-executor auth: /internal/* requires Bearer <shared-secret>
app.use("/internal/*", async (c, next) => {
  const sharedSecret = process.env.TA_SHARED_SECRET || "";
  const auth = c.req.header("Authorization");
  if (!auth || auth !== `Bearer ${sharedSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// ── Public ──────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", actions: listTypes() }));

/**
 * Approval endpoints. The phone receives `/approve/<token>` and
 * `/reject/<token>` URLs in the push notification; tapping them lands
 * here. The token is the one-time secret, validated against the stored
 * HMAC hash. TAI never sees the cleartext token.
 */
app.post("/approve/:token", (c) => decideHandler(c, "approve"));
app.post("/reject/:token", (c) => decideHandler(c, "reject"));
// GET also works for convenience when the phone's notification action
// opens the URL directly without a POST.
app.get("/approve/:token", (c) => decideHandler(c, "approve"));
app.get("/reject/:token", (c) => decideHandler(c, "reject"));

async function decideHandler(c: import("hono").Context, decision: "approve" | "reject") {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "Missing token" }, 400);

  const db = getDb();
  const actionId = findActionByToken(db, token);
  if (!actionId) {
    writeAudit(db, {
      actor: "user",
      action: `${decision}.invalid_token`,
      context: JSON.stringify({ presented_token_prefix: token.slice(0, 8) }),
    });
    return c.json({ error: "Token not found or expired" }, 410);
  }

  const result = consumeApproval(db, actionId, token, decision);
  if (!result.error && decision === "approve") {
    db.prepare(`UPDATE actions SET status = 'approved', decided_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      actionId,
    );
    writeAudit(db, {
      actor: "user",
      action: "approve",
      context: JSON.stringify({ action_id: actionId }),
    });
    return c.json({ status: "approved", action_id: actionId });
  }
  if (!result.error && decision === "reject") {
    db.prepare(`UPDATE actions SET status = 'rejected', decided_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      actionId,
    );
    writeAudit(db, {
      actor: "user",
      action: "reject",
      context: JSON.stringify({ action_id: actionId }),
    });
    return c.json({ status: "rejected", action_id: actionId });
  }

  // Error path: expired, already consumed, or wrong token.
  writeAudit(db, {
    actor: "user",
    action: `${decision}.failed`,
    context: JSON.stringify({ action_id: actionId, error: result.error }),
  });
  return c.json({ error: result.error }, 410);
}

/**
 * Cancel a pending action without consuming a token. Used by the
 * /actions UI's Cancel button. This is the fallback path when the user
 * decides via the UI (not via push). The action moves to rejected.
 */
app.post("/actions/:id/cancel", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db.prepare("SELECT status FROM actions WHERE id = ?").get(id) as { status: string } | undefined;
  if (!row) return c.json({ error: "Action not found" }, 404);
  if (row.status !== "pending_approval") {
    return c.json({ error: `Cannot cancel action in status: ${row.status}` }, 409);
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE actions SET status = 'rejected', decided_at = ?, error = 'cancelled by user' WHERE id = ?`).run(
    now,
    id,
  );
  writeAudit(db, {
    actor: "user",
    action: "cancel",
    context: JSON.stringify({ action_id: id }),
  });
  return c.json({ status: "rejected", action_id: id });
});

/**
 * Public listing for the mobile /actions view. Filters are query params:
 *   ?status=pending_approval|approved|rejected|completed|failed|all  (default: pending_approval)
 *   ?limit=20
 */
app.get("/actions", (c) => {
  const db = getDb();
  const status = c.req.query("status") ?? "pending_approval";
  const limit = Math.min(200, Number.parseInt(c.req.query("limit") ?? "50", 10) || 50);

  const rows = (
    status === "all"
      ? db
          .prepare(
            `SELECT id, type, input_json, status, requested_by, requested_at, decided_at, completed_at, result_json, error
           FROM actions ORDER BY requested_at DESC LIMIT ?`,
          )
          .all(limit)
      : db
          .prepare(
            `SELECT id, type, input_json, status, requested_by, requested_at, decided_at, completed_at, result_json, error
           FROM actions WHERE status = ? ORDER BY requested_at DESC LIMIT ?`,
          )
          .all(status, limit)
  ) as Array<{
    id: string;
    type: string;
    input_json: string;
    status: string;
    requested_by: string;
    requested_at: string;
    decided_at: string | null;
    completed_at: string | null;
    result_json: string | null;
    error: string | null;
  }>;

  return c.json({
    actions: rows.map((r) => ({
      id: r.id,
      type: r.type,
      input: safeJsonParse(r.input_json),
      status: r.status,
      requested_by: r.requested_by,
      requested_at: r.requested_at,
      decided_at: r.decided_at,
      completed_at: r.completed_at,
      result: r.result_json ? safeJsonParse(r.result_json) : null,
      error: r.error,
    })),
  });
});

// ── Internal (TAI side) ─────────────────────────────────────────────────────

/**
 * Enqueue a trusted action. The full pipeline:
 *   1. Validate input against the registered action type
 *   2. Get an ApprovalCard via describeForApproval
 *   3. Check spending caps
 *   4. Write the action row + generate approval token + create approval
 *   5. Send push notifications with approve/reject URLs
 *
 * Returns { action_id, status: "pending_approval" } on success.
 */
app.post("/internal/enqueue", async (c) => {
  const db = getDb();
  let body: {
    id?: string;
    type?: string;
    input?: Record<string, unknown>;
    requested_by?: string;
    requestedBy?: string;
    estimated_cost?: number;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const type = body.type;
  const input = body.input;
  const requestedBy = body.requested_by ?? body.requestedBy ?? "unknown";
  if (!type || !input) {
    return c.json({ error: "Missing required fields: type, input" }, 400);
  }

  const handler = getAction(type);
  if (!handler) {
    return c.json({ error: `Unknown action type: ${type}` }, 400);
  }

  // ── Validate
  if (handler.validate) {
    const vr = handler.validate(input);
    if (vr && vr.valid === false) {
      return c.json({ error: "Validation failed", details: vr.errors ?? [] }, 400);
    }
  }

  // ── Describe (needed for push payload + cost extraction)
  let card: import("./types.js").ApprovalCard | null = null;
  if (handler.describeForApproval) {
    try {
      card = await handler.describeForApproval(input);
    } catch (err) {
      return c.json({ error: "describeForApproval failed", details: (err as Error).message }, 500);
    }
  }

  // ── Caps
  const estimatedCost = body.estimated_cost ?? extractCostFromInput(input) ?? extractCostFromCard(card) ?? 0;
  const caps = readCapsFromEnv();
  const capCheck = checkCaps(db, estimatedCost, caps);
  if (!capCheck.ok) {
    writeAudit(db, {
      actor: "executor",
      action: "enqueue.cap_exceeded",
      context: JSON.stringify({
        type,
        estimated_cost: estimatedCost,
        exceeded: capCheck.exceededCap,
      }),
    });
    return c.json({ error: capCheck.error, exceeded_cap: capCheck.exceededCap }, 402);
  }

  // ── Persist action + approval
  const id = body.id || genId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, type, JSON.stringify(input), "pending_approval", requestedBy, now);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  createApproval(db, id, token, expiresAt);

  writeAudit(db, {
    actor: "tai",
    action: "enqueue",
    after: JSON.stringify({ id, type, requested_by: requestedBy, estimated_cost: estimatedCost }),
  });

  // ── Push (fire-and-forget; do not block the enqueue response)
  const base = approvalUrlBase();
  const approveUrl = `${base}/approve/${token}`;
  const rejectUrl = `${base}/reject/${token}`;
  const subs = listSubscriptions();
  if (subs.length > 0) {
    void (async () => {
      let vapidKeys: Awaited<ReturnType<typeof loadVapidKeys>>;
      try {
        vapidKeys = await loadVapidKeys();
      } catch (err) {
        console.warn(
          `[trusted-actions] enqueue ${id} pushed to nobody — VAPID not configured:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
      for (const sub of subs) {
        const r = await sendApprovalPush(
          sub as PushSubscription,
          {
            actionId: id,
            title: card?.title ?? `Approval needed: ${type}`,
            description: card?.body ?? "Action pending your approval.",
            type,
            productUrl: card?.metadata?.url || undefined,
          },
          approveUrl,
          rejectUrl,
          { vapidKeys },
        );
        if (r.gone) {
          deleteSubscription(sub.endpoint);
          console.warn(`[trusted-actions] dropped expired subscription ${sub.endpoint.slice(0, 40)}`);
        } else if (!r.ok) {
          console.warn(`[trusted-actions] push to ${sub.endpoint.slice(0, 40)} failed status=${r.status}: ${r.error}`);
        }
      }
    })();
  }

  return c.json(
    {
      action_id: id,
      status: "pending_approval",
      pushed_to: subs.length,
      expires_at: expiresAt.toISOString(),
    },
    202,
  );
});

/**
 * R3: Execute an auto-approve read action.
 *
 * Bypasses the approval gate — read actions are schema-gated so the
 * agent literally cannot request fields the schema does not model.
 * Each read is audited.
 */
app.post("/internal/read", async (c) => {
  const db = getDb();
  let body: {
    type?: string;
    input?: Record<string, unknown>;
    requested_by?: string;
    requestedBy?: string;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const type = body.type;
  const input = body.input ?? {};
  const requestedBy = body.requested_by ?? body.requestedBy ?? "unknown";
  if (!type) return c.json({ error: "Missing required field: type" }, 400);

  const handler = getAction(type);
  if (!handler) return c.json({ error: `Unknown action type: ${type}` }, 400);

  const readHandler = handler as ActionHandler & Partial<ReadAction>;
  if (readHandler.autoApprove !== true) {
    return c.json({ error: `Action type '${type}' is not an auto-approve read action` }, 403);
  }

  if (handler.validate) {
    const vr = handler.validate(input);
    if (vr && vr.valid === false) {
      return c.json({ error: "Validation failed", details: vr.errors ?? [] }, 400);
    }
  }

  const id = genId();
  const now = new Date().toISOString();
  try {
    const result = await handler.execute(input);
    db.prepare(
      `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at, completed_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, type, JSON.stringify(input), "completed", requestedBy, now, now, JSON.stringify(result));
    writeAudit(db, {
      actor: "tai",
      action: readHandler.auditAction ?? type,
      context: JSON.stringify({ id, type, requested_by: requestedBy }),
    });
    return c.json({ action_id: id, result });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    db.prepare(
      `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, type, JSON.stringify(input), "failed", requestedBy, now, now, errorMsg);
    writeAudit(db, {
      actor: "tai",
      action: `${readHandler.auditAction ?? type}.failed`,
      context: JSON.stringify({ id, type, error: errorMsg }),
    });
    return c.json({ error: errorMsg }, 500);
  }
});

/**
 * TAI polls this to check action status.
 */
app.get("/internal/actions/:id/status", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const row = db
    .prepare(
      `SELECT id, type, status, error, result_json, decided_at, completed_at
       FROM actions WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        type: string;
        status: string;
        error: string | null;
        result_json: string | null;
        decided_at: string | null;
        completed_at: string | null;
      }
    | undefined;
  if (!row) return c.json({ error: "Action not found" }, 404);
  return c.json({
    id: row.id,
    type: row.type,
    status: row.status,
    error: row.error,
    result: row.result_json ? safeJsonParse(row.result_json) : null,
    decided_at: row.decided_at,
    completed_at: row.completed_at,
  });
});

/**
 * Phone-side push subscribe.
 *
 * Internal (TAI-side) — auth'd by shared-secret middleware above:
 */
app.post("/internal/push/subscribe", handlePushSubscribe);

/**
 * PWA-facing subscribe/unsubscribe routes. New subscriptions arrive
 * in status `pending` and never receive pushes until an operator
 * promotes them via the TAI dashboard.
 */
app.post("/push/subscribe", handlePushSubscribe);
app.delete("/push/subscribe", handlePushUnsubscribe);

/**
 * PWA polls this on load to learn whether it's allowed to receive
 * pushes. Returns one of "pending" | "active" | "rejected" | "unknown".
 */
app.get("/push/subscription/status", (c) => {
  const endpoint = c.req.query("endpoint");
  if (!endpoint) return c.json({ status: "unknown" });
  return c.json({ status: getSubscriptionStatus(endpoint) ?? "unknown" });
});

/**
 * VAPID public key — public by design; the private key never leaves
 * the executor. The PWA needs this for `pushManager.subscribe()`.
 */
app.get("/vapid/public-key", async (c) => {
  try {
    const keys = await loadVapidKeys();
    return c.json({ publicKey: keys.publicKey });
  } catch (err) {
    return c.json({ error: "VAPID not configured", detail: err instanceof Error ? err.message : String(err) }, 503);
  }
});

/**
 * Admin (TAI / proxy) subscription routes — gated by the shared-secret
 * middleware above. Lets the operator approve / reject / revoke devices.
 */
app.get("/internal/subscriptions", (c) => {
  return c.json({ subscriptions: listAllSubscriptions() });
});

app.post("/internal/subscriptions/approve", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
  if (!body.endpoint) return c.json({ error: "Missing endpoint" }, 400);
  if (!setSubscriptionStatus(body.endpoint, "active")) {
    return c.json({ error: "Subscription not found" }, 404);
  }
  writeAudit(getDb(), {
    actor: "user",
    action: "subscription.approve",
    context: JSON.stringify({ endpoint: body.endpoint }),
  });
  return c.json({ status: "active" });
});

app.post("/internal/subscriptions/reject", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
  if (!body.endpoint) return c.json({ error: "Missing endpoint" }, 400);
  if (!setSubscriptionStatus(body.endpoint, "rejected")) {
    return c.json({ error: "Subscription not found" }, 404);
  }
  writeAudit(getDb(), {
    actor: "user",
    action: "subscription.reject",
    context: JSON.stringify({ endpoint: body.endpoint }),
  });
  return c.json({ status: "rejected" });
});

app.post("/internal/subscriptions/delete", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
  if (!body.endpoint) return c.json({ error: "Missing endpoint" }, 400);
  deleteSubscription(body.endpoint);
  writeAudit(getDb(), {
    actor: "user",
    action: "subscription.delete",
    context: JSON.stringify({ endpoint: body.endpoint }),
  });
  return c.json({ deleted: true });
});

/**
 * PWA fallback: returns the most recent pending action for this
 * subscriber. Used when iOS skips dispatching the SW's notificationclick
 * (so the Cache-based decide handoff never runs). The push endpoint
 * itself is the credential — only known subscribers have it.
 */
app.post("/pending", async (c) => {
  let body: { endpoint?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.endpoint || typeof body.endpoint !== "string") {
    return c.json({ error: "Missing endpoint" }, 400);
  }

  const pending = findPendingForSubscriber(getDb(), body.endpoint);
  if (!pending) return c.json({ pending: null });

  const base = approvalUrlBase();
  const input = pending.input;
  const title =
    typeof input.title === "string"
      ? input.title
      : input.url || input.query
        ? `${input.url || input.query}`
        : pending.type;
  const body_ = input.max_price !== undefined ? `cap: $${input.max_price}` : "(no details)";

  return c.json({
    pending: {
      actionId: pending.actionId,
      type: pending.type,
      title: `Purchase: ${title}`,
      body: body_,
      approveUrl: `${base}/approve/${pending.token}`,
      rejectUrl: `${base}/reject/${pending.token}`,
      expiresAt: pending.expiresAt,
      productUrl: derivePendingProductUrl(pending.type, input),
    },
  });
});

/**
 * R5: TAI dashboard-facing history. Last N terminal actions newest first,
 * cursor-paged via ?before=<requested_at>.
 */
app.get("/internal/actions/history", (c) => {
  return c.json(
    loadHistory({
      before: c.req.query("before") || undefined,
      limit: Number.parseInt(c.req.query("limit") ?? "50", 10),
    }),
  );
});

/**
 * R5: PWA-facing history. Same auth model as /pending — push endpoint
 * is the credential, gated to `status='active'` subscriptions.
 */
app.post("/history", async (c) => {
  let body: { endpoint?: string; before?: string; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.endpoint || typeof body.endpoint !== "string") {
    return c.json({ error: "Missing endpoint" }, 400);
  }
  const status = getSubscriptionStatus(body.endpoint);
  if (status !== "active") return c.json({ entries: [], next: null });
  return c.json(loadHistory({ before: body.before, limit: body.limit }));
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Best-effort product URL derivation for a queued/historic action.
 * Returns an Amazon product URL when one can be recovered from the
 * raw input; undefined otherwise.
 */
function derivePendingProductUrl(type: string, input: Record<string, unknown>): string | undefined {
  if (type !== "purchase.amazon") return undefined;
  if (typeof input.url === "string" && input.url.includes("amazon.com")) {
    return input.url;
  }
  if (typeof input.query === "string") {
    const m = input.query.match(/\b(B0[A-Z0-9]{8})\b/);
    if (m) return `https://www.amazon.com/dp/${m[1]}`;
  }
  return undefined;
}

function loadHistory(opts: { before?: string; limit?: number | string }): {
  entries: Array<Record<string, unknown>>;
  next: string | null;
} {
  const db = getDb();
  const rawLimit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 50;
  const limit = Math.min(Math.max(rawLimit, 1), 200);
  const params: unknown[] = [];
  let whereExtra = "";
  if (opts.before) {
    whereExtra = "AND requested_at < ?";
    params.push(opts.before);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT id, type, status, input_json, result_json, error,
              requested_at, decided_at, completed_at
       FROM actions
       WHERE status IN ('completed', 'failed', 'rejected')
         ${whereExtra}
       ORDER BY requested_at DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    type: string;
    status: string;
    input_json: string;
    result_json: string | null;
    error: string | null;
    requested_at: string;
    decided_at: string | null;
    completed_at: string | null;
  }>;

  const entries = rows.map((r) => {
    const input = (safeJsonParse(r.input_json) || {}) as Record<string, unknown>;
    const result = r.result_json ? safeJsonParse(r.result_json) : null;
    return {
      action_id: r.id,
      type: r.type,
      status: r.status,
      title: deriveHistoryTitle(r.type, input),
      product_url: derivePendingProductUrl(r.type, input),
      order_id: pickString(result, "order_id"),
      final_price: pickNumber(result, "final_price"),
      eta: pickString(result, "eta"),
      error: r.error,
      requested_at: r.requested_at,
      decided_at: r.decided_at,
      completed_at: r.completed_at,
    };
  });

  const nextCursor = rows.length === limit ? rows[rows.length - 1].requested_at : null;
  return { entries, next: nextCursor };
}

function deriveHistoryTitle(type: string, input: Record<string, unknown>): string {
  if (type === "purchase.amazon") {
    if (typeof input.url === "string" && input.url) return input.url;
    if (typeof input.query === "string" && input.query) return input.query;
  }
  return type;
}

function pickString(o: unknown, key: string): string | null {
  if (o && typeof o === "object" && key in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  }
  return null;
}

function pickNumber(o: unknown, key: string): number | null {
  if (o && typeof o === "object" && key in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[key];
    return typeof v === "number" ? v : null;
  }
  return null;
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractCostFromInput(input: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [input.max_price, input.maxPrice, input.price];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

function extractCostFromCard(card: import("./types.js").ApprovalCard | null): number | undefined {
  if (!card?.estimatedCost) return undefined;
  const m = card.estimatedCost.match(/[\d.]+/);
  if (!m) return undefined;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function genId(): string {
  // Short readable id: ta_<8 hex>
  return `ta_${Math.random().toString(16).slice(2, 10).padStart(8, "0")}`;
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

export function startServer(port = Number(process.env.TA_PORT ?? "3100")) {
  const server = serve({ fetch: app.fetch, port }, () => {});
  console.log(`Executor listening on localhost:${port}`);
  return server;
}

if (process.argv[1]?.endsWith("server.js")) {
  startServer();
}

export { app };
// Unused-but-exported binding to keep the legacy import surface stable.
export type { ActionHandler };
