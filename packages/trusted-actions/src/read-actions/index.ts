/**
 * R3: Capability-narrowed read actions.
 *
 * Auto-approved, schema-gated read tools that run in the executor.
 * Agent literally cannot request fields a schema does not model.
 * Sensitive fields (shipping address, last-4 card) explicitly excluded.
 * Each read is audited.
 */

export { CartStateAdapter } from "./cart-state.js";
export { OrderHistoryAdapter } from "./order-history.js";
export { ProductSummaryAdapter } from "./product-summary.js";
export * from "./types.js";
