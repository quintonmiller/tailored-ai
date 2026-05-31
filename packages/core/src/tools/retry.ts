/** Shared retry utility with exponential backoff for tool operations. */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 2). */
  retries?: number;
  /** Initial delay in ms before first retry (default: 500). Doubles on each subsequent retry. */
  initialDelayMs?: number;
  /** Only retry when this returns true for the caught error (default: retry all). */
  shouldRetry?: (err: Error) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  retries: 2,
  initialDelayMs: 500,
  shouldRetry: () => true,
};

/** Returns true for errors that are likely transient (network issues, rate limits, server errors). */
export function isTransientError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  if (msg.includes("fetch failed") || msg.includes("econnrefused") || msg.includes("econnreset")) return true;
  if (msg.includes("enotfound") || msg.includes("etimedout") || msg.includes("socket hang up")) return true;
  if (msg.includes("503") || msg.includes("502") || msg.includes("429")) return true;
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const { retries, initialDelayMs, shouldRetry } = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries && shouldRetry(lastError)) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }
  throw lastError;
}
