import { describe, expect, it } from "vitest";
import { BrowserMediator, classifyButtonText } from "../mediator.js";

describe("classifyButtonText", () => {
  it("classifies place-order variants", () => {
    expect(classifyButtonText("Place your order")).toBe("place-order");
    expect(classifyButtonText("Place order")).toBe("place-order");
    expect(classifyButtonText("Submit order")).toBe("place-order");
    expect(classifyButtonText("Confirm purchase")).toBe("place-order");
  });
  it("classifies payment variants", () => {
    expect(classifyButtonText("Pay now")).toBe("payment-form-fill");
    expect(classifyButtonText("Pay $42.00")).toBe("payment-form-fill");
    expect(classifyButtonText("Submit payment")).toBe("payment-form-fill");
    expect(classifyButtonText("Use this payment method")).toBe("payment-form-fill");
  });
  it("classifies checkout entry", () => {
    expect(classifyButtonText("Proceed to checkout")).toBe("navigate-to-checkout-confirm");
  });
  it("classifies bare submit", () => {
    expect(classifyButtonText("Submit")).toBe("submit");
  });
  it("returns null for benign text", () => {
    expect(classifyButtonText("Add to cart")).toBeNull();
    expect(classifyButtonText("Sign in")).toBeNull();
    expect(classifyButtonText("Search")).toBeNull();
    expect(classifyButtonText("Continue shopping")).toBeNull();
  });
  it("ignores leading/trailing whitespace", () => {
    expect(classifyButtonText("   Place your order  ")).toBe("place-order");
  });
});

describe("BrowserMediator egress allow-list", () => {
  it("blocks everything when the allow-list is empty", () => {
    const m = new BrowserMediator({ egressAllowList: [] });
    expect(m.hostAllowed("amazon.com")).toBe(false);
    expect(m.hostAllowed("anywhere.example")).toBe(false);
  });
  it("allows exact-host matches", () => {
    const m = new BrowserMediator({ egressAllowList: ["amazon.com"] });
    expect(m.hostAllowed("amazon.com")).toBe(true);
    expect(m.hostAllowed("AMAZON.COM")).toBe(true);
  });
  it("allows subdomains of allow-listed hosts", () => {
    const m = new BrowserMediator({ egressAllowList: ["amazon.com"] });
    expect(m.hostAllowed("www.amazon.com")).toBe(true);
    expect(m.hostAllowed("smile.amazon.com")).toBe(true);
  });
  it("does not allow superdomain or unrelated host", () => {
    const m = new BrowserMediator({ egressAllowList: ["amazon.com"] });
    expect(m.hostAllowed("amazon.com.attacker.test")).toBe(false);
    expect(m.hostAllowed("attacker.test")).toBe(false);
    expect(m.hostAllowed("notamazon.com")).toBe(false);
  });
});

describe("BrowserMediator session id", () => {
  it("mints a fresh id per instance", () => {
    const a = new BrowserMediator();
    const b = new BrowserMediator();
    expect(a.sessionId).not.toEqual(b.sessionId);
    expect(a.sessionId).toMatch(/^bm-[0-9a-f]{12}$/);
  });
});
