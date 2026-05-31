import type { Page } from "playwright";
import { clearCart as sharedClearCart } from "../adapters/amazon-flow.js";
import {
  captureScreenshot,
  createStealthContext,
  humanDelay,
  launchStealthBrowser,
  navigateWithDelay,
} from "../adapters/playwright-stealth.js";
import { AgeStore } from "../secrets/age-store.js";
import type { AmazonSession } from "../types.js";

/**
 * Dry-run end-to-end purchase. Walks every step the real adapter does
 * EXCEPT clicking "Place order". Designed so the user can inspect the
 * browser state at the final review page before committing real money.
 *
 * Safety guards exercised:
 *  1. Cart must be empty before we start (fail loud if not).
 *  2. Final checkout total must be within `priceTolerancePct` of the
 *     price scraped from the product page (defaults to 15%). Catches
 *     surprise fees / quantity bugs / wrong-product cases.
 *
 * After all checks pass, the browser stays open until the user kills
 * the process (Ctrl+C). The container's PID 1 catches that and tears
 * down cleanly via Playwright's signal handlers.
 */
export interface TestPurchaseOptions {
  url: string;
  /** Acceptable deviation between product-page price and checkout total. Default 15%. */
  priceTolerancePct?: number;
  /** Override sessions dir for testing. */
  secretsDir?: string;
  passphrase?: string;
  /** Run Chromium headless and exit on completion (for autonomous CI testing). */
  headless?: boolean;
  /** Empty the cart before running (for iteration/testing only). */
  clearCart?: boolean;
  /**
   * If set, click the actual "Place your order" button at the end —
   * THIS PLACES A REAL ORDER and charges your card. Always prints a
   * 5-second countdown with the order total before clicking so you
   * can Ctrl-C to abort.
   */
  placeOrder?: boolean;
}

export interface TestPurchaseResult {
  ok: boolean;
  reason?: string;
  productPagePrice?: number;
  checkoutTotal?: number;
  defaultAddress?: string;
  checkoutAddress?: string;
}

export async function testPurchase(opts: TestPurchaseOptions): Promise<TestPurchaseResult> {
  const tolerance = opts.priceTolerancePct ?? 15;
  const headless = opts.headless ?? false;
  const stayOpen = !headless;

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("DRY-RUN PURCHASE — will NOT click Place Order");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`Target:     ${opts.url}`);
  console.log(`Price tol:  ±${tolerance}%`);
  console.log(
    `Mode:       ${headless ? "HEADLESS (autonomous, exits on completion)" : "HEADED (browser stays open for inspection)"}`,
  );
  console.log("");

  // ── Load session ────────────────────────────────────────────────
  const store = new AgeStore({ secretsDir: opts.secretsDir, passphrase: opts.passphrase });
  const sessionJson = await store.load("amazon_session");
  if (!sessionJson) {
    return { ok: false, reason: "No saved Amazon session — run `setup amazon` first." };
  }
  const session: AmazonSession = JSON.parse(sessionJson);
  console.log(`✓ session loaded (saved ${session.savedAt})`);

  // ── Launch HEADED browser so the user can see + inspect ─────────
  const browser = await launchStealthBrowser({
    userAgent: session.userAgent,
    viewport: session.viewport,
    headed: !headless,
  });
  const context = await createStealthContext(
    browser,
    { userAgent: session.userAgent, viewport: session.viewport },
    session.cookies,
  );
  const page = await context.newPage();

  // Cleanup hook — if anything throws below, close gracefully
  let cleanup = async () => {
    try {
      await page.close();
      await context.close();
      await browser.close();
    } catch {
      /* ignore */
    }
  };

  try {
    // ── Optional pre-clear (iteration aid for dev; production
    //    adapter does this unconditionally via amazon-flow.clearCart) ──
    if (opts.clearCart) {
      console.log("▸ pre-clearing cart (--clear-cart)");
      const { initial, remaining } = await sharedClearCart(page);
      console.log(`  cart count: before=${initial}, after=${remaining}`);
    }

    // ── GUARD 1: cart must be empty ──────────────────────────────
    console.log("");
    console.log("▸ GUARD 1: checking cart is empty");
    await navigateWithDelay(page, "https://www.amazon.com/gp/cart/view.html");

    const cartState = await getCartState(page);
    console.log(`  cart item count: ${cartState.itemCount}`);
    if (cartState.itemCount > 0) {
      await captureScreenshot(page, screenshotPath("dryrun_cart_not_empty"));
      console.log("");
      console.log("✗ ABORT: cart is not empty.");
      console.log(`  Found ${cartState.itemCount} item(s). Sample: ${cartState.firstItemTitle || "(unknown)"}`);
      console.log("");
      console.log("  This guard exists so we don't accidentally check out");
      console.log("  another item alongside the one we're testing. Clear");
      console.log("  the cart manually then re-run.");
      console.log("");
      if (stayOpen) {
        console.log("Browser will stay open for inspection. Ctrl+C to close.");
        await waitForever();
        cleanup = async () => {};
      }
      return { ok: false, reason: "cart_not_empty" };
    }
    console.log("  ✓ cart is empty");

    // ── Scrape product page (establishes expected price) ─────────
    console.log("");
    console.log("▸ navigating to product page");
    await navigateWithDelay(page, opts.url);
    const productPrice = await extractProductPrice(page);
    if (productPrice === null) {
      await captureScreenshot(page, screenshotPath("dryrun_price_scrape_failed"));
      console.log("✗ ABORT: could not scrape product price.");
      if (stayOpen) {
        console.log("Browser will stay open for inspection. Ctrl+C to close.");
        await waitForever();
        cleanup = async () => {};
      }
      return { ok: false, reason: "price_scrape_failed" };
    }
    console.log(`  ✓ product page price: $${productPrice.toFixed(2)}`);

    // ── Add to cart ──────────────────────────────────────────────
    console.log("");
    console.log("▸ clicking Add to Cart");
    await addToCart(page);
    // Some products (e.g. electronics) pop an Asurion protection
    // plan modal BEFORE the item is actually added. The modal blocks
    // the add until "No thanks" is chosen. Try to dismiss any visible
    // upsell in a short loop, polling the cart count between attempts.
    const added = await waitForCartCountWithDismiss(page, 1, 20_000);
    if (!added) {
      await captureScreenshot(page, screenshotPath("dryrun_add_to_cart_failed"));
      await dumpPageDiagnostic(page, "add_to_cart_failed");
      console.log("✗ ABORT: add-to-cart click did not increment the cart count within 20s.");
      console.log("  Likely causes: out of stock, size/color must be selected,");
      console.log("  age-gated item, or an unrecognized upsell modal blocked the add.");
      console.log("");
      if (stayOpen) {
        console.log("Browser will stay open for inspection. Ctrl+C to close.");
        await waitForever();
        cleanup = async () => {};
      }
      return { ok: false, reason: "add_to_cart_did_not_register", productPagePrice: productPrice };
    }
    console.log("  ✓ added (cart count incremented)");

    // ── Proceed to checkout ──────────────────────────────────────
    console.log("");
    console.log("▸ proceeding to checkout");
    await proceedToCheckout(page);
    console.log("  ✓ on checkout page");

    // Give Amazon's checkout page a moment to render the totals.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await humanDelay();

    // After clicking Proceed, Amazon may show one or more upsells
    // (Fresh groceries, Prime trial, etc.) before the actual order
    // review page. Keep dismissing until we land on /gp/buy/spc/.
    await dismissUntilCheckoutLoaded(page);

    // ── GUARD 2: checkout total within tolerance ─────────────────
    console.log("");
    console.log(`▸ GUARD 2: checking checkout total is within ±${tolerance}% of $${productPrice.toFixed(2)}`);
    const checkoutTotal = await extractCheckoutTotal(page);
    if (checkoutTotal === null) {
      await captureScreenshot(page, screenshotPath("dryrun_checkout_total_not_found"));
      console.log("");
      console.log("✗ ABORT: could not find order total on checkout page.");
      if (stayOpen) {
        console.log("Browser will stay open for inspection. Ctrl+C to close.");
        await waitForever();
        cleanup = async () => {};
      }
      return { ok: false, reason: "checkout_total_not_found", productPagePrice: productPrice };
    }

    const diffPct = (Math.abs(checkoutTotal - productPrice) / productPrice) * 100;
    const direction = checkoutTotal >= productPrice ? "above" : "below";
    console.log(`  checkout total: $${checkoutTotal.toFixed(2)} (${diffPct.toFixed(1)}% ${direction} product price)`);

    if (diffPct > tolerance) {
      await captureScreenshot(page, screenshotPath("dryrun_price_out_of_tolerance"));
      console.log("");
      console.log(`✗ ABORT: total deviates ${diffPct.toFixed(1)}% from product price (>${tolerance}% allowed).`);
      console.log("  Could be: surprise fees, wrong quantity, wrong currency,");
      console.log("  membership-only pricing, or the product changed.");
      console.log("");
      if (stayOpen) {
        console.log("Browser will stay open for inspection. Ctrl+C to close.");
        await waitForever();
        cleanup = async () => {};
      }
      return {
        ok: false,
        reason: "price_out_of_tolerance",
        productPagePrice: productPrice,
        checkoutTotal,
      };
    }
    console.log(`  ✓ within tolerance (${diffPct.toFixed(1)}% ≤ ${tolerance}%)`);

    // ── Shipping address inspection ──────────────────────────────
    console.log("");
    console.log("▸ inspecting shipping address");
    const checkoutAddress = await getShippingAddress(page);
    console.log(`  on checkout page: ${checkoutAddress || "(not visible)"}`);
    if (session.defaultAddress) {
      console.log(`  cached default:   ${session.defaultAddress}`);
      const matches = checkoutAddress.includes(session.defaultAddress.slice(0, 20));
      console.log(`  ${matches ? "✓" : "✗"} address ${matches ? "matches" : "does NOT match"} the cached default`);
    } else {
      console.log("  (no cached default address — address-swap guard inactive)");
    }

    // ── STOP — keep browser open (headed) or exit (headless) ────
    await captureScreenshot(page, screenshotPath("dryrun_review_page")).catch(() => {});
    console.log("");

    if (opts.placeOrder) {
      console.log("══════════════════════════════════════════════════════════════");
      console.log("⚠  PLACE-ORDER MODE — about to click 'Place your order'");
      console.log("══════════════════════════════════════════════════════════════");
      console.log("");
      console.log(`  Product page price:  $${productPrice.toFixed(2)}`);
      console.log(`  Checkout total:      $${checkoutTotal.toFixed(2)}`);
      console.log(`  Shipping to:         ${checkoutAddress || "(not visible)"}`);
      console.log("");
      console.log("  THIS WILL CHARGE YOUR CARD. Ctrl-C in the next 5 seconds to abort.");
      for (let i = 5; i > 0; i--) {
        process.stdout.write(`\r  Clicking in ${i}s… `);
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.log("\n");
      try {
        const { clickPlaceOrder } = await import("../adapters/amazon-flow.js");
        await clickPlaceOrder(page, {
          screenshotPath: screenshotPath("manual_place_order_failed"),
        });
        await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
        await captureScreenshot(page, screenshotPath("after_place_order")).catch(() => {});
        console.log("");
        console.log("══════════════════════════════════════════════════════════════");
        console.log("✅ Place Order clicked — order should be confirmed.");
        console.log("══════════════════════════════════════════════════════════════");
        console.log("");
        console.log(`  Final URL: ${page.url()}`);
        console.log("");
        console.log("Verify the order at https://www.amazon.com/gp/your-account/order-history");
        console.log("");
      } catch (err) {
        await captureScreenshot(page, screenshotPath("place_order_threw")).catch(() => {});
        console.log("");
        console.log("✗ PLACE ORDER FAILED:");
        console.log(`  ${err instanceof Error ? err.message : err}`);
        console.log("");
      }
      if (stayOpen) {
        console.log("Browser will stay open so you can inspect. Ctrl+C to close.");
        cleanup = async () => {};
        await waitForever();
      }
    } else {
      console.log("══════════════════════════════════════════════════════════════");
      console.log("✅ DRY RUN COMPLETE.");
      console.log("══════════════════════════════════════════════════════════════");
      console.log("");
      console.log("Nothing has been purchased. The cart has the item; the order");
      console.log("review page is loaded but Place Order was NOT clicked.");
      console.log("");
      if (stayOpen) {
        console.log("Browser is open at the final review page. Inspect it, then");
        console.log("press Ctrl+C to close. (The item stays in your cart — clear");
        console.log("it manually if you don't want it sitting there.)");
        console.log("");
        cleanup = async () => {};
        await waitForever();
      } else {
        console.log("Headless run — exiting. Final review screenshot saved.");
        console.log("Note: the test item IS in your cart. Clear it manually.");
        console.log("");
      }
    }
    return {
      ok: true,
      productPagePrice: productPrice,
      checkoutTotal,
      defaultAddress: session.defaultAddress,
      checkoutAddress,
    };
  } catch (err) {
    await captureScreenshot(page, screenshotPath(`dryrun_unexpected_${Date.now()}`)).catch(() => {});
    console.log("");
    console.log("✗ unexpected error:", err instanceof Error ? err.message : err);
    if (stayOpen) {
      console.log("Browser will stay open for inspection. Ctrl+C to close.");
      cleanup = async () => {};
      await waitForever();
    }
    return { ok: false, reason: (err as Error).message };
  } finally {
    await cleanup();
  }
}

// ── helpers (mirrors adapter helpers; kept local so this file is self-contained) ─

function screenshotPath(label: string): string {
  return `/home/executor/screenshots/${label}_${Date.now()}.png`;
}

async function waitForever(): Promise<void> {
  // Stay alive until SIGINT (Ctrl+C). Resolving once per minute also
  // suppresses Node from thinking the event loop is idle.
  return new Promise<void>((resolveOuter) => {
    const onSig = () => resolveOuter();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    const iv = setInterval(() => {
      /* keep alive */
    }, 60_000);
    process.on("exit", () => clearInterval(iv));
  });
}

/**
 * Click "No thanks" / "Continue without adding" links on common post-
 * add-to-cart upsell pages. Idempotent and best-effort — if nothing
 * matches, returns silently.
 */
async function dismissInterstitial(page: Page): Promise<void> {
  const url = page.url();
  const onUpsell =
    /\/gp\/(huc|cart\/spc|product-ads|prime-signup)|\/buyflow\//i.test(url) ||
    /protect|warranty|subscri|prime\s*trial|insurance/i.test((await page.title().catch(() => "")) || "");
  if (!onUpsell) {
    // Even on /gp/cart/view.html, occasionally an inline upsell card
    // appears within the cart layout. Try the dismiss buttons anyway.
  }

  const dismissCandidates = [
    // Asurion protection-plan modal ("Add to your order" → "No thanks")
    'button:has-text("No thanks")',
    'a:has-text("No thanks")',
    'input[value="No thanks"]',
    'input[aria-label="No thanks"]',
    // Variants with different casing/punctuation
    'button:has-text("No, thanks")',
    'a:has-text("No, thanks")',
    'input[value*="No thanks" i]',
    // "Continue without adding" / "Skip"
    'a:has-text("Continue without adding")',
    'a:has-text("Skip")',
    'button:has-text("Skip")',
    // "Continue to checkout" / "Continue to your cart"
    'a:has-text("Continue to checkout")',
    'a:has-text("Continue to your cart")',
    'button:has-text("Continue to checkout")',
    // Subscribe & Save: "One-time purchase"
    'input[value*="One-time purchase" i]',
    'a:has-text("One-time purchase")',
    // Specific known IDs
    "#siNoCoverage",
    "#attach-warranty-pane button",
    "#attach-popover-close",
    "#attachSiNoCoverage",
    'a[href*="ignoreOfferGroup"]',
    // Modal close X (last resort — may cancel the action)
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
  ];

  for (const sel of dismissCandidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        const label = (await loc.textContent().catch(() => sel)) || sel;
        console.log(`  ↳ dismissing interstitial via: ${label.trim().slice(0, 60)}`);
        await loc.click({ timeout: 5_000 }).catch(() => {});
        await humanDelay();
        // After one dismissal, give the page a moment and try again
        // (some flows chain two upsells in a row).
        await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
        break;
      }
    } catch {
      /* ignore */
    }
  }
}

async function _waitForCartCount(page: Page, atLeast: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await readCartCount(page);
    if (n >= atLeast) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function readCartCount(page: Page): Promise<number> {
  return await page
    .evaluate(() => {
      const t =
        document.querySelector("#nav-cart-count")?.textContent ??
        document.querySelector("[data-name='cart-count']")?.textContent ??
        "0";
      return Number.parseInt((t || "").trim(), 10) || 0;
    })
    .catch(() => 0);
}

/**
 * Poll the nav cart count, but on each iteration also try to dismiss
 * any warranty/protection/upsell modal that may be blocking the add.
 * Many electronics products on Amazon open the Asurion modal AFTER
 * the Add-to-Cart click — until the user chooses "No thanks", the
 * item is not actually added.
 */
async function waitForCartCountWithDismiss(page: Page, atLeast: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await readCartCount(page);
    if (n >= atLeast) return true;
    // Try to dismiss any visible upsell. Idempotent: if nothing matches
    // it returns silently.
    await dismissInterstitial(page);
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

async function dumpPageDiagnostic(page: Page, label: string): Promise<void> {
  try {
    const ctx = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      h1: document.querySelector("h1")?.textContent?.trim() ?? "",
      // Look for modal/dialog containers
      modals: Array.from(document.querySelectorAll('[role="dialog"], .a-popover, [data-action="a-popover-close"]'))
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 5)
        .map((el) => ({
          tag: (el as HTMLElement).tagName,
          id: (el as HTMLElement).id,
          cls: ((el as HTMLElement).className || "").toString().slice(0, 80),
          text: ((el as HTMLElement).innerText || "").slice(0, 200).trim(),
        })),
      visibleButtons: Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a"))
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 40)
        .map((el) => {
          const e = el as HTMLElement;
          return {
            tag: e.tagName,
            name: e.getAttribute("name") ?? "",
            id: e.id,
            cls: (e.className || "").toString().slice(0, 80),
            text: (e.innerText || e.getAttribute("value") || "").slice(0, 80).trim(),
          };
        }),
    }));
    console.log("");
    console.log(`  ── diagnostic [${label}]: page state ──`);
    console.log(`  URL:   ${ctx.url}`);
    console.log(`  Title: ${ctx.title}`);
    console.log(`  H1:    ${ctx.h1}`);
    if (ctx.modals.length) {
      console.log("  Visible modals:");
      for (const m of ctx.modals) {
        console.log(`    [${m.tag} id=${m.id} cls=${m.cls}] ${m.text.slice(0, 120)}`);
      }
    }
    console.log("  Visible clickables (first 40):");
    for (const b of ctx.visibleButtons) {
      const lbl = b.text || b.name || b.id || b.cls;
      if (!lbl) continue;
      console.log(`    [${b.tag}] ${lbl}${b.name ? ` (name=${b.name})` : ""}${b.id ? ` (id=${b.id})` : ""}`);
    }
    console.log("");
  } catch {
    /* ignore */
  }
}

async function getCartState(page: Page): Promise<{ itemCount: number; firstItemTitle?: string }> {
  return await page.evaluate(() => {
    const countText =
      document.querySelector("#nav-cart-count")?.textContent ??
      document.querySelector("[data-name='cart-count']")?.textContent ??
      "0";
    const itemCount = Number.parseInt((countText || "").trim(), 10) || 0;
    const firstItemTitle =
      (document.querySelector(".sc-product-title") as HTMLElement | null)?.innerText?.trim() ?? undefined;
    return { itemCount, firstItemTitle };
  });
}

async function extractProductPrice(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const tryParse = (s: string | null | undefined): number | null => {
      if (!s) return null;
      const m = s.replace(/[,\s]/g, "").match(/\$?([\d.]+)/);
      const n = m ? Number.parseFloat(m[1]) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const selectors = [
      ".a-price.priceToPay .a-offscreen",
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#priceblock_saleprice",
      "[data-a-color='price'] .a-offscreen",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const parsed = tryParse(el?.textContent ?? el?.getAttribute("content"));
      if (parsed !== null) return parsed;
    }
    return null;
  });
}

async function addToCart(page: Page): Promise<void> {
  const selectors = [
    "#add-to-cart-button",
    "input#add-to-cart-button",
    'button[data-add-to-cart="true"]',
    'button[aria-label="Add to Cart"]',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel);
    if ((await btn.count()) > 0) {
      await btn.first().click();
      await humanDelay();
      return;
    }
  }
  throw new Error("Could not find Add to Cart button");
}

async function proceedToCheckout(page: Page): Promise<void> {
  // After Add to Cart, Amazon often shows an interstitial:
  //  - warranty / protection plan pitch
  //  - Prime trial offer
  //  - Subscribe & Save
  //  - "Frequently bought together" bundle
  //  - "Buy with prime" coverage
  // Try to dismiss whichever one's showing FIRST, then navigate to
  // the cart page for the canonical checkout button.
  await humanDelay();
  await dismissInterstitial(page);

  await page.goto("https://www.amazon.com/gp/cart/view.html", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  // Sometimes Amazon redirects /cart/view.html back to the upsell.
  // Run dismissal again post-nav.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await dismissInterstitial(page);
  await humanDelay();

  // /gp/cart/view.html sometimes lands directly on a "MAPLE_Repeat"
  // gift-card upsell page (/dp/B004LLIKVU?ref_=MAPLE_Repeat&RU=/cart).
  // The dismiss affordance is a "Go to Cart" link in the right
  // sidebar — click that to break the redirect cycle.
  await dismissMapleUpsell(page);

  const candidates = [
    // Form-based: still the most reliable selector when present
    'input[name="proceedToRetailCheckout"]',
    'input[name="proceedToCheckout"]',
    // ID-prefixed buttons + their containers
    "#sc-buy-box-ptc-button input",
    "#sc-buy-box-ptc-button button",
    "#sc-buy-box-ptc-button",
    'input[aria-labelledby*="ptc-button"]',
    // Side-cart and modern variants
    '[data-feature-id="proceed-to-checkout-action"]',
    '[data-feature-id="proceed-to-checkout-action"] button',
    '[data-feature-id="proceed-to-checkout-action"] input',
    // Anchor variants
    'a[href*="/gp/buy/spc/handlers/display.html"]',
    'a[href*="/cart/spc"]',
    // Generic text matches (Playwright's CSS-ish locator)
    'input[value*="Proceed to checkout" i]',
    'button:has-text("Proceed to checkout")',
    'a:has-text("Proceed to checkout")',
    'input[name*="checkout" i]',
  ];

  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click();
        await humanDelay();
        return;
      }
    } catch {
      /* ignore selector parse errors */
    }
  }

  // Diagnostic dump so the user / dev can fix the selector list
  const ctx = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      h1: document.querySelector("h1")?.textContent?.trim() ?? "",
      visibleButtons: Array.from(document.querySelectorAll("button, input[type=submit], a"))
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 40)
        .map((el) => {
          const e = el as HTMLElement;
          return {
            tag: e.tagName,
            name: e.getAttribute("name") ?? "",
            id: e.id,
            cls: (e.className || "").toString().slice(0, 80),
            text: (e.innerText || e.getAttribute("value") || "").slice(0, 80).trim(),
            href: (e as HTMLAnchorElement).href ?? "",
          };
        }),
    }))
    .catch(() => ({ url: page.url(), title: "(eval failed)", h1: "", visibleButtons: [] }));

  console.log("");
  console.log("  ── diagnostic: no Proceed-to-Checkout selector matched ──");
  console.log(`  URL:   ${ctx.url}`);
  console.log(`  Title: ${ctx.title}`);
  console.log(`  H1:    ${ctx.h1}`);
  console.log("  Visible clickables (first 40):");
  for (const b of ctx.visibleButtons) {
    const label = b.text || b.name || b.id || b.cls;
    if (!label) continue;
    console.log(`    [${b.tag}] ${label}${b.name ? ` (name=${b.name})` : ""}${b.id ? ` (id=${b.id})` : ""}`);
  }
  console.log("");

  // Last-resort fallback: programmatically submit the cart's
  // proceedToRetailCheckout form. Amazon serves a hidden form on the
  // cart page even when an upsell is overlaid. A GET to the handler
  // URL hits a 404 ("Bowser"); only POST-with-form-data works.
  console.log("  ↳ no selector matched — trying programmatic form submit");
  const submitted = await page
    .evaluate(() => {
      const forms = Array.from(document.querySelectorAll("form")) as HTMLFormElement[];
      for (const f of forms) {
        const action = (f.action || "").toLowerCase();
        const hasPtc = !!f.querySelector('input[name="proceedToRetailCheckout"], input[name="proceedToCheckout"]');
        if (action.includes("/gp/buy/spc/handlers") || hasPtc) {
          f.submit();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);

  if (submitted) {
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const afterUrl = page.url();
    if (/\/gp\/buy\/spc/i.test(afterUrl) && !/dogsofamazon|404/i.test(afterUrl)) {
      console.log(`  ✓ form submit landed on checkout: ${afterUrl}`);
      // If we landed on an upsell page again, try dismissing.
      await dismissInterstitial(page);
      return;
    }
    console.log(`  form submit ended at: ${afterUrl}`);
  }

  throw new Error(`Could not reach checkout (last URL: ${page.url()})`);
}

async function extractCheckoutTotal(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const tryParse = (s: string | null | undefined): number | null => {
      if (!s) return null;
      const m = s.replace(/[,\s]/g, "").match(/\$?([\d.]+)/);
      const n = m ? Number.parseFloat(m[1]) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    // Direct selectors for the "Order total" / "Grand total" row.
    const selectors = [
      "#subtotals-marketplace-grand-total-amount",
      "#subtotals-marketplace-table .grand-total-price",
      ".grand-total-price",
      ".order-summary-grand-total-price",
      "[data-feature-id='order-summary'] .a-price-whole",
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        const parsed = tryParse(el?.textContent);
        if (parsed !== null) return parsed;
      } catch {
        /* ignore selector syntax errors */
      }
    }
    // Row-scan: find the deepest element whose innerText starts with
    // "Order total" and grab the nearest $price in the same row's
    // parent. This avoids accidentally picking up "Items: $39.99"
    // when there's a separate "Order total: $44.21" further down.
    const all = Array.from(document.querySelectorAll("td, tr, div, span, dt, dd, li"));
    let best: number | null = null;
    for (const el of all) {
      const e = el as HTMLElement;
      const txt = (e.innerText ?? "").trim();
      // We want a "leaf-ish" element that says exactly "Order total:" or contains it
      // with its price on the same line.
      if (!/order\s+total/i.test(txt)) continue;
      // Look in the element itself and its parent row for a $ price.
      const candidates = [e, e.parentElement, e.parentElement?.parentElement].filter(Boolean) as HTMLElement[];
      for (const c of candidates) {
        const t = c.innerText ?? "";
        const m = t.match(/\$\s*([\d,]+\.\d{2})/g);
        if (m?.length) {
          // Prefer the LAST price on the row — Amazon lays out as
          // "Order total: $44.21" with the price on the right.
          best = tryParse(m[m.length - 1]);
          if (best !== null) return best;
        }
      }
    }
    return null;
  });
}

/**
 * Loops a few times, clicking "Continue to checkout" / dismissing
 * upsells (gift cards, Fresh groceries, Prime trial) until the
 * actual order-review page renders. Considered "loaded" when the
 * URL is on the SPC handler path AND we can see an "Order total"
 * or "Place order" affordance.
 */
async function dismissUntilCheckoutLoaded(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const url = page.url();
    const onSpc = /\/gp\/buy\/spc/i.test(url);
    const hasOrderTotal = await page
      .evaluate(() => {
        const txt = (document.body?.innerText || "").toLowerCase();
        return txt.includes("order total") || txt.includes("place order");
      })
      .catch(() => false);
    if (onSpc && hasOrderTotal) return;

    // Try generic dismissal first
    await dismissInterstitial(page);
    // Then MAPLE
    await dismissMapleUpsell(page);
    // Then look for "Continue to checkout" affordances
    const continueSelectors = [
      'a:has-text("Continue to checkout")',
      'button:has-text("Continue to checkout")',
      'input[value*="Continue to checkout" i]',
      'a[href*="/gp/buy/spc"]:has-text("Continue")',
      'a:has-text("Skip and continue")',
      'a:has-text("No, thanks")',
    ];
    for (const sel of continueSelectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          console.log(`  ↳ clicking '${sel}' to advance checkout`);
          await loc.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
          break;
        }
      } catch {
        /* ignore */
      }
    }
    await humanDelay();
  }
}

/**
 * If we landed on Amazon's "MAPLE_Repeat" gift-card upsell page
 * (/dp/<giftcard-asin>?ref_=MAPLE_Repeat&RU=/cart), click the
 * "Go to Cart" link in the right sidebar to break the redirect
 * loop and land on the real cart page. Idempotent.
 */
async function dismissMapleUpsell(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!/ref_?=MAPLE/i.test(page.url())) return;
    console.log("  ↳ MAPLE gift-card upsell detected — clicking 'Go to Cart'");
    const candidates = [
      'a:has-text("Go to Cart")',
      'button:has-text("Go to Cart")',
      'input[value="Go to Cart"]',
      'a[href="/gp/cart/view.html"]',
      'a[href*="/gp/cart/view.html"]',
    ];
    let clicked = false;
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          await loc.click({ timeout: 5_000 }).catch(() => {});
          clicked = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!clicked) {
      // Fallback: navigate to /gp/cart/view.html with a query string
      // that may bypass the upsell.
      await page.goto("https://www.amazon.com/gp/cart/view.html?proceedToALMCheckout=1", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await humanDelay();
  }
}

async function getShippingAddress(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const sel = [
      "#shipping-address-section",
      "[data-hook='shipping-address']",
      "#shipToThisAddress",
      ".displayAddressUL",
      "#delivery-address-selector",
      "#address-book-entry-0",
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el?.textContent) return el.textContent.replace(/\s+/g, " ").trim();
    }
    // Heuristic fallback: find the smallest element whose text starts
    // with "Delivering to" AND contains a recognizable address marker
    // (5-digit ZIP, "United States", or a state abbreviation).
    const all = Array.from(document.querySelectorAll("div, section, span"));
    let best: { el: HTMLElement; len: number } | null = null;
    for (const el of all) {
      const txt = ((el as HTMLElement).innerText ?? "").trim();
      if (!/^delivering to/i.test(txt)) continue;
      if (!/\b\d{5}(-\d{4})?\b|united states/i.test(txt)) continue;
      if (txt.length > 500) continue;
      if (!best || txt.length < best.len) {
        best = { el: el as HTMLElement, len: txt.length };
      }
    }
    if (best) {
      // Strip the heading, action links, and collapse whitespace.
      return best.el.innerText
        .replace(/^delivering to[:\s]*/i, "")
        .replace(/\b(change|add delivery instructions|free pickup available nearby)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    }
    return "";
  });
}
