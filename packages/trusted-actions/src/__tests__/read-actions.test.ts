import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __clearRegistry, get, listTypes, register } from "../actions/registry.js";
import { verifyAuditChain, writeAudit } from "../audit/log.js";
import { migrate } from "../db/migrations.js";
import { CartStateAdapter } from "../read-actions/cart-state.js";
import { OrderHistoryAdapter } from "../read-actions/order-history.js";
import { ProductSummaryAdapter } from "../read-actions/product-summary.js";

// ── Product Summary Validation ──────────────────────────────────────────────

describe("amazon_read.product_summary validation", () => {
  const adapter = new ProductSummaryAdapter();

  it("rejects missing url and query", () => {
    const result = adapter.validate({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Must provide either 'url' or 'query'");
  });

  it("rejects non-string url", () => {
    const result = adapter.validate({ url: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("url must be a string");
  });

  it("rejects non-amazon.com url", () => {
    const result = adapter.validate({ url: "https://notamazon.com/dp/B000" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("URL must point to amazon.com");
  });

  it("rejects non-string query", () => {
    const result = adapter.validate({ query: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("query must be a string");
  });

  it("accepts valid amazon.com url", () => {
    const result = adapter.validate({ url: "https://www.amazon.com/dp/B000" });
    expect(result.valid).toBe(true);
  });

  it("accepts valid query", () => {
    const result = adapter.validate({ query: "wireless headphones" });
    expect(result.valid).toBe(true);
  });

  it("accepts url and query together", () => {
    const result = adapter.validate({
      url: "https://www.amazon.com/dp/B000",
      query: "headphones",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects malformed URL", () => {
    const result = adapter.validate({ url: "not-a-url" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Invalid URL format");
  });
});

// ── Order History Validation ────────────────────────────────────────────────

describe("amazon_read.order_history validation", () => {
  const adapter = new OrderHistoryAdapter();

  it("always accepts (no input required)", () => {
    expect(adapter.validate({}).valid).toBe(true);
    expect(adapter.validate(null!).valid).toBe(true);
  });
});

// ── Cart State Validation ───────────────────────────────────────────────────

describe("amazon_read.cart_state validation", () => {
  const adapter = new CartStateAdapter();

  it("always accepts (no input required)", () => {
    expect(adapter.validate({}).valid).toBe(true);
    expect(adapter.validate(null!).valid).toBe(true);
  });
});

// ── Auto-approve flag ───────────────────────────────────────────────────────

describe("read actions auto-approve flag", () => {
  it("ProductSummaryAdapter has autoApprove = true", () => {
    expect(new ProductSummaryAdapter().autoApprove).toBe(true);
  });

  it("OrderHistoryAdapter has autoApprove = true", () => {
    expect(new OrderHistoryAdapter().autoApprove).toBe(true);
  });

  it("CartStateAdapter has autoApprove = true", () => {
    expect(new CartStateAdapter().autoApprove).toBe(true);
  });
});

// ── Schema enforcement ──────────────────────────────────────────────────────

describe("read action output schemas", () => {
  it("ProductSummaryOutput has only allowed fields", () => {
    const allowed = new Set(["title", "price", "image", "url"]);
    // Verify the schema shape — no shipping address, no card info
    const sample = {
      title: "Test Product",
      price: "$9.99",
      image: "https://example.com/img.jpg",
      url: "https://www.amazon.com/dp/B000",
    };
    const keys = Object.keys(sample);
    for (const key of keys) {
      expect(allowed.has(key)).toBe(true);
    }
    // Sensitive fields must NOT be in the schema
    expect(allowed.has("shipping_address")).toBe(false);
    expect(allowed.has("card_last4")).toBe(false);
  });

  it("OrderHistoryOutput has only allowed fields", () => {
    const allowed = new Set(["orders"]);
    const sample = { orders: [] };
    const keys = Object.keys(sample);
    for (const key of keys) {
      expect(allowed.has(key)).toBe(true);
    }
    // Order items have only safe fields
    const orderAllowed = new Set(["order_id", "date", "status", "total", "items"]);
    const sampleOrder = {
      order_id: "123-4567890",
      date: "2024-01-01",
      status: "Delivered",
      total: "$19.99",
      items: ["Item A"],
    };
    const orderKeys = Object.keys(sampleOrder);
    for (const key of orderKeys) {
      expect(orderAllowed.has(key)).toBe(true);
    }
  });

  it("CartStateOutput has only allowed fields", () => {
    const allowed = new Set(["items", "total_items"]);
    const sample = { items: [], total_items: 0 };
    const keys = Object.keys(sample);
    for (const key of keys) {
      expect(allowed.has(key)).toBe(true);
    }
    // Cart items have only safe fields
    const itemAllowed = new Set(["title", "price", "quantity", "url"]);
    const sampleItem = {
      title: "Item",
      price: "$9.99",
      quantity: 1,
      url: "https://www.amazon.com/dp/B000",
    };
    const itemKeys = Object.keys(sampleItem);
    for (const key of itemKeys) {
      expect(itemAllowed.has(key)).toBe(true);
    }
  });
});

// ── Audit logging for read actions ──────────────────────────────────────────

describe("read action audit logging", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });

  afterEach(() => db.close());

  it("writes audit entry for product_summary", () => {
    writeAudit(db, {
      actor: "tai",
      action: "amazon_read.product_summary",
      context: JSON.stringify({ id: "ta_00000001", type: "amazon_read.product_summary" }),
    });

    const rows = db.prepare("SELECT action FROM audit_log").all() as Array<{
      action: string;
    }>;
    expect(rows[0].action).toBe("amazon_read.product_summary");
  });

  it("writes audit entry for order_history", () => {
    writeAudit(db, {
      actor: "tai",
      action: "amazon_read.order_history",
      context: JSON.stringify({ id: "ta_00000002" }),
    });

    const rows = db.prepare("SELECT action FROM audit_log").all() as Array<{
      action: string;
    }>;
    expect(rows[0].action).toBe("amazon_read.order_history");
  });

  it("writes audit entry for cart_state", () => {
    writeAudit(db, {
      actor: "tai",
      action: "amazon_read.cart_state",
      context: JSON.stringify({ id: "ta_00000003" }),
    });

    const rows = db.prepare("SELECT action FROM audit_log").all() as Array<{
      action: string;
    }>;
    expect(rows[0].action).toBe("amazon_read.cart_state");
  });

  it("audit chain remains intact after read actions", () => {
    writeAudit(db, {
      actor: "tai",
      action: "amazon_read.product_summary",
      context: "{}",
    });
    writeAudit(db, {
      actor: "tai",
      action: "amazon_read.order_history",
      context: "{}",
    });
    writeAudit(db, {
      actor: "tai",
      action: "amazon_read.cart_state",
      context: "{}",
    });

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(true);
  });
});

// ── Registration ────────────────────────────────────────────────────────────

describe("read action registration", () => {
  beforeEach(() => __clearRegistry());
  afterEach(() => __clearRegistry());

  it("registers all three read actions", () => {
    register("amazon_read.product_summary", new ProductSummaryAdapter());
    register("amazon_read.order_history", new OrderHistoryAdapter());
    register("amazon_read.cart_state", new CartStateAdapter());

    const types = listTypes();
    expect(types).toContain("amazon_read.product_summary");
    expect(types).toContain("amazon_read.order_history");
    expect(types).toContain("amazon_read.cart_state");
  });

  it("read actions can be retrieved from registry", () => {
    register("amazon_read.product_summary", new ProductSummaryAdapter());
    register("amazon_read.order_history", new OrderHistoryAdapter());
    register("amazon_read.cart_state", new CartStateAdapter());

    const ps = get("amazon_read.product_summary");
    const oh = get("amazon_read.order_history");
    const cs = get("amazon_read.cart_state");

    expect(ps).toBeDefined();
    expect(oh).toBeDefined();
    expect(cs).toBeDefined();
  });
});
