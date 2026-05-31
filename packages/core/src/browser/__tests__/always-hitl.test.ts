import { describe, expect, it } from "vitest";
import {
  type AlwaysHitlConfig,
  DEFAULT_ALWAYS_HITL,
  evaluateAlwaysHitl,
  formatMediatorState,
  isAlwaysHitl,
  isAlwaysHitlDefault,
  type MediatorState,
  resolveAlwaysHitl,
} from "../always-hitl.js";

const defaultState: MediatorState = {
  cartItems: [{ name: "Widget", quantity: 1, price: "$29.99" }],
  total: "$29.99",
  shipToZipLast4: "1234",
  paymentLast4: "5678",
};

describe("DEFAULT_ALWAYS_HITL", () => {
  it("contains the four canonical action classes", () => {
    expect(DEFAULT_ALWAYS_HITL).toContain("submit");
    expect(DEFAULT_ALWAYS_HITL).toContain("place-order");
    expect(DEFAULT_ALWAYS_HITL).toContain("payment-form-fill");
    expect(DEFAULT_ALWAYS_HITL).toContain("navigate-to-checkout-confirm");
  });
});

describe("isAlwaysHitlDefault", () => {
  it("returns true for default action classes", () => {
    expect(isAlwaysHitlDefault("submit")).toBe(true);
    expect(isAlwaysHitlDefault("place-order")).toBe(true);
    expect(isAlwaysHitlDefault("payment-form-fill")).toBe(true);
    expect(isAlwaysHitlDefault("navigate-to-checkout-confirm")).toBe(true);
  });

  it("returns false for unknown action classes", () => {
    // @ts-expect-error — testing unknown action class
    expect(isAlwaysHitlDefault("unknown-action")).toBe(false);
  });
});

describe("resolveAlwaysHitl", () => {
  it("returns default list when no domain config exists", () => {
    const config: Record<string, AlwaysHitlConfig> = {};
    expect(resolveAlwaysHitl("example.com", config)).toEqual(DEFAULT_ALWAYS_HITL);
  });

  it("uses domain-specific config when provided", () => {
    const config: Record<string, AlwaysHitlConfig> = {
      "shop.example.com": {
        actionClasses: ["place-order"],
      },
    };
    expect(resolveAlwaysHitl("shop.example.com", config)).toEqual(["place-order"]);
  });

  it("empty actionClasses list means no forced HITL", () => {
    const config: Record<string, AlwaysHitlConfig> = {
      "trusted.example.com": {
        actionClasses: [],
      },
    };
    expect(resolveAlwaysHitl("trusted.example.com", config)).toEqual([]);
  });
});

describe("isAlwaysHitl", () => {
  it("returns true for default action classes with no config", () => {
    const config: Record<string, AlwaysHitlConfig> = {};
    expect(isAlwaysHitl("submit", "example.com", config)).toBe(true);
    expect(isAlwaysHitl("place-order", "example.com", config)).toBe(true);
  });

  it("respects domain-specific override", () => {
    const config: Record<string, AlwaysHitlConfig> = {
      "shop.example.com": {
        actionClasses: ["place-order"],
      },
    };
    // "place-order" is in the domain config
    expect(isAlwaysHitl("place-order", "shop.example.com", config)).toBe(true);
    // "submit" is NOT in the domain config (domain overrides defaults)
    expect(isAlwaysHitl("submit", "shop.example.com", config)).toBe(false);
  });

  it("unknown action class is NOT always-HITL (default-deny)", () => {
    const config: Record<string, AlwaysHitlConfig> = {};
    // @ts-expect-error — testing unknown action class
    expect(isAlwaysHitl("random-action", "example.com", config)).toBe(false);
  });
});

describe("evaluateAlwaysHitl", () => {
  it("fires override for place-order even when workflow says auto", () => {
    const result = evaluateAlwaysHitl("place-order", "shop.example.com", {}, defaultState);
    expect(result.override).toBe(true);
    expect(result.actionClass).toBe("place-order");
    expect(result.state).toBe(defaultState);
  });

  it("fires override for submit", () => {
    const result = evaluateAlwaysHitl("submit", "example.com", {}, defaultState);
    expect(result.override).toBe(true);
  });

  it("fires override for payment-form-fill", () => {
    const result = evaluateAlwaysHitl("payment-form-fill", "example.com", {}, defaultState);
    expect(result.override).toBe(true);
  });

  it("fires override for navigate-to-checkout-confirm", () => {
    const result = evaluateAlwaysHitl("navigate-to-checkout-confirm", "example.com", {}, defaultState);
    expect(result.override).toBe(true);
  });

  it("does NOT fire override when domain config excludes the action", () => {
    const config: Record<string, AlwaysHitlConfig> = {
      "trusted.example.com": {
        actionClasses: ["place-order"],
      },
    };
    const result = evaluateAlwaysHitl("submit", "trusted.example.com", config, defaultState);
    expect(result.override).toBe(false);
  });

  it("bypass-attempt: workflow says 'click place-order is fine' but action-class override fires", () => {
    // This is the key test: even if a workflow auto-approves the action,
    // the always-HITL override should still fire.
    const config: Record<string, AlwaysHitlConfig> = {};
    const result = evaluateAlwaysHitl("place-order", "shop.example.com", config, defaultState);

    // The override is true — workflow auto-approval is ignored
    expect(result.override).toBe(true);
    expect(result.actionClass).toBe("place-order");
  });
});

describe("formatMediatorState", () => {
  it("formats cart items, total, ship-to, and payment", () => {
    const state: MediatorState = {
      cartItems: [
        { name: "Widget", quantity: 2, price: "$29.99" },
        { name: "Gadget", quantity: 1, price: "$49.99" },
      ],
      total: "$109.97",
      shipToZipLast4: "98101",
      paymentLast4: "4242",
    };

    const formatted = formatMediatorState(state);
    expect(formatted).toContain("Cart:");
    expect(formatted).toContain("Widget × 2 @ $29.99");
    expect(formatted).toContain("Gadget × 1 @ $49.99");
    expect(formatted).toContain("Total: $109.97");
    expect(formatted).toContain("Ship to: ****98101");
    expect(formatted).toContain("Payment: ****4242");
  });

  it("handles empty cart", () => {
    const state: MediatorState = {
      cartItems: [],
      total: "$0.00",
      shipToZipLast4: "0000",
      paymentLast4: "0000",
    };

    const formatted = formatMediatorState(state);
    expect(formatted).not.toContain("Cart:");
    expect(formatted).toContain("Total: $0.00");
    expect(formatted).toContain("Ship to: ****0000");
    expect(formatted).toContain("Payment: ****0000");
  });
});
