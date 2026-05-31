/**
 * @tailored-ai/trusted-actions
 *
 * Separate-process executor for approval-gated operations.
 * Holds credentials, runs headless browser automation, and
 * maintains an audit trail — all isolated from the TAI agent.
 */

export { __clearRegistry, get, listTypes, register } from "./actions/registry.js";
export {
  captureScreenshot,
  createStealthContext,
  humanDelay,
  launchStealthBrowser,
  navigateWithDelay,
  serializeCookies,
} from "./adapters/playwright-stealth.js";
// Adapters
export { AmazonPurchaseAdapter } from "./adapters/purchase-amazon.js";
// Approval + push + runner
export {
  generateToken,
  hashToken,
  isExpired,
  verifyToken,
} from "./approval/crypto.js";
export * from "./approval/push.js";
export * from "./approval/push-routes.js";
export {
  consumeApproval,
  createApproval,
  findActionByToken,
} from "./approval/token-store.js";
export { verifyAuditChain, writeAudit } from "./audit/log.js";
// Caps + audit
export { checkCaps, readCapsFromEnv } from "./caps/enforcer.js";
export { setupAmazon } from "./cli/setup-amazon.js";
export { MIGRATIONS, migrate } from "./db/migrations.js";
export { closeDb, getDb } from "./db/schema.js";
export * from "./executor/runner.js";
export { AgeStore } from "./secrets/age-store.js";
// Server + scaffolding
export { app, startServer } from "./server.js";
export type {
  ActionRecord,
  ActionStatus,
  AmazonPurchaseInput,
  AmazonPurchaseOutput,
  AmazonSession,
  ApprovalCard,
  ExecutorContext,
  SpendingCaps,
  TrustedAction,
  ValidationResult,
} from "./types.js";
export {
  AddressMismatchError,
  PriceChangedError,
  SessionExpiredError,
} from "./types.js";
