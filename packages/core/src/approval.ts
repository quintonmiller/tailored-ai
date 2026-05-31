import { randomUUID } from "node:crypto";

// --- Permission rule types ---

export interface PermissionRule {
  /** Map of tool parameter names to regex patterns. All must match for the rule to apply. Empty = catch-all. */
  match: Record<string, string>;
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
    if (value === undefined || value === null) return false;
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
