/**
 * R3: Capability-narrowed read actions.
 *
 * Strict typed output schemas — the agent literally cannot request fields
 * a schema does not model. Sensitive fields (shipping address, last-4 card)
 * are explicitly excluded unless opted in via config.
 */

// ── Product Summary ─────────────────────────────────────────────────────────

export interface ProductSummaryInput {
  url?: string;
  query?: string;
}

export interface ProductSummaryOutput {
  title: string;
  price: string;
  image: string;
  url: string;
  [k: string]: unknown;
}

// ── Order History ───────────────────────────────────────────────────────────

export type OrderHistoryInput = Record<string, never>;

export interface Order {
  order_id: string;
  date: string;
  status: string;
  total: string;
  items: string[];
}

export interface OrderHistoryOutput {
  orders: Order[];
  [k: string]: unknown;
}

// ── Cart State ──────────────────────────────────────────────────────────────

export type CartStateInput = Record<string, never>;

export interface CartItem {
  title: string;
  price: string;
  quantity: number;
  url: string;
}

export interface CartStateOutput {
  items: CartItem[];
  total_items: number;
  [k: string]: unknown;
}

// ── Read Action Interface ───────────────────────────────────────────────────

import type { ActionHandler } from "../actions/registry.js";

/**
 * Read action — auto-approved, no approval gate.
 * Runs in the executor with strict typed output schema.
 * Each read is audited.
 */
export interface ReadAction extends ActionHandler {
  autoApprove: true;
  /** Audit action name for logging. */
  auditAction: string;
}
