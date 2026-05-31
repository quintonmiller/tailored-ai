/**
 * TAI extension of the always-HITL action classes. The basic types
 * (ActionClass, AlwaysHitlConfig, DEFAULT_ALWAYS_HITL, resolve,
 * isAlwaysHitl, classifyButtonText) live in
 * `@tailored-ai/browser-mediator`. TAI adds operator-facing UX helpers
 * around them — MediatorState for the approval card, the override
 * shape, and a string formatter — that are too app-specific for the
 * upstream package.
 */
export {
  type ActionClass,
  type AlwaysHitlConfig,
  classifyButtonText,
  DEFAULT_ALWAYS_HITL,
  isAlwaysHitl,
  resolveAlwaysHitl,
} from "@tailored-ai/browser-mediator";

import type { AlwaysHitlConfig } from "@tailored-ai/browser-mediator";
import { type ActionClass, DEFAULT_ALWAYS_HITL, isAlwaysHitl } from "@tailored-ai/browser-mediator";

/**
 * State the mediator extracts before presenting an approval card.
 * TAI-specific — the operator sees what's about to commit, not what
 * the agent claims.
 */
export interface MediatorState {
  cartItems: CartItem[];
  total: string;
  shipToZipLast4: string;
  paymentLast4: string;
}

export interface CartItem {
  name: string;
  quantity: number;
  price: string;
}

/** Whether a class is always-HITL on the default (no domain config) list. */
export function isAlwaysHitlDefault(actionClass: ActionClass): boolean {
  return DEFAULT_ALWAYS_HITL.includes(actionClass);
}

/**
 * HITL evaluation result. When `override` is true, any workflow
 * auto-approval is ignored and the action MUST go through HITL.
 */
export interface HitlOverride {
  override: boolean;
  actionClass: ActionClass;
  state: MediatorState;
}

export function evaluateAlwaysHitl(
  actionClass: ActionClass,
  domain: string,
  domainConfig: Record<string, AlwaysHitlConfig>,
  mediatorState: MediatorState,
): HitlOverride {
  return {
    override: isAlwaysHitl(actionClass, domain, domainConfig),
    actionClass,
    state: mediatorState,
  };
}

/** Pretty-print mediator state for an approval card. */
export function formatMediatorState(state: MediatorState): string {
  const lines: string[] = [];
  if (state.cartItems.length > 0) {
    lines.push("Cart:");
    for (const item of state.cartItems) {
      lines.push(`  - ${item.name} × ${item.quantity} @ ${item.price}`);
    }
  }
  lines.push(`Total: ${state.total}`);
  lines.push(`Ship to: ****${state.shipToZipLast4}`);
  lines.push(`Payment: ****${state.paymentLast4}`);
  return lines.join("\n");
}
