import type { ApprovalCard, ExecutorContext, TrustedAction, ValidationResult } from "../types.js";

/**
 * Action handler — the registered shape. Most adapters supply a full
 * TrustedAction; tests sometimes register a bare execute() handler, so
 * validate/describeForApproval are optional here.
 */
export interface ActionHandler {
  type?: string;
  validate?: (input: Record<string, unknown>) => ValidationResult;
  describeForApproval?: (input: Record<string, unknown>) => Promise<ApprovalCard>;
  execute(input: Record<string, unknown>, ctx?: ExecutorContext): Promise<Record<string, unknown>>;
}

const registry = new Map<string, ActionHandler>();

/**
 * Register an action handler. Accepts either a full TrustedAction
 * implementation or a minimal `{ execute }` wrapper.
 */
export function register(
  type: string,
  handler: ActionHandler | TrustedAction<Record<string, unknown>, Record<string, unknown>> | ActionHandler["execute"],
): void {
  if (typeof handler === "function") {
    registry.set(type, { type, execute: handler });
    return;
  }
  registry.set(type, handler as ActionHandler);
}

export function get(type: string): ActionHandler | undefined {
  return registry.get(type);
}

export function listTypes(): string[] {
  return [...registry.keys()];
}

/** Test helper. */
export function __clearRegistry(): void {
  registry.clear();
}
