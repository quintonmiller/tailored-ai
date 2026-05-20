/**
 * Human-in-the-loop (HITL) approval gateway.
 *
 * Provides the interrupt pattern for red-tier actions:
 *   1. Pause execution when a red action is detected.
 *   2. Present an approval request to the user.
 *   3. Wait for approve / reject / edit response.
 *   4. Resume or abort based on the response.
 *
 * Additional safety features:
 *   - Time-bounded approvals (expire after a configurable window).
 *   - Cooldown tracking after rejections (prevent immediate retry).
 *   - Escalation on repeated rejections (e.g., lock out after N failures).
 */

import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from "./approval.js";

// --- Types ---

/** Outcome of an approval request (approved, rejected, or timed out). */
export type ApprovalOutcome = "approved" | "rejected" | "timed_out";

/**
 * A pending approval request tracked by the gateway.
 */
export interface PendingApproval {
  request: ApprovalRequest;
  createdAt: number;
  expiresAt: number;
  /** Resolve/reject the underlying promise. */
  resolve: (response: ApprovalResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Record of a past approval decision, used for cooldown / escalation tracking.
 */
export interface ApprovalRecord {
  requestId: string;
  toolName: string;
  outcome: ApprovalOutcome;
  timestamp: number;
  responseTimeMs: number;
}

/** Configuration for the approval gateway. */
export interface ApprovalGatewayConfig {
  /** Default timeout in ms for approval requests. Default: 3600000 (1 hour). */
  defaultTimeoutMs?: number;

  /** Cooldown period in ms after a rejection before the same tool can be retried. Default: 60000 (1 min). */
  cooldownMs?: number;

  /** Number of rejections within the escalation window before escalation triggers. Default: 3. */
  escalationThreshold?: number;

  /** Time window in ms for counting rejections toward escalation. Default: 300000 (5 min). */
  escalationWindowMs?: number;

  /**
   * When escalation triggers, block further approvals for this duration.
   * 0 = no lockout (just notify). Default: 300000 (5 min).
   */
  lockoutMs?: number;
}

/**
 * Callback invoked when escalation triggers (e.g., to notify the user).
 */
export type EscalationCallback = (info: {
  toolName: string;
  rejectionCount: number;
  windowMs: number;
  lockoutUntil: number | null;
}) => void;

// --- Gateway ---

export class ApprovalGateway implements ApprovalHandler {
  private pending = new Map<string, PendingApproval>();
  private records: ApprovalRecord[] = [];
  private config: Required<ApprovalGatewayConfig>;
  private escalationCallback?: EscalationCallback;

  constructor(config: ApprovalGatewayConfig = {}, onEscalation?: EscalationCallback) {
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs ?? 3_600_000, // 1 hour
      cooldownMs: config.cooldownMs ?? 60_000, // 1 min
      escalationThreshold: config.escalationThreshold ?? 3,
      escalationWindowMs: config.escalationWindowMs ?? 300_000, // 5 min
      lockoutMs: config.lockoutMs ?? 300_000, // 5 min
    };
    this.escalationCallback = onEscalation;
  }

  // --- Public API ---

  /**
   * Request approval for a tool call. This is the main entry point for the
   * interrupt pattern. It:
   *   1. Checks lockout — if escalation triggered, block until lockout expires.
   *   2. Checks cooldown — if the same tool was recently rejected, reject immediately.
   *   3. Creates a pending request and waits for the user's response.
   *   4. Applies timeout if the user doesn't respond in time.
   *   5. Records the outcome and checks for escalation.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    // 1. Check lockout first (more severe restriction)
    const lockoutUntil = this.getLockoutUntil(request.toolName);
    if (lockoutUntil && Date.now() < lockoutUntil) {
      const remaining = lockoutUntil - Date.now();
      return {
        approved: false,
        reason: `Lockout active for ${request.toolName} (escalation). ${Math.ceil(remaining / 1000)}s remaining.`,
        responseTimeMs: 0,
      };
    }

    // 2. Check cooldown
    const cooldownEnd = this.getLastRejectionTime(request.toolName);
    if (cooldownEnd && Date.now() < cooldownEnd) {
      const remaining = cooldownEnd - Date.now();
      return {
        approved: false,
        reason: `Cooldown active for ${request.toolName}. ${Math.ceil(remaining / 1000)}s remaining before retry.`,
        responseTimeMs: 0,
      };
    }

    // 3. Create pending request
    const timeoutMs = this.config.defaultTimeoutMs;
    const createdAt = Date.now();
    const expiresAt = createdAt + timeoutMs;

    let settle: ((response: ApprovalResponse) => void) | undefined;
    let rejectWith: ((error: Error) => void) | undefined;

    const promise = new Promise<ApprovalResponse>((resolve, reject) => {
      settle = resolve;
      rejectWith = reject;
    });

    if (!settle || !rejectWith) {
      throw new Error("Internal error: promise settlement functions unavailable");
    }

    const pending: PendingApproval = {
      request,
      createdAt,
      expiresAt,
      resolve: settle,
      reject: rejectWith,
    };

    this.pending.set(request.requestId, pending);

    // Start timeout timer
    const timeoutId = setTimeout(() => {
      const existing = this.pending.get(request.requestId);
      if (existing) {
        this.pending.delete(request.requestId);
        const response: ApprovalResponse = {
          approved: false,
          reason: `Approval timed out after ${timeoutMs}ms`,
          responseTimeMs: timeoutMs,
        };
        this.recordOutcome(request, "timed_out", response.responseTimeMs);
        settle(response);
      }
    }, timeoutMs);

    // Prevent the timeout from keeping the process alive
    if (timeoutId.unref) timeoutId.unref();

    try {
      const response = await promise;
      return response;
    } finally {
      clearTimeout(timeoutId);
      this.pending.delete(request.requestId);
    }
  }

  /**
   * Accept an approval request (called by the user-facing interface).
   */
  approve(requestId: string, reason?: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    const responseTimeMs = Date.now() - pending.createdAt;
    const response: ApprovalResponse = {
      approved: true,
      reason,
      responseTimeMs,
    };

    this.recordOutcome(pending.request, "approved", responseTimeMs);
    pending.resolve(response);
    return true;
  }

  /**
   * Reject an approval request (called by the user-facing interface).
   */
  reject(requestId: string, reason?: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    const responseTimeMs = Date.now() - pending.createdAt;
    const response: ApprovalResponse = {
      approved: false,
      reason,
      responseTimeMs,
    };

    this.recordOutcome(pending.request, "rejected", responseTimeMs);
    pending.resolve(response);
    return true;
  }

  /**
   * Edit and re-submit an approval request with modified arguments.
   * The original request is resolved with the edited args.
   */
  edit(requestId: string, editedArgs: Record<string, unknown>, reason?: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    const responseTimeMs = Date.now() - pending.createdAt;
    const response: ApprovalResponse = {
      approved: true,
      reason: `Edited: ${reason ?? "args modified"}`,
      responseTimeMs,
    };

    // Store edited args on the response for the caller to use
    (response as Record<string, unknown>).editedArgs = editedArgs;

    this.recordOutcome(pending.request, "approved", responseTimeMs);
    pending.resolve(response);
    return true;
  }

  /**
   * Cancel a pending approval request.
   */
  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    this.pending.delete(requestId);
    pending.reject(new Error("Approval request cancelled"));
    return true;
  }

  /**
   * List all pending approval requests.
   */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /**
   * Get the approval history (most recent first).
   */
  getHistory(): ApprovalRecord[] {
    return [...this.records].reverse();
  }

  /**
   * Get pending requests that have expired but not yet been resolved.
   * (Should be empty in normal operation since timeout auto-resolves.)
   */
  getExpired(): ApprovalRequest[] {
    const now = Date.now();
    return [...this.pending.entries()]
      .filter(([, p]) => now > p.expiresAt)
      .map(([_, p]) => p.request);
  }

  // --- Internal helpers ---

  private recordOutcome(request: ApprovalRequest, outcome: ApprovalOutcome, responseTimeMs: number): void {
    const record: ApprovalRecord = {
      requestId: request.requestId,
      toolName: request.toolName,
      outcome,
      timestamp: Date.now(),
      responseTimeMs,
    };
    this.records.push(record);

    // Check escalation on rejection
    if (outcome === "rejected") {
      this.checkEscalation(request.toolName);
    }
  }

  /**
   * Get the time until which the tool is in cooldown.
   * Returns the last rejection timestamp + cooldownMs.
   */
  private getLastRejectionTime(toolName: string): number | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record.toolName === toolName && record.outcome === "rejected") {
        return record.timestamp + this.config.cooldownMs;
      }
    }
    return null;
  }

  /**
   * Get the lockout end time for a tool, if escalation has triggered.
   * Lockout = last rejection timestamp + lockoutMs, when rejections >= threshold within window.
   */
  private getLockoutUntil(toolName: string): number | null {
    const now = Date.now();
    const windowStart = now - this.config.escalationWindowMs;

    // Collect rejection timestamps within the window (forward = chronological)
    const rejectionTimestamps: number[] = [];
    for (const record of this.records) {
      if (record.timestamp < windowStart) continue;
      if (record.toolName === toolName && record.outcome === "rejected") {
        rejectionTimestamps.push(record.timestamp);
      }
    }

    if (rejectionTimestamps.length >= this.config.escalationThreshold && this.config.lockoutMs > 0) {
      // Lockout is based on the MOST RECENT rejection
      const lastRejectionTime = rejectionTimestamps[rejectionTimestamps.length - 1];
      return lastRejectionTime + this.config.lockoutMs;
    }
    return null;
  }

  private checkEscalation(toolName: string): void {
    const now = Date.now();
    const windowStart = now - this.config.escalationWindowMs;

    let rejectionCount = 0;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record.timestamp < windowStart) break;
      if (record.toolName === toolName && record.outcome === "rejected") {
        rejectionCount++;
      }
    }

    if (rejectionCount >= this.config.escalationThreshold) {
      const lockoutUntil = this.config.lockoutMs > 0 ? now + this.config.lockoutMs : null;
      this.escalationCallback?.({
        toolName,
        rejectionCount,
        windowMs: this.config.escalationWindowMs,
        lockoutUntil,
      });
    }
  }

  /**
   * Clear all records (useful for testing or periodic cleanup).
   */
  clearHistory(): void {
    this.records.length = 0;
  }
}
