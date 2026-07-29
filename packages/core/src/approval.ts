import { randomUUID } from "node:crypto";

// --- Permission rule types ---

export interface PermissionRule {
  /**
   * Map of tool parameter names to regex patterns. All must match for the rule
   * to apply. Empty = catch-all.
   *
   * A `null` pattern means **the argument must be absent**. That case was
   * previously inexpressible: any missing argument failed the match outright,
   * so a rule could only ever describe what the model *did* pass. The dangerous
   * call is often the one that passes nothing and takes a default — an
   * unscoped write, an unfiltered query — and no rule could reach it.
   */
  match: Record<string, string | null>;
  /** What to do when this rule matches. */
  action: "auto" | "approve";
}

export interface ToolPermissionConfig {
  mode: "auto" | "approve" | "conditional";
  rules?: PermissionRule[];
}

export interface PermissionsConfig {
  /** Fallback mode for tools without explicit config. Default: "auto". */
  defaultMode: "auto" | "approve";
  /**
   * What to do when a call needs approval but nothing can ask: cron, rooms, the
   * task watcher, webhooks — every path without a human attached.
   *
   * `"auto"` (default) runs it anyway, which is what the code always did. That
   * is deliberate back-compat: flipping it would stop autonomous runs that have
   * worked for months, and a guard that breaks the thing it protects is the
   * failure mode this codebase keeps hitting. It now logs instead of passing in
   * silence.
   *
   * `"reject"` refuses the call and tells the agent why, which is what a
   * deployment wanting its `approve` rules to mean something on headless paths
   * should set.
   */
  noHandlerAction?: "auto" | "reject";
  /** Timeout in ms for approval requests. 0 = wait forever. Default: 300000 (5 min). */
  timeoutMs: number;
  /** What to do when timeout expires. Default: "reject". */
  timeoutAction: "reject" | "auto_approve";
  /** Per-tool permission config. */
  tools: Record<string, ToolPermissionConfig>;
}

// --- Approval request/response types ---

export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  sessionId: string;
  description: string;
}

export interface ApprovalResponse {
  approved: boolean;
  reason?: string;
  responseTimeMs: number;
}

export interface ApprovalHandler {
  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse>;
}

// --- Pure evaluation function ---

/**
 * Evaluate whether a tool call should be auto-approved, require approval, or is disabled.
 * Pure function — no side effects, fully unit-testable.
 */
export function evaluatePermission(
  toolName: string,
  args: Record<string, unknown>,
  permissions: PermissionsConfig | undefined,
): "auto" | "approve" {
  if (!permissions) return "auto";

  const toolConfig = permissions.tools[toolName];
  if (!toolConfig) {
    return permissions.defaultMode ?? "auto";
  }

  if (toolConfig.mode === "auto") return "auto";
  if (toolConfig.mode === "approve") return "approve";

  // mode === "conditional" — evaluate rules with first-match-wins
  if (toolConfig.rules) {
    for (const rule of toolConfig.rules) {
      if (matchesRule(rule, args)) {
        return rule.action;
      }
    }
  }

  // No rule matched — fall back to defaultMode
  return permissions.defaultMode ?? "auto";
}

/** Check if all patterns in a rule match the given args. Empty match = catch-all. */
function matchesRule(rule: PermissionRule, args: Record<string, unknown>): boolean {
  const entries = Object.entries(rule.match);
  if (entries.length === 0) return true; // catch-all

  for (const [paramName, pattern] of entries) {
    const value = args[paramName];
    // An empty string counts as absent. Models routinely emit `scope: ""` for
    // "I did not set this", and the tools in this codebase already read it that
    // way — a rule that disagreed with the tool it governs would be worse than
    // no rule.
    const absent = value === undefined || value === null || value === "";

    // `null` pattern: the rule wants this argument NOT to be there.
    if (pattern === null) {
      if (!absent) return false;
      continue;
    }

    if (absent) return false;
    try {
      const regex = new RegExp(pattern);
      if (!regex.test(String(value))) return false;
    } catch {
      // Invalid regex — treat as non-match
      return false;
    }
  }
  return true;
}

/** Create a unique approval request ID. */
export function createApprovalRequestId(): string {
  return `apr_${randomUUID().slice(0, 8)}`;
}

/** Format a human-readable description of a tool call for approval prompts. */
export function formatApprovalDescription(toolName: string, args: Record<string, unknown>): string {
  const argSummary = Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 80 ? `${s.slice(0, 80)}...` : s}`;
    })
    .join(", ");
  return `${toolName}(${argSummary})`;
}
