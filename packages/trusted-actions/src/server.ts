import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * PWA decisions card: capability proposals + non-capability in_review items
 * needing the user. Auth model matches /pending and /history (push
 * subscription endpoint is the credential). Proxies to the TAI HTTP API
 * configured via TAI_API_URL + TAI_API_TOKEN. Returns 503 if unset so the
 * PWA can hide the card cleanly.
 *
 * See issue #121 for the broader PWA-as-dashboard plan; this is Phase 1.
 */
app.post("/pwa/decisions", async (c) => {
  let body: { endpoint?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.endpoint || typeof body.endpoint !== "string") {
    return c.json({ error: "Missing endpoint" }, 400);
  }
  if (getSubscriptionStatus(body.endpoint) !== "active") {
    return c.json({ error: "Unknown subscription" }, 401);
  }

  const taiUrl = process.env.TAI_API_URL || "";
  const taiToken = process.env.TAI_API_TOKEN || "";
  if (!taiUrl || !taiToken) {
    return c.json({ error: "TAI proxy not configured" }, 503);
  }

  const headers = { Authorization: `Bearer ${taiToken}` };
  let reviewRes: Response;
  let capRes: Response;
  try {
    [reviewRes, capRes] = await Promise.all([
      fetch(`${taiUrl}/api/project-tasks?status=in_review&limit=20`, { headers }),
      fetch(`${taiUrl}/api/project-tasks?status=in_review&tags=capability&limit=20`, { headers }),
    ]);
  } catch (err) {
    return c.json({ error: `TAI unreachable: ${(err as Error).message}` }, 502);
  }
  if (!reviewRes.ok || !capRes.ok) {
    return c.json({ error: `TAI returned ${reviewRes.status}/${capRes.status}` }, 502);
  }

  type TaskRow = {
    id: string;
    title: string;
    status: string;
    tags?: string[];
    assignee?: string;
    updated_at: string;
  };
  const review = (await reviewRes.json()) as { tasks?: TaskRow[] };
  const cap = (await capRes.json()) as { tasks?: TaskRow[] };

  const slim = (t: TaskRow) => {
    const ms = Date.now() - Date.parse(t.updated_at);
    const days = Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
    return {
      id: t.id,
      title: t.title,
      days_idle: days,
      assignee: t.assignee ?? null,
      tags: t.tags ?? [],
    };
  };

  const capIds = new Set((cap.tasks ?? []).map((t) => t.id));
  const needsReview = (review.tasks ?? []).filter((t) => !capIds.has(t.id)).map(slim);
  const capabilityProposals = (cap.tasks ?? []).map(slim);

  return c.json({ capability_proposals: capabilityProposals, needs_review: needsReview });
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

/**
 * PWA decide action: approve / reject a task from the phone. Issue #121
 * Phase 2. Mirrors the auth model of /pending and /pwa/decisions (push
 * subscription endpoint is the credential).
 *
 * Behavior matrix (by tag + decision):
 *
 *   capability + approve → status=in_progress, assignee=quinton,
 *                          comment "Approved via PWA …".
 *     Punts back to Quinton to wire up the proposed artifact. Once #118
 *     ships, approve will auto-apply instead.
 *
 *   capability + reject  → status=archived,
 *                          comment "Rejected via PWA …".
 *
 *   default    + approve → status=done,
 *                          comment "Approved via PWA …".
 *     The reviewer agent places items in in_review awaiting the user to
 *     mark done; this matches that flow.
 *
 *   default    + reject  → status=in_progress (assignee unchanged),
 *                          comment "Needs revision via PWA …".
 */
app.post("/pwa/tasks/:id/decide", async (c) => {
  let body: { endpoint?: string; decision?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.endpoint || typeof body.endpoint !== "string") {
    return c.json({ error: "Missing endpoint" }, 400);
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    return c.json({ error: "decision must be approve or reject" }, 400);
  }
  if (getSubscriptionStatus(body.endpoint) !== "active") {
    return c.json({ error: "Unknown subscription" }, 401);
  }

  const taiUrl = process.env.TAI_API_URL || "";
  const taiToken = process.env.TAI_API_TOKEN || "";
  if (!taiUrl || !taiToken) {
    return c.json({ error: "TAI proxy not configured" }, 503);
  }

  const taskId = c.req.param("id");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${taiToken}`,
  };

  type TaskRow = { id: string; tags?: string[]; status: string };
  let task: TaskRow;
  try {
    const r = await fetch(
      `${taiUrl}/api/project-tasks/${encodeURIComponent(taskId)}`,
      { headers },
    );
    if (r.status === 404) return c.json({ error: "Task not found" }, 404);
    if (!r.ok) return c.json({ error: `TAI returned ${r.status}` }, 502);
    task = (await r.json()) as TaskRow;
  } catch (err) {
    return c.json({ error: `TAI unreachable: ${(err as Error).message}` }, 502);
  }

  const isCapability = (task.tags ?? []).includes("capability");
  const today = new Date().toISOString().slice(0, 10);

  let newStatus: string;
  let label: string;
  const patch: Record<string, unknown> = {};
  if (body.decision === "approve") {
    if (isCapability) {
      newStatus = "in_progress";
      label = "Approved capability via PWA";
      patch.assignee = "quinton";
    } else {
      newStatus = "done";
      label = "Approved via PWA";
    }
  } else {
    if (isCapability) {
      newStatus = "archived";
      label = "Rejected capability via PWA";
    } else {
      newStatus = "in_progress";
      label = "Needs revision via PWA";
    }
  }
  patch.status = newStatus;

  try {
    const commentRes = await fetch(
      `${taiUrl}/api/project-tasks/${encodeURIComponent(taskId)}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ content: `${label} on ${today}.`, author: "quinton-pwa" }),
      },
    );
    if (!commentRes.ok) {
      return c.json({ error: `Comment failed: ${commentRes.status}` }, 502);
    }
    const patchRes = await fetch(
      `${taiUrl}/api/project-tasks/${encodeURIComponent(taskId)}`,
      { method: "PATCH", headers, body: JSON.stringify(patch) },
    );
    if (!patchRes.ok) {
      return c.json({ error: `Status update failed: ${patchRes.status}` }, 502);
    }
    return c.json({ ok: true, new_status: newStatus, decision: body.decision });
  } catch (err) {
    return c.json({ error: `TAI unreachable: ${(err as Error).message}` }, 502);
  }
});

/**
 * PWA quick-capture: file a task from the phone with one-tap. Issue #121
 * Phase 5. Title required; tags + description optional. Always lands in
 * backlog assigned to nobody — the user can re-route later.
 */
app.post("/pwa/tasks/create", async (c) => {
  let body: {
    endpoint?: string;
    title?: string;
    tags?: unknown;
    description?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.endpoint || typeof body.endpoint !== "string") {
    return c.json({ error: "Missing endpoint" }, 400);
  }
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return c.json({ error: "title is required" }, 400);
  }
  if (getSubscriptionStatus(body.endpoint) !== "active") {
    return c.json({ error: "Unknown subscription" }, 401);
  }

  const taiUrl = process.env.TAI_API_URL || "";
  const taiToken = process.env.TAI_API_TOKEN || "";
  if (!taiUrl || !taiToken) {
    return c.json({ error: "TAI proxy not configured" }, 503);
  }

  const tags = Array.isArray(body.tags)
    ? (body.tags as unknown[])
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 40))
        .slice(0, 8)
    : [];
  const description =
    typeof body.description === "string" ? body.description.slice(0, 4000) : "";

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${taiToken}`,
  };
  try {
    const r = await fetch(`${taiUrl}/api/project-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: body.title.trim().slice(0, 200),
        description,
        tags,
        author: "quinton-pwa",
        status: "backlog",
      }),
    });
    if (!r.ok) {
      return c.json({ error: `TAI returned ${r.status}` }, 502);
    }
    const task = (await r.json()) as { id?: string; title?: string };
    return c.json({ ok: true, id: task.id ?? null, title: task.title ?? null });
  } catch (err) {
    return c.json({ error: `TAI unreachable: ${(err as Error).message}` }, 502);
  }
});

/**
 * PWA activity feed: recent recall notes and recently-completed tasks,
 * sorted newest first. Issue #121 Phase 3. Read-only — gives you a sense
 * of what the agent has been up to since you last looked.
 */
app.post("/pwa/activity", async (c) => {
  let body: { endpoint?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.endpoint || typeof body.endpoint !== "string") {
    return c.json({ error: "Missing endpoint" }, 400);
  }
  if (getSubscriptionStatus(body.endpoint) !== "active") {
    return c.json({ error: "Unknown subscription" }, 401);
  }

  const taiUrl = process.env.TAI_API_URL || "";
  const taiToken = process.env.TAI_API_TOKEN || "";
  if (!taiUrl || !taiToken) {
    return c.json({ error: "TAI proxy not configured" }, 503);
  }

  const headers = { Authorization: `Bearer ${taiToken}` };
  type NoteRow = {
    id?: string;
    content?: string;
    tags?: string[];
    agent?: string;
    created_at?: string;
    createdAt?: string;
  };
  type TaskRow = { id: string; title: string; updated_at?: string };

  let notes: NoteRow[] = [];
  let tasks: TaskRow[] = [];
  try {
    const [notesRes, tasksRes] = await Promise.all([
      fetch(`${taiUrl}/api/memory/notes?limit=15`, { headers }),
      fetch(`${taiUrl}/api/project-tasks?status=done&limit=10`, { headers }),
    ]);
    if (notesRes.ok) {
      const j = (await notesRes.json()) as NoteRow[] | { notes?: NoteRow[] };
      notes = Array.isArray(j) ? j : (j.notes ?? []);
    }
    if (tasksRes.ok) {
      const j = (await tasksRes.json()) as { tasks?: TaskRow[] };
      tasks = j.tasks ?? [];
    }
  } catch (err) {
    return c.json({ error: `TAI unreachable: ${(err as Error).message}` }, 502);
  }

  const noteItems = notes.slice(0, 15).map((n) => ({
    kind: "note" as const,
    id: n.id ?? "",
    content: typeof n.content === "string" ? n.content.slice(0, 220) : "",
    tags: n.tags ?? [],
    agent: n.agent ?? null,
    timestamp: n.created_at ?? n.createdAt ?? null,
  }));
  const taskItems = tasks.slice(0, 10).map((t) => ({
    kind: "task_done" as const,
    id: t.id,
    title: t.title,
    timestamp: t.updated_at ?? null,
  }));

  const items = [...noteItems, ...taskItems]
    .filter((i): i is typeof i & { timestamp: string } => typeof i.timestamp === "string")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 20);

  return c.json({ items });
});

/**
 * PWA chat: send one message to the default agent and wait for its
 * response. Issue #121 Phase 4. Non-streaming: proxies to TAI's SSE
 * /api/chat, consumes the stream, returns the final `response` event
 * payload synchronously. Keeps the phone-side UX simple at the cost of
 * no incremental tokens — acceptable for short Q&A during travel.
 *
 * Session key is derived from the push subscription endpoint so each
 * device gets its own continuous conversation history in TAI.
 */
app.post("/pwa/chat", async (c) => {
  let body: { endpoint?: string; message?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.endpoint || typeof body.endpoint !== "string") {
    return c.json({ error: "Missing endpoint" }, 400);
  }
  if (!body.message || typeof body.message !== "string" || !body.message.trim()) {
    return c.json({ error: "message is required" }, 400);
  }
  if (getSubscriptionStatus(body.endpoint) !== "active") {
    return c.json({ error: "Unknown subscription" }, 401);
  }

  const taiUrl = process.env.TAI_API_URL || "";
  const taiToken = process.env.TAI_API_TOKEN || "";
  if (!taiUrl || !taiToken) {
    return c.json({ error: "TAI proxy not configured" }, 503);
  }

  // Per-device sessionKey. Hash the endpoint so we don't leak it into
  // TAI's session table verbatim.
  const sessionKey = `pwa:${(await sha256Hex(body.endpoint)).slice(0, 24)}`;

  // 90s ceiling — enough for a tool-using turn, not long enough to hang
  // forever if vLLM stalls.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  let upstream: Response;
  try {
    upstream = await fetch(`${taiUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${taiToken}`,
      },
      body: JSON.stringify({
        message: body.message,
        sessionKey,
        agent: "default",
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return c.json({ error: `TAI unreachable: ${(err as Error).message}` }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    return c.json({ error: `TAI returned ${upstream.status}` }, 502);
  }

  // Consume the SSE stream. We only care about the final `response`
  // event. Tool calls and intermediate activity are ignored at this
  // tier — Phase 4 surfaces just the final text.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastEvent = "";
  let responsePayload: Record<string, unknown> | null = null;
  let errorPayload: Record<string, unknown> | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines.
      let idx: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic loop
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = frame.split("\n");
        let event = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join("\n");
        try {
          const parsed = JSON.parse(dataStr) as Record<string, unknown>;
          if (event === "response") responsePayload = parsed;
          else if (event === "error") errorPayload = parsed;
          lastEvent = event;
        } catch {
          // ignore malformed frame
        }
        if (responsePayload || errorPayload) break;
      }
      if (responsePayload || errorPayload) break;
    }
  } catch (err) {
    clearTimeout(timer);
    return c.json({ error: `Stream error: ${(err as Error).message}` }, 502);
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      // already done
    }
  }

  if (errorPayload) {
    return c.json({ error: (errorPayload.error as string) || "Agent error" }, 502);
  }
  if (!responsePayload) {
    return c.json({ error: `No response event (last: ${lastEvent || "none"})` }, 502);
  }

  return c.json({
    ok: true,
    content: (responsePayload.content as string | null) ?? null,
    session_id: (responsePayload.sessionId as string) ?? null,
    session_key: (responsePayload.sessionKey as string) ?? sessionKey,
  });
});

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Static PWA ──────────────────────────────────────────────────────────────
//
// The PWA is built into ../pwa relative to the compiled server.js by the
// trusted-actions package build (scripts/build-pwa.cjs copies pwa/ →
// dist/pwa/). Serve those files from the same origin so iOS/Android can
// install the PWA and so the SW can fetch updates after install — the
// network-first SW only works if the origin actually serves the assets.
//
// Routes are explicit (no glob) so they sort cleanly with the API routes
// above and we can be precise about content-types and path traversal.

const PWA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "pwa");

async function servePwaFile(
  c: import("hono").Context,
  relPath: string,
  contentType: string,
) {
  try {
    const body = await readFile(join(PWA_ROOT, relPath));
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // PWA assets are stamped with a build id per build; the SW is
        // network-first. No-store keeps the HTTP cache from masking a
        // redeploy.
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
}

function iconMime(name: string): string {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

app.get("/", (c) => servePwaFile(c, "index.html", "text/html; charset=utf-8"));
app.get("/index.html", (c) => servePwaFile(c, "index.html", "text/html; charset=utf-8"));
app.get("/app.js", (c) => servePwaFile(c, "app.js", "application/javascript; charset=utf-8"));
app.get("/sw.js", (c) => servePwaFile(c, "sw.js", "application/javascript; charset=utf-8"));
app.get("/styles.css", (c) => servePwaFile(c, "styles.css", "text/css; charset=utf-8"));
app.get("/manifest.webmanifest", (c) =>
  servePwaFile(c, "manifest.webmanifest", "application/manifest+json; charset=utf-8"),
);
app.get("/icons/:name", (c) => {
  const name = c.req.param("name") || "";
  // Defense in depth: param won't include slashes via Hono routing, but
  // explicitly reject anything that smells like traversal.
  if (name.includes("..") || name.includes("/")) return c.json({ error: "Bad path" }, 400);
  return servePwaFile(c, `icons/${name}`, iconMime(name));
});

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
