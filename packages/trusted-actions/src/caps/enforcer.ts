import type Database from "better-sqlite3";
import type { SpendingCaps } from "../types.js";

type Db = Database.Database;

/**
 * Read spending caps from env. `null` = unlimited.
 *   TA_CAP_PER_REQUEST=100
 *   TA_CAP_PER_DAY=500
 *   TA_CAP_PER_MONTH=2000
 *
 * Unset or "unlimited" → null (no cap).
 */
export function readCapsFromEnv(): SpendingCaps {
  return {
    maxPerRequest: parseCap(process.env.TA_CAP_PER_REQUEST),
    maxPerDay: parseCap(process.env.TA_CAP_PER_DAY),
    maxPerMonth: parseCap(process.env.TA_CAP_PER_MONTH),
  };
}

function parseCap(value: string | undefined): number | null {
  if (!value || value === "unlimited" || value === "null") return null;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export interface CapCheckResult {
  ok: boolean;
  error?: string;
  /** Which cap would be exceeded, for the error message and audit. */
  exceededCap?: "per_request" | "per_day" | "per_month";
}

/**
 * Check that a new purchase wouldn't exceed any of the configured caps.
 * Daily/monthly totals are computed from completed actions in the
 * relevant window. Pending or failed actions don't count.
 */
export function checkCaps(db: Db, estimatedCost: number, caps: SpendingCaps): CapCheckResult {
  if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
    return { ok: false, error: "Invalid cost" };
  }

  if (caps.maxPerRequest !== null && estimatedCost > caps.maxPerRequest) {
    return {
      ok: false,
      error: `Per-request cap exceeded: $${estimatedCost} > $${caps.maxPerRequest}`,
      exceededCap: "per_request",
    };
  }

  if (caps.maxPerDay !== null) {
    const dayTotal = sumCompletedSince(db, hoursAgoIso(24));
    if (dayTotal + estimatedCost > caps.maxPerDay) {
      return {
        ok: false,
        error: `Per-day cap exceeded: would push 24h total to $${(dayTotal + estimatedCost).toFixed(2)} > $${caps.maxPerDay}`,
        exceededCap: "per_day",
      };
    }
  }

  if (caps.maxPerMonth !== null) {
    const monthTotal = sumCompletedSince(db, daysAgoIso(30));
    if (monthTotal + estimatedCost > caps.maxPerMonth) {
      return {
        ok: false,
        error: `Per-month cap exceeded: would push 30d total to $${(monthTotal + estimatedCost).toFixed(2)} > $${caps.maxPerMonth}`,
        exceededCap: "per_month",
      };
    }
  }

  return { ok: true };
}

/**
 * Sum the cost field of completed actions whose completed_at >= sinceIso.
 * Looks for "final_price" or "estimated_cost" inside result_json or
 * input_json. Defensive: anything that doesn't parse contributes 0.
 */
function sumCompletedSince(db: Db, sinceIso: string): number {
  const rows = db
    .prepare(
      `SELECT result_json, input_json FROM actions
       WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at >= ?`,
    )
    .all(sinceIso) as { result_json: string | null; input_json: string }[];

  let total = 0;
  for (const row of rows) {
    total += extractCost(row.result_json) ?? extractCost(row.input_json) ?? 0;
  }
  return total;
}

function extractCost(json: string | null): number | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const candidates: Array<unknown> = [parsed.final_price, parsed.estimated_cost, parsed.max_price, parsed.price];
    for (const c of candidates) {
      if (typeof c === "number" && Number.isFinite(c)) return c;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
