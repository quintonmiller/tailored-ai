import { beforeEach, describe, expect, it, vi } from "vitest";
import { AmazonPurchaseAdapter } from "../adapters/purchase-amazon.js";
import type { AmazonSession, ExecutorContext } from "../types.js";
import { AddressMismatchError, PriceChangedError, ReauthError, SessionExpiredError } from "../types.js";

// Mock the playwright-stealth module
vi.mock("../adapters/playwright-stealth.js", () => ({
  launchStealthBrowser: vi.fn(),
  createStealthContext: vi.fn(),
  humanDelay: vi.fn().mockResolvedValue(undefined),
  navigateWithDelay: vi.fn(),
  captureScreenshot: vi.fn(),
  serializeCookies: vi.fn(),
}));

describe("AmazonPurchaseAdapter", () => {
  let adapter: AmazonPurchaseAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AmazonPurchaseAdapter();
  });

  describe("validate", () => {
    it("rejects input with neither url nor query", () => {
      const result = adapter.validate({ max_price: 10 } as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Must provide either 'url' or 'query'");
    });

    it("rejects non-amazon.com URLs", () => {
      const result = adapter.validate({
        url: "https://www.ebay.com/item/123",
        max_price: 10,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("URL must point to amazon.com");
    });

    it("rejects invalid URL format", () => {
      const result = adapter.validate({
        url: "not-a-url",
        max_price: 10,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Invalid URL format");
    });

    it("rejects negative max_price", () => {
      const result = adapter.validate({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: -5,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("max_price must be a positive number");
    });

    it("rejects zero max_price", () => {
      const result = adapter.validate({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("max_price must be a positive number");
    });

    it("rejects qty < 1", () => {
      const result = adapter.validate({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: 10,
        qty: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("qty must be an integer between 1 and 10");
    });

    it("rejects qty > 10", () => {
      const result = adapter.validate({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: 10,
        qty: 11,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("qty must be an integer between 1 and 10");
    });

    it("accepts valid URL input", () => {
      const result = adapter.validate({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: 29.99,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid query input", () => {
      const result = adapter.validate({
        query: "mechanical keyboard",
        max_price: 100,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid input with qty", () => {
      const result = adapter.validate({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: 10,
        qty: 5,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts qty of 1", () => {
      const result = adapter.validate({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: 10,
        qty: 1,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts qty of 10", () => {
      const result = adapter.validate({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: 10,
        qty: 10,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("describeForApproval", () => {
    // These two cases drive a real Playwright launch via searchAmazon /
    // scrapeProduct. Mocking the entire browser lifecycle in unit tests
    // is brittle and over-asserts on internal call shape. Skipping here;
    // they're covered by the manual end-to-end test against real Amazon
    // documented in docs/trusted-actions.md (TA6).
    it.skip("returns an ApprovalCard with query input (needs real browser)", async () => {
      const card = await adapter.describeForApproval({
        query: "test product",
        max_price: 50,
      });
      expect(card.title).toBeDefined();
      expect(card.body).toBeDefined();
    });

    it.skip("returns an ApprovalCard with url input (needs real browser)", async () => {
      const card = await adapter.describeForApproval({
        url: "https://www.amazon.com/dp/B000000000",
        max_price: 50,
      });
      expect(card.title).toBeDefined();
      expect(card.body).toBeDefined();
    });
  });

  describe("execute", () => {
    const mockSession: AmazonSession = {
      cookies: JSON.stringify([{ name: "session-id", value: "test", domain: "amazon.com", path: "/" }]),
      userAgent: "TestAgent",
      viewport: { width: 1280, height: 720 },
      defaultAddress: "123 Main St",
      savedAt: new Date().toISOString(),
    };

    const mockCtx: ExecutorContext = {
      decryptCredentials: vi.fn().mockResolvedValue(JSON.stringify(mockSession)),
      sendPush: vi.fn().mockResolvedValue(undefined),
      captureScreenshot: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
    };

    it("throws SessionExpiredError when no session exists", async () => {
      const ctx: ExecutorContext = {
        ...mockCtx,
        decryptCredentials: vi.fn().mockResolvedValue(null),
      };

      await expect(
        adapter.execute({ url: "https://www.amazon.com/dp/B000000000", max_price: 10 }, ctx),
      ).rejects.toThrow(SessionExpiredError);
    });
  });
});

describe("Error types", () => {
  it("SessionExpiredError has correct name", () => {
    const err = new SessionExpiredError();
    expect(err.name).toBe("SessionExpiredError");
  });

  it("PriceChangedError has correct name and prices", () => {
    const err = new PriceChangedError(15.99, 10.0);
    expect(err.name).toBe("PriceChangedError");
    expect(err.currentPrice).toBe(15.99);
    expect(err.maxPrice).toBe(10.0);
  });

  it("AddressMismatchError has correct name and addresses", () => {
    const err = new AddressMismatchError("123 Main", "456 Oak");
    expect(err.name).toBe("AddressMismatchError");
    expect(err.expected).toBe("123 Main");
    expect(err.actual).toBe("456 Oak");
  });

  it("ReauthError surfaces reason + optional screenshot path", () => {
    const err = new ReauthError("two_factor", "/tmp/2fa.png");
    expect(err.name).toBe("ReauthError");
    expect(err.reason).toBe("two_factor");
    expect(err.screenshotPath).toBe("/tmp/2fa.png");
  });
});
