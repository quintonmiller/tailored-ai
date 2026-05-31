import type Database from "better-sqlite3";
import { hashToken, verifyToken } from "./crypto.js";

export interface ApprovalRecord {
  actionId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  approved: boolean | null;
}

export interface ApprovalResult {
  approved: boolean;
  error?: string;
}

type Db = Database.Database;

/**
 * DB-backed approval store. Reads/writes the `approvals` table.
 *
 * The cleartext token is NEVER stored — only its HMAC hash. The
 * cleartext lives in transit (push payload → user phone → /approve)
 * and the consume step re-hashes the submitted token under the same
 * key to compare via constant-time compare.
 */
export function createApproval(db: Db, actionId: string, token: string, expiresAt: Date): void {
  // We also store the cleartext for the PWA's /pending fallback —
  // see migrations.ts and server.ts for the rationale.
  db.prepare(
    `INSERT INTO approvals (action_id, token_hash, token_cleartext, expires_at, consumed_at, approved)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  ).run(actionId, hashToken(token), token, expiresAt.toISOString());
}

/**
 * For the PWA fallback: given a subscriber's push endpoint URL, return
 * the most recent pending action with its cleartext token. The endpoint
 * itself is the authentication — only subscribed devices have it.
 */
export function findPendingForSubscriber(
  db: Db,
  endpoint: string,
): {
  actionId: string;
  type: string;
  input: Record<string, unknown>;
  token: string;
  expiresAt: string;
} | null {
  // Confirm the endpoint is a known subscriber (rejection-by-absence).
  const sub = db.prepare(`SELECT endpoint FROM push_subscriptions WHERE endpoint = ?`).get(endpoint);
  if (!sub) return null;

  const row = db
    .prepare(
      `SELECT a.id as action_id, a.type, a.input_json, ap.token_cleartext, ap.expires_at
       FROM actions a
       INNER JOIN approvals ap ON ap.action_id = a.id
       WHERE a.status = 'pending_approval'
         AND ap.consumed_at IS NULL
         AND ap.expires_at > ?
         AND ap.token_cleartext IS NOT NULL
       ORDER BY a.requested_at DESC
       LIMIT 1`,
    )
    .get(new Date().toISOString()) as
    | {
        action_id: string;
        type: string;
        input_json: string;
        token_cleartext: string;
        expires_at: string;
      }
    | undefined;
  if (!row) return null;

  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(row.input_json);
  } catch {
    /* ignore */
  }

  return {
    actionId: row.action_id,
    type: row.type,
    input,
    token: row.token_cleartext,
    expiresAt: row.expires_at,
  };
}

/**
 * Consume an approval: verify the token, check expiry, enforce one-time use.
 * On valid token: marks consumed + writes approval decision.
 * Returns the result; caller updates the action status.
 */
export function consumeApproval(
  db: Db,
  actionId: string,
  token: string,
  decision: "approve" | "reject",
): ApprovalResult {
  const row = db
    .prepare(`SELECT action_id, token_hash, expires_at, consumed_at, approved FROM approvals WHERE action_id = ?`)
    .get(actionId) as
    | {
        action_id: string;
        token_hash: string;
        expires_at: string;
        consumed_at: string | null;
        approved: number | null;
      }
    | undefined;

  if (!row) return { approved: false, error: "Approval not found" };
  if (row.consumed_at !== null) return { approved: false, error: "Approval already consumed" };
  if (Date.now() > new Date(row.expires_at).getTime()) {
    return { approved: false, error: "Approval expired" };
  }
  if (!verifyToken(row.token_hash, token)) {
    return { approved: false, error: "Invalid token" };
  }

  db.prepare(`UPDATE approvals SET consumed_at = ?, approved = ? WHERE action_id = ?`).run(
    new Date().toISOString(),
    decision === "approve" ? 1 : 0,
    actionId,
  );

  return { approved: decision === "approve" };
}

/**
 * Look up the action_id for a given submitted token by re-hashing and
 * scanning the approvals table. Used by /approve/:token and /reject/:token
 * routes where the URL contains the cleartext token but not the action id.
 *
 * Returns the action_id or null. Always re-hashes — never logs the token.
 */
export function findActionByToken(db: Db, token: string): string | null {
  const hash = hashToken(token);
  const row = db.prepare(`SELECT action_id FROM approvals WHERE token_hash = ?`).get(hash) as
    | { action_id: string }
    | undefined;
  return row?.action_id ?? null;
}
