/**
 * Always-HITL action classes. Certain click targets — place-order,
 * payment-form submit, account-delete — should refuse to fire from
 * the LLM no matter how confident the matcher is. The mediator
 * classifies a click target's visible text and refuses when a class
 * applies; the caller is expected to surface the refusal to the
 * operator (e.g. enqueue a separate approval).
 */

export type ActionClass = "submit" | "place-order" | "payment-form-fill" | "navigate-to-checkout-confirm";

export interface AlwaysHitlConfig {
  /** Action classes that always require approval on this domain. */
  actionClasses: ActionClass[];
}

export const DEFAULT_ALWAYS_HITL: readonly ActionClass[] = [
  "submit",
  "place-order",
  "payment-form-fill",
  "navigate-to-checkout-confirm",
];

export function resolveAlwaysHitl(
  domain: string,
  domainConfig: Record<string, AlwaysHitlConfig>,
): readonly ActionClass[] {
  return domainConfig[domain]?.actionClasses ?? DEFAULT_ALWAYS_HITL;
}

export function isAlwaysHitl(
  actionClass: ActionClass,
  domain: string,
  domainConfig: Record<string, AlwaysHitlConfig>,
): boolean {
  return resolveAlwaysHitl(domain, domainConfig).includes(actionClass);
}

/** Pattern -> action class table used by the mediator's click classifier. */
const ALWAYS_HITL_BUTTON_PATTERNS: Array<{ pattern: RegExp; cls: ActionClass }> = [
  { pattern: /^\s*(place|submit)\s+(your\s+)?order\s*$/i, cls: "place-order" },
  { pattern: /^\s*confirm\s+(purchase|order)\s*$/i, cls: "place-order" },
  { pattern: /^\s*pay\s+(now|\$|\d)/i, cls: "payment-form-fill" },
  { pattern: /^\s*submit\s+payment\s*$/i, cls: "payment-form-fill" },
  { pattern: /^\s*(use|continue\s+with)\s+this\s+payment/i, cls: "payment-form-fill" },
  { pattern: /^\s*proceed\s+to\s+checkout\s*$/i, cls: "navigate-to-checkout-confirm" },
  { pattern: /^\s*submit\s*$/i, cls: "submit" },
];

export function classifyButtonText(text: string): ActionClass | null {
  for (const { pattern, cls } of ALWAYS_HITL_BUTTON_PATTERNS) {
    if (pattern.test(text)) return cls;
  }
  return null;
}
