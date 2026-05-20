import { describe, expect, it } from "vitest";
import { RateLimiter, DEFAULT_RATE_LIMIT_CONFIG, formatRateLimitError } from "../rate-limiter.js";

describe("RateLimiter", () => {
  it("allows requests within limits", () => {
    const limiter = new RateLimiter({
      globalTokens: 3,
      globalIntervalMs: 60_000,
      agentTokens: 2,
      agentIntervalMs: 60_000,
      actionTokens: 2,
      actionIntervalMs: 60_000,
    });

    const result1 = limiter.tryConsume({ agentName: "coder", action: "update_config" });
    expect(result1.allowed).toBe(true);

    const result2 = limiter.tryConsume({ agentName: "coder", action: "update_config" });
    expect(result2.allowed).toBe(true);
  });

  it("rejects when global limit exceeded", () => {
    const limiter = new RateLimiter({
      globalTokens: 2,
      globalIntervalMs: 60_000,
      agentTokens: 100,
      agentIntervalMs: 60_000,
      actionTokens: 100,
      actionIntervalMs: 60_000,
    });

    limiter.tryConsume({ agentName: "a1", action: "x" });
    limiter.tryConsume({ agentName: "a2", action: "y" });

    const result = limiter.tryConsume({ agentName: "a3", action: "z" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Global rate limit exceeded/);
    expect(result.retryAfterMs).toBeDefined();
  });

  it("rejects when per-agent limit exceeded", () => {
    const limiter = new RateLimiter({
      globalTokens: 100,
      globalIntervalMs: 60_000,
      agentTokens: 2,
      agentIntervalMs: 60_000,
      actionTokens: 100,
      actionIntervalMs: 60_000,
    });

    limiter.tryConsume({ agentName: "coder", action: "a1" });
    limiter.tryConsume({ agentName: "coder", action: "a2" });

    const result = limiter.tryConsume({ agentName: "coder", action: "a3" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Per-agent rate limit exceeded/);
  });

  it("rejects when per-action limit exceeded", () => {
    const limiter = new RateLimiter({
      globalTokens: 100,
      globalIntervalMs: 60_000,
      agentTokens: 100,
      agentIntervalMs: 60_000,
      actionTokens: 2,
      actionIntervalMs: 60_000,
    });

    limiter.tryConsume({ agentName: "a1", action: "update_config" });
    limiter.tryConsume({ agentName: "a2", action: "update_config" });

    const result = limiter.tryConsume({ agentName: "a3", action: "update_config" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Per-action rate limit exceeded/);
  });

  it("allows different agents after one hits per-agent limit", () => {
    const limiter = new RateLimiter({
      globalTokens: 100,
      globalIntervalMs: 60_000,
      agentTokens: 1,
      agentIntervalMs: 60_000,
      actionTokens: 100,
      actionIntervalMs: 60_000,
    });

    limiter.tryConsume({ agentName: "coder", action: "x" });

    // Different agent should still work
    const result = limiter.tryConsume({ agentName: "reviewer", action: "x" });
    expect(result.allowed).toBe(true);
  });

  it("allows different actions after one hits per-action limit", () => {
    const limiter = new RateLimiter({
      globalTokens: 100,
      globalIntervalMs: 60_000,
      agentTokens: 100,
      agentIntervalMs: 60_000,
      actionTokens: 1,
      actionIntervalMs: 60_000,
    });

    limiter.tryConsume({ agentName: "a1", action: "update_config" });

    // Different action should still work
    const result = limiter.tryConsume({ agentName: "a1", action: "create_tool" });
    expect(result.allowed).toBe(true);
  });

  it("works without agentName or action", () => {
    const limiter = new RateLimiter({
      globalTokens: 2,
      globalIntervalMs: 60_000,
      agentTokens: 100,
      agentIntervalMs: 60_000,
      actionTokens: 100,
      actionIntervalMs: 60_000,
    });

    const result1 = limiter.tryConsume({});
    expect(result1.allowed).toBe(true);

    const result2 = limiter.tryConsume({});
    expect(result2.allowed).toBe(true);

    const result3 = limiter.tryConsume({});
    expect(result3.allowed).toBe(false);
  });

  it("provides status via getStatus", () => {
    const limiter = new RateLimiter({
      globalTokens: 5,
      globalIntervalMs: 60_000,
      agentTokens: 3,
      agentIntervalMs: 60_000,
      actionTokens: 3,
      actionIntervalMs: 60_000,
    });

    limiter.tryConsume({ agentName: "coder", action: "update_config" });

    const status = limiter.getStatus({ agentName: "coder", action: "update_config" });
    expect(status.global.remaining).toBeLessThan(5);
    expect(status.global.max).toBe(5);
    expect(status.agent?.remaining).toBeLessThan(3);
    expect(status.action?.remaining).toBeLessThan(3);
  });

  it("uses default config when no config provided", () => {
    const limiter = new RateLimiter();
    const result = limiter.tryConsume({ agentName: "test", action: "test" });
    expect(result.allowed).toBe(true);
  });
});

describe("formatRateLimitError", () => {
  it("formats error with retry time", () => {
    const result = {
      allowed: false as const,
      reason: "Global rate limit exceeded (60 writes/60s).",
      retryAfterMs: 5500,
    };
    const msg = formatRateLimitError(result);
    expect(msg).toContain("Rate limit exceeded");
    expect(msg).toContain("Please retry after 6s");
  });

  it("formats error without retry time", () => {
    const result = {
      allowed: false as const,
      reason: "Per-agent limit exceeded",
    };
    const msg = formatRateLimitError(result);
    expect(msg).toBe("Rate limit exceeded: Per-agent limit exceeded");
  });
});
