/**
 * Token-bucket rate limiter for config and permission writes.
 *
 * Supports three tiers:
 *   - Global: shared pool across all agents (e.g. 60 tokens/minute)
 *   - Per-agent: individual agent budgets (e.g. 10 writes/hour)
 *   - Per-action: action-type budgets (e.g. 5 config-writes/minute)
 *
 * Each tier is independent — a request is rejected if ANY tier is exhausted.
 */

export interface RateLimitConfig {
  /** Global tokens per interval (all agents share this pool) */
  globalTokens: number;
  /** Global interval in milliseconds */
  globalIntervalMs: number;

  /** Per-agent tokens per interval */
  agentTokens: number;
  /** Per-agent interval in milliseconds */
  agentIntervalMs: number;

  /** Per-action tokens per interval */
  actionTokens: number;
  /** Per-action interval in milliseconds */
  actionIntervalMs: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  globalTokens: 60,
  globalIntervalMs: 60_000, // 1 minute

  agentTokens: 10,
  agentIntervalMs: 3_600_000, // 1 hour

  actionTokens: 5,
  actionIntervalMs: 60_000, // 1 minute
};

export interface RateLimitResult {
  allowed: boolean;
  /** Human-readable rejection reason (only set when allowed=false) */
  reason?: string;
  /** Milliseconds until the limiting bucket refills */
  retryAfterMs?: number;
}

/**
 * A single token-bucket tracker.
 */
class Bucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly intervalMs: number;

  constructor(maxTokens: number, intervalMs: number) {
    this.maxTokens = maxTokens;
    this.intervalMs = intervalMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Refill tokens based on elapsed time.
   * Returns the current token count after refill.
   */
  refill(): number {
    const now = Date.now();
    const elapsed = now - this.lastRefill;

    if (elapsed >= this.intervalMs) {
      // Full refill
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    } else if (elapsed > 0) {
      // Partial refill proportional to elapsed time
      const refillAmount = (elapsed / this.intervalMs) * this.maxTokens;
      this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
      this.lastRefill += elapsed;
    }

    return this.tokens;
  }

  /**
   * Try to consume `cost` tokens. Returns { allowed, retryAfterMs }.
   * If cost is 0, this is a peek — returns availability without consuming.
   */
  tryConsume(cost: number): RateLimitResult {
    const available = this.refill();

    if (cost === 0) {
      // Peek — don't consume
      if (available >= 1) {
        return { allowed: true };
      }
      // Calculate retry time even for peek
      const deficit = 1 - available;
      const tokensPerMs = this.maxTokens / this.intervalMs;
      const retryAfterMs = Math.max(Math.ceil(deficit / tokensPerMs), 1);
      return { allowed: false, retryAfterMs };
    }

    if (available >= cost) {
      this.tokens -= cost;
      return { allowed: true };
    }

    // Calculate when enough tokens will be available
    const deficit = cost - available;
    const tokensPerMs = this.maxTokens / this.intervalMs;
    const retryAfterMs = Math.max(Math.ceil(deficit / tokensPerMs), 1);

    return {
      allowed: false,
      retryAfterMs,
    };
  }

  /**
   * Return current available tokens (after refill) without consuming.
   */
  getRemaining(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Composite rate limiter with global, per-agent, and per-action tiers.
 *
 * Usage:
 *   const limiter = new RateLimiter();
 *   const result = limiter.tryConsume({ agentName: "coder", action: "update_config" });
 *   if (!result.allowed) {
 *     throw new Error(result.reason);
 *   }
 */
export class RateLimiter {
  private readonly globalBucket: Bucket;
  private readonly agentBuckets = new Map<string, Bucket>();
  private readonly actionBuckets = new Map<string, Bucket>();
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG) {
    this.config = config;
    this.globalBucket = new Bucket(config.globalTokens, config.globalIntervalMs);
  }

  /**
   * Attempt to consume a token across all tiers.
   * Returns false if ANY tier is exhausted.
   *
   * This method is atomic: it checks all tiers first, then consumes from
   * all of them only if every tier has capacity.
   */
  tryConsume(opts: {
    agentName?: string;
    action?: string;
  }): RateLimitResult {
    // Phase 1: Check all tiers (peek without consuming)
    const globalResult = this.globalBucket.tryConsume(0);
    if (!globalResult.allowed) {
      return {
        allowed: false,
        reason: `Global rate limit exceeded (${this.config.globalTokens} writes/${this.config.globalIntervalMs / 1000}s).`,
        retryAfterMs: globalResult.retryAfterMs,
      };
    }

    if (opts.agentName) {
      const agentBucket = this.getOrCreateAgentBucket(opts.agentName);
      const agentResult = agentBucket.tryConsume(0);
      if (!agentResult.allowed) {
        return {
          allowed: false,
          reason: `Per-agent rate limit exceeded for "${opts.agentName}" (${this.config.agentTokens} writes/${this.config.agentIntervalMs / 1000}s).`,
          retryAfterMs: agentResult.retryAfterMs,
        };
      }
    }

    if (opts.action) {
      const actionBucket = this.getOrCreateActionBucket(opts.action);
      const actionResult = actionBucket.tryConsume(0);
      if (!actionResult.allowed) {
        return {
          allowed: false,
          reason: `Per-action rate limit exceeded for "${opts.action}" (${this.config.actionTokens} writes/${this.config.actionIntervalMs / 1000}s).`,
          retryAfterMs: actionResult.retryAfterMs,
        };
      }
    }

    // Phase 2: All checks passed — consume tokens from all buckets
    this.globalBucket.tryConsume(1);
    if (opts.agentName) {
      this.getOrCreateAgentBucket(opts.agentName).tryConsume(1);
    }
    if (opts.action) {
      this.getOrCreateActionBucket(opts.action).tryConsume(1);
    }

    return { allowed: true };
  }

  /**
   * Get current status for a given agent/action combination.
   * Useful for debugging and monitoring.
   */
  getStatus(opts: {
    agentName?: string;
    action?: string;
  }): {
    global: { remaining: number; max: number; intervalMs: number };
    agent?: { remaining: number; max: number; intervalMs: number };
    action?: { remaining: number; max: number; intervalMs: number };
  } {
    const status: {
      global: { remaining: number; max: number; intervalMs: number };
      agent?: { remaining: number; max: number; intervalMs: number };
      action?: { remaining: number; max: number; intervalMs: number };
    } = {
      global: {
        remaining: this.globalBucket.getRemaining(),
        max: this.config.globalTokens,
        intervalMs: this.config.globalIntervalMs,
      },
    };

    if (opts.agentName) {
      const bucket = this.agentBuckets.get(opts.agentName);
      if (bucket) {
        status.agent = {
          remaining: bucket.getRemaining(),
          max: this.config.agentTokens,
          intervalMs: this.config.agentIntervalMs,
        };
      }
    }

    if (opts.action) {
      const bucket = this.actionBuckets.get(opts.action);
      if (bucket) {
        status.action = {
          remaining: bucket.getRemaining(),
          max: this.config.actionTokens,
          intervalMs: this.config.actionIntervalMs,
        };
      }
    }

    return status;
  }

  private getOrCreateAgentBucket(agentName: string): Bucket {
    let bucket = this.agentBuckets.get(agentName);
    if (!bucket) {
      bucket = new Bucket(this.config.agentTokens, this.config.agentIntervalMs);
      this.agentBuckets.set(agentName, bucket);
    }
    return bucket;
  }

  private getOrCreateActionBucket(action: string): Bucket {
    let bucket = this.actionBuckets.get(action);
    if (!bucket) {
      bucket = new Bucket(this.config.actionTokens, this.config.actionIntervalMs);
      this.actionBuckets.set(action, bucket);
    }
    return bucket;
  }
}

/**
 * Format a rate-limit rejection message for the user.
 */
export function formatRateLimitError(result: RateLimitResult): string {
  const parts = [`Rate limit exceeded: ${result.reason}`];
  if (result.retryAfterMs) {
    const seconds = Math.ceil(result.retryAfterMs / 1000);
    parts.push(`Please retry after ${seconds}s.`);
  }
  return parts.join(" ");
}
