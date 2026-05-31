#!/usr/bin/env node
import { register } from "../actions/registry.js";
import { AmazonPurchaseAdapter } from "../adapters/purchase-amazon.js";
import { verifyAuditChain } from "../audit/log.js";
import { getDb } from "../db/schema.js";
import { CartStateAdapter, OrderHistoryAdapter, ProductSummaryAdapter } from "../read-actions/index.js";
import { startServer } from "../server.js";
import { setupAmazon } from "./setup-amazon.js";
import { setupAmazonPassword } from "./setup-amazon-password.js";
import { setupVapid } from "./setup-vapid.js";
import { testPurchase } from "./test-purchase.js";

/**
 * tai-executor CLI entry point.
 *
 * Subcommands:
 *   tai-executor serve              start the executor (HTTP + runner)
 *   tai-executor setup amazon       headed-Chromium one-time Amazon login
 *   tai-executor audit verify       walk the audit chain, report integrity
 *   tai-executor help               show this message
 */

const HELP = `
tai-executor — trusted-actions executor

Usage:
  tai-executor serve                Start the executor on TA_PORT (default 3100).
  tai-executor setup amazon         One-time Amazon login (opens headed Chromium).
  tai-executor setup amazon-password
                                    Store Amazon password (encrypted, stdin no-echo) for
                                    automatic /ap/signin reauth during checkout. Pass
                                    --force to rotate an existing entry.
  tai-executor setup vapid          Generate Web Push VAPID keypair (encrypted in age-store).
                                    Required for PWA push notifications. Pass --force to
                                    rotate (invalidates all existing subscribers).
  tai-executor probe amazon <url>   Dry-run: scrape title/price for an Amazon
                                    URL using the saved session. NO cart edit,
                                    NO checkout, NO purchase.
  tai-executor test-purchase <url>  Dry-run end-to-end: empty-cart guard,
                                    add to cart, go to checkout review,
                                    price-tolerance guard. STOPS before
                                    clicking Place Order. Browser stays
                                    open for manual inspection.
  tai-executor audit verify         Walk the audit chain and report integrity.
  tai-executor help                 Show this help.

Environment:
  TA_PORT                           HTTP port (default 3100)
  TA_SHARED_SECRET                  Bearer for TAI → executor enqueue (required for serve)
  APPROVAL_HMAC_KEY                 HMAC key for approval tokens (required for serve)
  TA_PUBLIC_BASE_URL                Public base URL used in approval links (e.g. https://tai.example.com)
  TA_DB_PATH                        SQLite file (default ./executor.db, :memory: for tests)
  TAI_EXECUTOR_PASSPHRASE           Passphrase to decrypt ~/.tai-executor/secrets/* (required for serve + setup)
  TA_CAP_PER_REQUEST                Max $ per purchase ("unlimited" or a number)
  TA_CAP_PER_DAY                    Max $ per 24h
  TA_CAP_PER_MONTH                  Max $ per 30d
`.trim();

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return;
  }

  if (cmd === "serve") {
    requireEnv("TA_SHARED_SECRET");
    requireEnv("APPROVAL_HMAC_KEY");
    register("purchase.amazon", new AmazonPurchaseAdapter() as never);
    register("amazon_read.product_summary", new ProductSummaryAdapter());
    register("amazon_read.order_history", new OrderHistoryAdapter());
    register("amazon_read.cart_state", new CartStateAdapter());
    startServer();
    // Keep the process alive
    process.stdin.resume();
    return;
  }

  if (cmd === "setup" && argv[1] === "amazon") {
    await setupAmazon();
    return;
  }

  if (cmd === "setup" && argv[1] === "amazon-password") {
    await setupAmazonPassword({ force: argv.includes("--force") });
    return;
  }

  if (cmd === "setup" && argv[1] === "vapid") {
    await setupVapid({ force: argv.includes("--force") });
    return;
  }

  if (cmd === "probe" && argv[1] === "amazon") {
    const target = argv[2];
    if (!target) {
      console.error("Usage: tai-executor probe amazon <url-or-query>");
      process.exit(1);
    }
    const adapter = new AmazonPurchaseAdapter();
    // Treat anything starting with http as a URL; otherwise a search query.
    const input = target.startsWith("http") ? { url: target, max_price: 99999 } : { query: target, max_price: 99999 };
    console.log("▸ probing Amazon (read-only — no cart, no purchase) …");
    try {
      const card = await adapter.describeForApproval(input);
      console.log("");
      console.log("✅ Saved session works. Scrape result:");
      console.log(`   Title:        ${card.title}`);
      console.log(`   Body:         ${card.body}`);
      console.log(`   Est. cost:    ${card.estimatedCost ?? "(none)"}`);
      console.log(`   Image URL:    ${card.imageUrl || "(none)"}`);
      if (card.metadata) {
        for (const [k, v] of Object.entries(card.metadata)) {
          console.log(`   ${k}: ${v}`);
        }
      }
      console.log("");
      console.log("No cart modification, no order placed. Probe complete.");
      process.exit(0);
    } catch (err) {
      console.error("");
      console.error("✗ probe failed:", err instanceof Error ? err.message : err);
      console.error("");
      console.error("Common causes:");
      console.error("  - Saved session expired → re-run setup amazon");
      console.error("  - Amazon UI selectors changed (open a GitHub issue)");
      console.error("  - URL is not on amazon.com");
      process.exit(1);
    }
  }

  if (cmd === "test-purchase") {
    const url = argv[1];
    if (!url) {
      console.error("Usage: tai-executor test-purchase <amazon-url> [--tolerance N] [--headless]");
      process.exit(1);
    }
    let tolerance = 15;
    const tIdx = argv.indexOf("--tolerance");
    if (tIdx > -1 && argv[tIdx + 1]) {
      const parsed = Number.parseFloat(argv[tIdx + 1]);
      if (Number.isFinite(parsed) && parsed > 0) tolerance = parsed;
    }
    const headless = argv.includes("--headless");
    const clearCart = argv.includes("--clear-cart");
    const placeOrder = argv.includes("--place-order");
    const result = await testPurchase({ url, priceTolerancePct: tolerance, headless, clearCart, placeOrder });
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "audit" && argv[1] === "verify") {
    const db = getDb(process.env.TA_DB_PATH);
    const result = verifyAuditChain(db);
    if (result.ok) {
      console.log("✅ Audit chain OK");
      process.exit(0);
    }
    console.error(`❌ Audit chain broken at entry id=${result.brokenAt}`);
    process.exit(1);
  }

  console.error(`Unknown command: ${argv.join(" ")}`);
  console.error(HELP);
  process.exit(1);
}

function requireEnv(name: string): void {
  if (!process.env[name]) {
    console.error(`Required env var ${name} is not set.`);
    console.error(HELP);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`tai-executor failed:`, err);
  process.exit(1);
});
