/**
 * Core types for the trusted-actions executor.
 *
 * Actions register against this interface; the approval gateway, audit log,
 * and execution runner all operate on these types generically.
 */

// ── Action interface ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface ApprovalCard {
  title: string;
  body: string;
  imageUrl?: string;
  estimatedCost?: string;
  metadata?: Record<string, string>;
}

export interface ExecutorContext {
  /** Decrypt credentials from the age-encrypted store. */
  decryptCredentials: (key: string) => Promise<string>;
  /** Send a push notification to the user. */
  sendPush: (title: string, body: string) => Promise<void>;
  /** Capture a screenshot for debugging. */
  captureScreenshot: (path: string) => Promise<void>;
  /** Abort the current action with an error. */
  abort: (error: string) => never;
  /**
   * Append a hash-chained audit entry. Used for sensitive sub-steps
   * (e.g. password re-auth) that aren't covered by the
   * execute_begin / execute_end pair the runner writes.
   */
  audit?: (action: string, context?: Record<string, unknown>) => void;
}

export interface TrustedAction<I, O> {
  type: string;
  validate(input: I): ValidationResult;
  describeForApproval(input: I): Promise<ApprovalCard>;
  execute(input: I, ctx: ExecutorContext): Promise<O>;
}

// ── Spending caps ───────────────────────────────────────────────────────────

/**
 * Per-request / per-day / per-month dollar caps. `null` = unlimited.
 * Read from env on each enqueue so config edits don't need a restart.
 */
export interface SpendingCaps {
  maxPerRequest: number | null;
  maxPerDay: number | null;
  maxPerMonth: number | null;
}

// ── Action status ───────────────────────────────────────────────────────────

export type ActionStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "running"
  | "completed"
  | "failed"
  | "expired";

export interface ActionRecord {
  id: string;
  type: string;
  inputJson: string;
  status: ActionStatus;
  requestedBy: string;
  requestedAt: string;
  decidedAt?: string;
  completedAt?: string;
  resultJson?: string;
  error?: string;
}

// ── Amazon purchase types ───────────────────────────────────────────────────

export interface AmazonPurchaseInput {
  url?: string;
  query?: string;
  max_price: number;
  qty?: number;
}

export interface AmazonPurchaseOutput {
  order_id: string;
  final_price: number;
  eta: string;
}

export interface AmazonSession {
  cookies: string;
  userAgent: string;
  viewport: { width: number; height: number };
  /** BCP-47 locale captured at login. Older sessions omit it; replay falls back to the host locale. */
  locale?: string;
  /** IANA timezone captured at login. Older sessions omit it; replay falls back to the host timezone. */
  timezoneId?: string;
  defaultAddress?: string;
  savedAt: string;
  expiresAt?: string;
}

// ── Error types ─────────────────────────────────────────────────────────────

export class SessionExpiredError extends Error {
  constructor() {
    super("Amazon session has expired; re-login required");
    this.name = "SessionExpiredError";
  }
}

export class PriceChangedError extends Error {
  constructor(
    public currentPrice: number,
    public maxPrice: number,
  ) {
    super(`Price changed: $${currentPrice} exceeds max $${maxPrice}`);
    this.name = "PriceChangedError";
  }
}

export class AddressMismatchError extends Error {
  constructor(
    public expected: string,
    public actual: string,
  ) {
    super(`Address mismatch: expected "${expected}" but got "${actual}"`);
    this.name = "AddressMismatchError";
  }
}

/**
 * Raised when Amazon redirects to /ap/signin during a purchase and
 * the executor can't recover automatically — either no password is
 * stored, the stored password is wrong, or 2FA/captcha appears.
 */
export class ReauthError extends Error {
  constructor(
    public reason: "no_password" | "wrong_password" | "two_factor" | "captcha" | "unknown",
    public screenshotPath?: string,
  ) {
    super(`Amazon re-auth failed: ${reason}`);
    this.name = "ReauthError";
  }
}
