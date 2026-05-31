/**
 * Shared Amazon checkout helpers used by BOTH the dry-run test script
 * (test-purchase.ts) AND the production purchase adapter
 * (purchase-amazon.ts). Keeping these in one place prevents the
 * adapters from drifting — selectors only need to be fixed once.
 *
 * All helpers are best-effort: they catch their own errors so they
 * can be chained safely.
 */

import type { Page } from "playwright";
import { captureScreenshot, humanDelay } from "./playwright-stealth.js";

/**
 * Click "No thanks" / "Continue without adding" / close-X on any of
 * Amazon's known post-add-to-cart upsells (Asurion warranty,
 * Subscribe & Save, Prime trial, gift cards, etc.). Idempotent.
 */
export async function dismissInterstitial(page: Page): Promise<void> {
  const candidates = [
    // Asurion protection-plan modal ("Add to your order" → "No thanks")
    'button:has-text("No thanks")',
    'a:has-text("No thanks")',
    'input[value="No thanks"]',
    'input[aria-label="No thanks"]',
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
    // Modal close X
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click({ timeout: 5_000 }).catch(() => {});
        await humanDelay();
        await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
        break;
      }
    } catch {
      /* ignore */
    }
  }
}

export async function readCartCount(page: Page): Promise<number> {
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
 * Poll the nav cart count, dismissing any blocking upsell modal each
 * iteration. Returns true if the cart count reached `atLeast` within
 * the timeout.
 */
export async function waitForCartCountWithDismiss(page: Page, atLeast: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await readCartCount(page)) >= atLeast) return true;
    await dismissInterstitial(page);
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

/**
 * Empty the Amazon cart. Navigates to the cart page, then iteratively
 * clicks Delete on each line item until the nav count reads 0 or we
 * hit the retry cap.
 *
 * Returns the count BEFORE the clear so the caller can audit
 * `cart.cleared { count }` only when it actually removed something.
 *
 * Best-effort. Doesn't throw on partial failure — callers wanting
 * a hard guarantee should re-check `readCartCount` after.
 */
export async function clearCart(page: Page): Promise<{ initial: number; remaining: number }> {
  const CART_URL = "https://www.amazon.com/gp/cart/view.html";
  await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  const initial = await readCartCount(page);
  if (initial === 0) return { initial, remaining: 0 };

  const removeSelectors = [
    'input[value="Delete"]',
    'span[data-feature-id="item-delete-button"] input',
    'input[aria-label*="Delete" i]',
    'input[name*="Delete" i]',
    'span:has-text("Delete") input',
  ];

  for (let attempt = 0; attempt < 10; attempt++) {
    const before = await readCartCount(page);
    if (before === 0) break;
    let clicked = false;
    for (const sel of removeSelectors) {
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
    if (!clicked) break;
    await new Promise((r) => setTimeout(r, 1500));
    await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  }

  const remaining = await readCartCount(page);
  return { initial, remaining };
}

/**
 * Click "Add to Cart" via the modern selectors. Throws if no selector
 * matches.
 */
export async function clickAddToCart(page: Page): Promise<void> {
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

/**
 * Amazon redirects /gp/cart/view.html into a "MAPLE_Repeat" gift-card
 * upsell at /dp/<giftcard-asin>?ref_=MAPLE_Repeat. The dismiss
 * affordance is a "Go to Cart" link in the right sidebar.
 */
export async function dismissMapleUpsell(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!/ref_?=MAPLE/i.test(page.url())) return;
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

/**
 * Click Proceed-to-Checkout. Falls back to programmatic form submit
 * if the button isn't visible (e.g. when an upsell overlays it).
 * Returns once we're on the SPC handler path.
 */
export async function proceedToCheckout(page: Page): Promise<void> {
  await humanDelay();
  await dismissInterstitial(page);

  await page.goto("https://www.amazon.com/gp/cart/view.html", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await dismissInterstitial(page);
  await humanDelay();

  await dismissMapleUpsell(page);

  const candidates = [
    'input[name="proceedToRetailCheckout"]',
    'input[name="proceedToCheckout"]',
    "#sc-buy-box-ptc-button input",
    "#sc-buy-box-ptc-button button",
    "#sc-buy-box-ptc-button",
    'input[aria-labelledby*="ptc-button"]',
    '[data-feature-id="proceed-to-checkout-action"]',
    '[data-feature-id="proceed-to-checkout-action"] button',
    '[data-feature-id="proceed-to-checkout-action"] input',
    'a[href*="/gp/buy/spc/handlers/display.html"]',
    'a[href*="/cart/spc"]',
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
      /* ignore */
    }
  }

  // Fallback: submit the form directly. A GET to the handler URL
  // returns 404; only POST-with-form works.
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
    return;
  }

  throw new Error(`Could not reach checkout (last URL: ${page.url()})`);
}

/**
 * Keep dismissing upsells (Fresh groceries, Prime trial, gift cards)
 * until the actual order-review page renders.
 */
export async function dismissUntilCheckoutLoaded(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const url = page.url();
    const onSpc = /\/gp\/buy\/spc/i.test(url);
    const hasOrderTotal = await page
      .evaluate(() => {
        const txt = (document.body?.innerText || "").toLowerCase();
        return txt.includes("order total") || txt.includes("place order") || txt.includes("place your order");
      })
      .catch(() => false);
    if (onSpc && hasOrderTotal) return;

    await dismissInterstitial(page);
    await dismissMapleUpsell(page);

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
 * Find the "Place your order" affordance on the order-review page
 * and click it. Throws with a diagnostic dump if no selector matches
 * — that dump goes to the action's error field so the operator can
 * see what changed.
 */
export async function clickPlaceOrder(page: Page, opts?: { screenshotPath?: string }): Promise<void> {
  await humanDelay();

  const candidates = [
    // Modern primary selectors
    "#placeOrder",
    "#submitOrderButtonId",
    "#placeYourOrder",
    "#placeYourOrder1",
    "#placeYourOrderButton",
    'input[name="placeYourOrder1"]',
    'button[name="placeYourOrder1"]',
    'input[id*="placeOrder"]',
    'button[id*="placeOrder"]',
    // Newer "spc" review page
    '[data-feature-id="place-order-button"]',
    '[data-feature-id="place-order-button"] input',
    '[data-feature-id="place-order-button"] button',
    '[data-csa-c-action="place-order-button"]',
    // Form-based fallback
    'input[type="submit"][value*="Place your order" i]',
    'input[type="submit"][value*="Place order" i]',
    // Text fallback (last resort)
    'button:has-text("Place your order")',
    'button:has-text("Place order")',
    'a:has-text("Place your order")',
    'input[aria-labelledby*="placeOrder" i]',
  ];

  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click({ timeout: 10_000 });
        await humanDelay();
        return;
      }
    } catch {
      /* ignore */
    }
  }

  // Diagnostic dump on miss — saved to error field for the operator.
  if (opts?.screenshotPath) {
    await captureScreenshot(page, opts.screenshotPath).catch(() => {});
  }
  const ctx = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      h1: document.querySelector("h1")?.textContent?.trim() ?? "",
      buttons: Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a"))
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 25)
        .map((el) => {
          const e = el as HTMLElement;
          return {
            tag: e.tagName,
            id: e.id,
            name: e.getAttribute("name") ?? "",
            text: (e.innerText || e.getAttribute("value") || "").slice(0, 50).trim(),
          };
        }),
    }))
    .catch(() => ({ url: page.url(), title: "?", h1: "", buttons: [] }));

  throw new Error(
    `Could not find Place Order button. URL: ${ctx.url} | H1: ${ctx.h1} | nearest buttons: ${ctx.buttons
      .filter((b) => b.text || b.id || b.name)
      .slice(0, 8)
      .map((b) => `[${b.tag}${b.id ? ` id=${b.id}` : ""}${b.name ? ` name=${b.name}` : ""}] ${b.text}`)
      .join("; ")}`,
  );
}
