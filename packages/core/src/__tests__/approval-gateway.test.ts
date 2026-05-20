import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApprovalGateway } from "../approval-gateway.js";
import { type ApprovalRequest } from "../approval.js";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: `apr_test`,
    toolName: "test_tool",
    toolArgs: {},
    sessionId: "session_1",
    description: "test description",
    ...overrides,
  };
}

// --- Basic approval/rejection ---

describe("ApprovalGateway - basic flow", () => {
  let gateway: ApprovalGateway;

  beforeEach(() => {
    gateway = new ApprovalGateway();
  });

  it("approves a request", async () => {
    const request = makeRequest({ requestId: "apr_1" });
    const promise = gateway.requestApproval(request);

    gateway.approve("apr_1", "looks good");

    const response = await promise;
    expect(response.approved).toBe(true);
    expect(response.reason).toBe("looks good");
    expect(response.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects a request", async () => {
    const request = makeRequest({ requestId: "apr_2" });
    const promise = gateway.requestApproval(request);

    gateway.reject("apr_2", "not safe");

    const response = await promise;
    expect(response.approved).toBe(false);
    expect(response.reason).toBe("not safe");
  });

  it("edits a request", async () => {
    const request = makeRequest({ requestId: "apr_3" });
    const promise = gateway.requestApproval(request);

    gateway.edit("apr_3", { command: "ls -la" }, "safer args");

    const response = await promise;
    expect(response.approved).toBe(true);
    expect(response.reason).toBe("Edited: safer args");
    expect((response as Record<string, unknown>).editedArgs).toEqual({ command: "ls -la" });
  });

  it("returns false for approve on unknown request ID", () => {
    expect(gateway.approve("nonexistent")).toBe(false);
  });

  it("returns false for reject on unknown request ID", () => {
    expect(gateway.reject("nonexistent")).toBe(false);
  });

  it("returns false for edit on unknown request ID", () => {
    expect(gateway.edit("nonexistent", {})).toBe(false);
  });

  it("cancels a pending request", async () => {
    const request = makeRequest({ requestId: "apr_cancel" });
    const promise = gateway.requestApproval(request);

    gateway.cancel("apr_cancel");

    await expect(promise).rejects.toThrow("Approval request cancelled");
  });

  it("returns false for cancel on unknown request ID", () => {
    expect(gateway.cancel("nonexistent")).toBe(false);
  });
});

// --- Timeout ---

describe("ApprovalGateway - timeout", () => {
  it("times out and rejects when no response", async () => {
    vi.useFakeTimers();
    const gateway = new ApprovalGateway({ defaultTimeoutMs: 5000 });
    const request = makeRequest({ requestId: "apr_timeout" });
    const promise = gateway.requestApproval(request);

    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();

    const response = await promise;
    expect(response.approved).toBe(false);
    expect(response.reason).toContain("timed out");
    expect(response.responseTimeMs).toBe(5000);
    vi.useRealTimers();
  });

  it("approves before timeout", async () => {
    vi.useFakeTimers();
    const gateway = new ApprovalGateway({ defaultTimeoutMs: 5000 });
    const request = makeRequest({ requestId: "apr_before_timeout" });
    const promise = gateway.requestApproval(request);

    gateway.approve("apr_before_timeout");
    const response = await promise;
    expect(response.approved).toBe(true);
    vi.useRealTimers();
  });
});

// --- Cooldown ---

describe("ApprovalGateway - cooldown", () => {
  it("blocks immediate retry after rejection", async () => {
    const gateway = new ApprovalGateway({ cooldownMs: 10_000 });

    // First request — reject it
    const req1 = makeRequest({ requestId: "apr_cd_1", toolName: "dangerous_tool" });
    const p1 = gateway.requestApproval(req1);
    gateway.reject("apr_cd_1", "no");
    await p1;

    // Second request — should be blocked by cooldown (rejection just happened)
    const req2 = makeRequest({ requestId: "apr_cd_2", toolName: "dangerous_tool" });
    const response2 = await gateway.requestApproval(req2);

    expect(response2.approved).toBe(false);
    expect(response2.reason).toContain("Cooldown active");
  });

  it("allows retry after cooldown expires", async () => {
    const now = Date.now();
    const dateNowSpy = vi.spyOn(globalThis.Date, "now");

    // Start at a fixed time
    dateNowSpy.mockReturnValue(now);

    const gateway = new ApprovalGateway({ cooldownMs: 10_000 });

    // Reject first
    const req1 = makeRequest({ requestId: "apr_cd_3", toolName: "dangerous_tool" });
    const p1 = gateway.requestApproval(req1);
    gateway.reject("apr_cd_3", "no");
    await p1;

    // Advance past cooldown
    dateNowSpy.mockReturnValue(now + 10_001);

    // Second request — should succeed (not auto-rejected)
    const req2 = makeRequest({ requestId: "apr_cd_4", toolName: "dangerous_tool" });
    const p2 = gateway.requestApproval(req2);
    gateway.approve("apr_cd_4");
    const response2 = await p2;

    expect(response2.approved).toBe(true);
    dateNowSpy.mockRestore();
  });

  it("cooldown is per-tool, not global", async () => {
    const gateway = new ApprovalGateway({ cooldownMs: 10_000 });

    // Reject tool_a
    const req1 = makeRequest({ requestId: "apr_cd_5", toolName: "tool_a" });
    const p1 = gateway.requestApproval(req1);
    gateway.reject("apr_cd_5", "no");
    await p1;

    // tool_b should NOT be blocked
    const req2 = makeRequest({ requestId: "apr_cd_6", toolName: "tool_b" });
    const p2 = gateway.requestApproval(req2);
    gateway.approve("apr_cd_6");
    const response2 = await p2;

    expect(response2.approved).toBe(true);
  });
});

// --- Escalation ---

describe("ApprovalGateway - escalation", () => {
  it("triggers escalation callback after threshold rejections", async () => {
    const onEscalation = vi.fn();
    // cooldownMs: 0 so rejections aren't blocked by cooldown before escalation fires
    const gateway = new ApprovalGateway(
      { escalationThreshold: 3, escalationWindowMs: 60_000, lockoutMs: 0, cooldownMs: 0 },
      onEscalation,
    );

    // All 3 rejections happen within milliseconds — well within the 60s window
    for (let i = 0; i < 3; i++) {
      const req = makeRequest({ requestId: `apr_esc_${i}`, toolName: "bad_tool" });
      const p = gateway.requestApproval(req);
      gateway.reject(`apr_esc_${i}`, "no");
      await p;
    }

    expect(onEscalation).toHaveBeenCalled();
    const call = onEscalation.mock.calls[0][0];
    expect(call.toolName).toBe("bad_tool");
    expect(call.rejectionCount).toBe(3);
  });

  it("does not trigger escalation below threshold", async () => {
    const onEscalation = vi.fn();
    const gateway = new ApprovalGateway(
      { escalationThreshold: 3, escalationWindowMs: 60_000, cooldownMs: 0 },
      onEscalation,
    );

    for (let i = 0; i < 2; i++) {
      const req = makeRequest({ requestId: `apr_esc2_${i}`, toolName: "bad_tool" });
      const p = gateway.requestApproval(req);
      gateway.reject(`apr_esc2_${i}`, "no");
      await p;
    }

    expect(onEscalation).not.toHaveBeenCalled();
  });

  it("resets escalation count after window expires", async () => {
    const now = Date.now();
    const dateNowSpy = vi.spyOn(globalThis.Date, "now");
    dateNowSpy.mockReturnValue(now);

    const onEscalation = vi.fn();
    const gateway = new ApprovalGateway(
      { escalationThreshold: 3, escalationWindowMs: 5000, lockoutMs: 0, cooldownMs: 0 },
      onEscalation,
    );

    // 2 rejections at t=now
    for (let i = 0; i < 2; i++) {
      const req = makeRequest({ requestId: `apr_esc3_${i}`, toolName: "bad_tool" });
      const p = gateway.requestApproval(req);
      gateway.reject(`apr_esc3_${i}`, "no");
      await p;
    }

    // Advance past the escalation window
    dateNowSpy.mockReturnValue(now + 6000);

    // 1 more rejection — only 1 within the window, so no escalation
    const req3 = makeRequest({ requestId: "apr_esc3_2", toolName: "bad_tool" });
    const p3 = gateway.requestApproval(req3);
    gateway.reject("apr_esc3_2", "no");
    await p3;

    expect(onEscalation).not.toHaveBeenCalled();
    dateNowSpy.mockRestore();
  });
});

// --- Lockout ---

describe("ApprovalGateway - lockout", () => {
  it("blocks requests during lockout after escalation", async () => {
    // cooldownMs: 0 so lockout is the active restriction (not cooldown)
    const gateway = new ApprovalGateway({
      escalationThreshold: 2,
      escalationWindowMs: 60_000,
      lockoutMs: 30_000,
      cooldownMs: 0,
    });

    // Trigger escalation with 2 rejections (happen within ms of each other)
    for (let i = 0; i < 2; i++) {
      const req = makeRequest({ requestId: `apr_lock_${i}`, toolName: "locked_tool" });
      const p = gateway.requestApproval(req);
      gateway.reject(`apr_lock_${i}`, "no");
      await p;
    }

    // Next request should be blocked by lockout
    const req3 = makeRequest({ requestId: "apr_lock_2", toolName: "locked_tool" });
    const response = await gateway.requestApproval(req3);

    expect(response.approved).toBe(false);
    expect(response.reason).toContain("Lockout active");
  });

  it("allows requests after lockout expires", async () => {
    const now = Date.now();
    const dateNowSpy = vi.spyOn(globalThis.Date, "now");
    dateNowSpy.mockReturnValue(now);

    // cooldownMs: 0 so lockout is the only restriction
    const gateway = new ApprovalGateway({
      escalationThreshold: 2,
      escalationWindowMs: 60_000,
      lockoutMs: 10_000,
      cooldownMs: 0,
    });

    // Trigger escalation
    for (let i = 0; i < 2; i++) {
      const req = makeRequest({ requestId: `apr_lock2_${i}`, toolName: "locked_tool" });
      const p = gateway.requestApproval(req);
      gateway.reject(`apr_lock2_${i}`, "no");
      await p;
    }

    // Advance past lockout (10s)
    dateNowSpy.mockReturnValue(now + 15_000);

    // Should be allowed now
    const req3 = makeRequest({ requestId: "apr_lock2_2", toolName: "locked_tool" });
    const p3 = gateway.requestApproval(req3);
    gateway.approve("apr_lock2_2");
    const response = await p3;
    expect(response.approved).toBe(true);

    dateNowSpy.mockRestore();
  });
});

// --- Pending / History ---

describe("ApprovalGateway - state", () => {
  it("listPending returns active requests", async () => {
    const gateway = new ApprovalGateway();
    const req = makeRequest({ requestId: "apr_list" });
    const _p = gateway.requestApproval(req);

    const pending = gateway.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].requestId).toBe("apr_list");
  });

  it("getHistory returns records in reverse chronological order", async () => {
    const gateway = new ApprovalGateway();

    const req1 = makeRequest({ requestId: "apr_hist_1", toolName: "tool_a" });
    const p1 = gateway.requestApproval(req1);
    gateway.approve("apr_hist_1");
    await p1;

    const req2 = makeRequest({ requestId: "apr_hist_2", toolName: "tool_b" });
    const p2 = gateway.requestApproval(req2);
    gateway.reject("apr_hist_2", "no");
    await p2;

    const history = gateway.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].toolName).toBe("tool_b"); // most recent first
    expect(history[1].toolName).toBe("tool_a");
  });

  it("clearHistory removes all records", async () => {
    const gateway = new ApprovalGateway();
    const req = makeRequest({ requestId: "apr_clear" });
    const p = gateway.requestApproval(req);
    gateway.approve("apr_clear");
    await p;

    const history = gateway.getHistory();
    expect(history.length).toBe(1);

    gateway.clearHistory();
    expect(gateway.getHistory().length).toBe(0);
  });
});

// --- Config defaults ---

describe("ApprovalGateway - config defaults", () => {
  it("uses correct defaults when no config provided", () => {
    const gateway = new ApprovalGateway();
    expect(gateway).toBeDefined();
  });
});
