import type { Page } from "playwright";
import type {
  AmazonPurchaseInput,
  AmazonPurchaseOutput,
  AmazonSession,
  ApprovalCard,
  ExecutorContext,
  TrustedAction,
  ValidationResult,
} from "../types.js";
import { AddressMismatchError, PriceChangedError, ReauthError, SessionExpiredError } from "../types.js";
import {
  clearCart,
  clickAddToCart,
  clickPlaceOrder,
  dismissUntilCheckoutLoaded,
  proceedToCheckout as proceedToCheckoutFlow,
  waitForCartCountWithDismiss,
} from "./amazon-flow.js";
import {
  captureScreenshot,
  createStealthContext,
  humanDelay,
  launchStealthBrowser,
  navigateWithDelay,
} from "./playwright-stealth.js";

/**
 * Amazon purchase adapter.
 *
 * Implements the full headless checkout flow:
 * 1. Load saved session from encrypted credentials
 * 2. Navigate to product, verify price
 * 3. Add to cart, proceed to checkout
 * 4. Verify shipping address matches cached default
 * 5. Place order, capture order ID
 */
export class AmazonPurchaseAdapter implements TrustedAction<AmazonPurchaseInput, AmazonPurchaseOutput> {
  public readonly type = "purchase.amazon";

  /**
   * Validate the purchase input.
   */
  public validate(input: AmazonPurchaseInput): ValidationResult {
    const errors: string[] = [];

    // Must have either url or query
    if (!input.url && !input.query) {
      errors.push("Must provide either 'url' or 'query'");
    }

    // Validate URL if provided
    if (input.url) {
      try {
        const parsed = new URL(input.url);
        if (!parsed.hostname.includes("amazon.com")) {
          errors.push("URL must point to amazon.com");
        }
      } catch {
        errors.push("Invalid URL format");
      }
    }

    // Validate max_price
    if (typeof input.max_price !== "number" || input.max_price <= 0) {
      errors.push("max_price must be a positive number");
    }

    // Validate qty
    if (input.qty !== undefined) {
      if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 10) {
        errors.push("qty must be an integer between 1 and 10");
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Describe the purchase for the approval card.
   * Scrapes the product page to get title, price, and image.
   */
  public async describeForApproval(input: AmazonPurchaseInput): Promise<ApprovalCard> {
    let productUrl = input.url;
    let title = "";
    let price = "";
    let imageUrl = "";

    // If the query string contains an Amazon ASIN, treat it as a direct
    // URL lookup. This avoids weak search matches when the user pastes
    // an ASIN alongside a description (e.g. "usb-c cable B0CSFQQVVT").
    if (!productUrl && input.query) {
      const asin = extractAsin(input.query);
      if (asin) productUrl = `https://www.amazon.com/dp/${asin}`;
    }

    if (productUrl) {
      const product = await this.scrapeProduct(productUrl);
      title = product.title;
      price = product.price;
      imageUrl = product.image;
    } else if (input.query) {
      const searchResult = await this.searchAmazon(input.query);
      productUrl = searchResult.url;
      title = searchResult.title;
      price = searchResult.price;
      imageUrl = searchResult.image;
    }

    // Final fallback for the notification title: if we couldn't resolve
    // a product at all, surface the user's query / URL + cap so the
    // approver isn't staring at "Unknown Product".
    const safeTitle =
      title ||
      (input.query
        ? `Search: ${input.query.slice(0, 60)}`
        : productUrl
          ? `Product page (couldn't scrape title)`
          : "Unspecified product");

    const cap = `$${input.max_price.toFixed(2)}`;
    return {
      title: `Purchase: ${safeTitle}`,
      body: `Price: ${price || "unknown"}  |  cap: ${cap}`,
      imageUrl,
      estimatedCost: price,
      metadata: {
        url: productUrl || "",
        qty: String(input.qty || 1),
      },
    };
  }

  /**
   * Execute the purchase.
   */
  public async execute(input: AmazonPurchaseInput, ctx: ExecutorContext): Promise<AmazonPurchaseOutput> {
    // 1. Load saved session
    const sessionJson = await ctx.decryptCredentials("amazon_session");
    if (!sessionJson) {
      throw new SessionExpiredError();
    }

    const session: AmazonSession = JSON.parse(sessionJson);

    // 2. Launch browser with stealth
    const browser = await launchStealthBrowser({
      userAgent: session.userAgent,
      viewport: session.viewport,
      headed: false,
    });

    try {
      const context = await createStealthContext(
        browser,
        {
          userAgent: session.userAgent,
          viewport: session.viewport,
          locale: session.locale,
          timezoneId: session.timezoneId,
        },
        session.cookies,
      );

      const page = await context.newPage();

      try {
        // 3. Navigate to product
        let productUrl = input.url;
        if (!productUrl && input.query) {
          // Prefer an ASIN embedded in the query over fuzzy search, so
          // execute resolves to the same product the user approved.
          const asin = extractAsin(input.query);
          if (asin) {
            productUrl = `https://www.amazon.com/dp/${asin}`;
          } else {
            const searchResult = await this.searchAmazon(input.query);
            productUrl = searchResult.url;
          }
        }

        if (!productUrl) {
          throw new Error("No product URL available");
        }

        // 2a. Pre-clear the cart. A stale row from a prior session would
        //     silently join this order otherwise. Audit how many we
        //     removed (zero is a no-op).
        const { initial: cartBefore, remaining: cartAfter } = await clearCart(page);
        if (cartBefore > 0) {
          ctx.audit?.("cart.cleared", { count: cartBefore, remaining: cartAfter });
        }
        if (cartAfter > 0) {
          // We tried but couldn't fully empty it. Refuse to add — adding
          // another item now would mean the operator-approved price
          // doesn't cover the rest of the cart.
          await captureScreenshot(page, this.screenshotPath("cart_clear_failed"));
          throw new Error(`Cart could not be emptied (${cartAfter} item(s) still present after retries).`);
        }

        await navigateWithDelay(page, productUrl);
        // Amazon may bounce here if cookies expired entirely.
        if (await this.ensureAuthenticated(page, ctx)) {
          await navigateWithDelay(page, productUrl);
        }

        // Verify price hasn't changed
        const currentPrice = await this.extractPrice(page);
        if (currentPrice && currentPrice > input.max_price) {
          await captureScreenshot(page, this.screenshotPath("price_changed"));
          throw new PriceChangedError(currentPrice, input.max_price);
        }

        // 4. Add to cart. Many products open a warranty / Subscribe&Save
        //    modal that blocks the actual add — dismiss it and only
        //    proceed once the nav cart count has actually incremented.
        await clickAddToCart(page);
        const added = await waitForCartCountWithDismiss(page, 1, 20_000);
        if (!added) {
          await captureScreenshot(page, this.screenshotPath("add_to_cart_failed"));
          throw new Error("Add-to-cart click did not register within 20s — likely out of stock or a blocking upsell.");
        }

        // 5. Proceed to checkout: dismisses the MAPLE gift-card upsell
        //    and submits the cart form when the visible button isn't
        //    reachable.
        await proceedToCheckoutFlow(page);

        // 5a. Amazon enforces pape.max_auth_age=900 here — this is the
        //     most common place the executor hits an /ap/signin wall.
        //     If reauth succeeds, the post-signin redirect lands on
        //     checkout anyway, so no manual re-navigation needed.
        await this.ensureAuthenticated(page, ctx);

        // 6. Walk through any Fresh / Prime / gift-card interstitials
        //    until the actual order-review page renders.
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await dismissUntilCheckoutLoaded(page);

        // 6a. Some sessions get re-challenged again right before the
        //     review page renders.
        await this.ensureAuthenticated(page, ctx);

        // 7. Verify shipping address
        const currentAddress = await this.getShippingAddress(page);
        if (session.defaultAddress && currentAddress) {
          if (!currentAddress.includes(session.defaultAddress)) {
            await captureScreenshot(page, this.screenshotPath("address_mismatch"));
            throw new AddressMismatchError(session.defaultAddress, currentAddress);
          }
        }

        // 8. Place order
        await clickPlaceOrder(page, {
          screenshotPath: this.screenshotPath("place_order_failed"),
        });

        // 8. Capture order confirmation
        const orderId = await this.extractOrderId(page);
        const finalPrice = currentPrice || input.max_price;
        const eta = await this.extractETA(page);

        return {
          order_id: orderId,
          final_price: finalPrice,
          eta: eta || "unknown",
        };
      } catch (error: any) {
        // Capture screenshot on failure
        const screenshotPath = this.screenshotPath(`failure_${Date.now()}`);
        await captureScreenshot(page, screenshotPath);
        throw error;
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async searchAmazon(query: string): Promise<{
    url: string;
    title: string;
    price: string;
    image: string;
  }> {
    const browser = await launchStealthBrowser({
      userAgent: "Mozilla/5.0 (compatible; TAI-Executor/1.0)",
      viewport: { width: 1280, height: 720 },
      headed: false,
    });

    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (compatible; TAI-Executor/1.0)",
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Extract first result
      const result = await page.evaluate(() => {
        const resultEl = document.querySelector('[data-component-type="s-search-result"]');
        if (!resultEl) return null;

        const titleEl = resultEl.querySelector("h2 a");
        const priceEl =
          resultEl.querySelector("span.a-price-whole") ||
          resultEl.querySelector("[data-component-type='search'] span.a-offscreen");
        const imgEl = resultEl.querySelector("img.s-image");

        return {
          url: titleEl?.getAttribute("href") || "",
          title: titleEl?.textContent?.trim() || "",
          price: priceEl?.textContent?.trim() || "",
          image: imgEl?.getAttribute("src") || "",
        };
      });

      await browser.close();

      if (!result) {
        throw new Error(`No search results found for: ${query}`);
      }

      return result;
    } catch {
      await browser.close();
      throw new Error(`Search failed for: ${query}`);
    }
  }

  private async scrapeProduct(url: string): Promise<{
    title: string;
    price: string;
    image: string;
  }> {
    const browser = await launchStealthBrowser({
      userAgent: "Mozilla/5.0 (compatible; TAI-Executor/1.0)",
      viewport: { width: 1280, height: 720 },
      headed: false,
    });

    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (compatible; TAI-Executor/1.0)",
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      const product = await page.evaluate(() => {
        const titleEl = document.querySelector("#productTitle") || document.querySelector("#title");
        const priceSelectors = [
          ".a-price.priceToPay .a-offscreen",
          ".a-price .a-offscreen",
          "[data-a-color='price'] .a-offscreen",
          "#corePriceDisplay_desktop_feature_div .a-offscreen",
          "#priceblock_ourprice",
          "#priceblock_dealprice",
          "#priceblock_saleprice",
          "#price_inside_buybox",
        ];
        let price = "";
        for (const sel of priceSelectors) {
          const el = document.querySelector(sel);
          const text = el?.textContent?.trim();
          if (text && /\$?\d/.test(text)) {
            price = text;
            break;
          }
        }
        const imgEl =
          document.querySelector("#landingImage") ||
          document.querySelector("#imgBlkFront") ||
          document.querySelector("img[data-old-hires]");
        return {
          title: titleEl?.textContent?.trim() || "",
          price,
          image: imgEl?.getAttribute("src") || imgEl?.getAttribute("data-old-hires") || "",
        };
      });

      await browser.close();
      return product;
    } catch {
      await browser.close();
      throw new Error(`Failed to scrape product: ${url}`);
    }
  }

  private async extractPrice(page: Page): Promise<number | null> {
    return await page.evaluate(() => {
      const selectors = [
        ".a-price.priceToPay .a-offscreen",
        ".a-price .a-offscreen",
        "[data-a-color='price'] .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "#priceblock_saleprice",
        "#price_inside_buybox",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (!text) continue;
        const m = text.match(/[\d,]+(\.\d{2})?/);
        if (m) {
          const n = parseFloat(m[0].replace(/,/g, ""));
          if (Number.isFinite(n)) return n;
        }
      }
      return null;
    });
  }

  private async getShippingAddress(page: Page): Promise<string> {
    return await page.evaluate(() => {
      // Try to find the shipping address section
      const addressEl =
        document.querySelector("#shipping-address-section") || document.querySelector('[data-hook="shipping-address"]');

      if (addressEl) {
        return addressEl.textContent?.trim() || "";
      }

      // Fallback: look for any address-like content
      const allText = document.body.textContent || "";
      const match = allText.match(/shipping to:?\s*(.+?)(?:\n|$)/i);
      return match?.[1]?.trim() || "";
    });
  }

  private async extractOrderId(page: Page): Promise<string> {
    return await page.evaluate(() => {
      // Look for order ID in the confirmation page
      const orderEl =
        document.querySelector('[data-hook="order-reference"]') || document.querySelector("#orderSummaryReference");

      if (orderEl) {
        return orderEl.textContent?.trim() || "";
      }

      // Fallback: look for order ID pattern in page text
      const text = document.body.textContent || "";
      const match = text.match(/Order\s*ID[:\s]+([A-Z0-9-]+)/i);
      return match?.[1] || "";
    });
  }

  private async extractETA(page: Page): Promise<string> {
    return await page.evaluate(() => {
      const etaEl =
        document.querySelector('[data-hook="delivery-date"]') || document.querySelector(".order-summary-delivery-date");

      if (etaEl) {
        return etaEl.textContent?.trim() || "";
      }

      return "";
    });
  }

  /**
   * If the page is parked on Amazon's sign-in flow, fill in the
   * stored password and submit. Returns true if a reauth happened
   * (caller may need to re-navigate), false if no reauth was needed.
   *
   * Throws ReauthError on any failure mode the executor cannot
   * recover from (no stored password, captcha, 2FA, wrong password).
   */
  private async ensureAuthenticated(page: Page, ctx: ExecutorContext): Promise<boolean> {
    if (!(await this.isSignInPage(page))) return false;

    const url = page.url();
    ctx.audit?.("auth.reauth.required", { url });

    let password: string;
    try {
      password = await ctx.decryptCredentials("amazon_password");
    } catch {
      const path = this.screenshotPath("reauth_no_password");
      await captureScreenshot(page, path).catch(() => {});
      ctx.audit?.("auth.reauth.failed", { reason: "no_password" });
      throw new ReauthError("no_password", path);
    }
    if (!password) {
      const path = this.screenshotPath("reauth_no_password");
      await captureScreenshot(page, path).catch(() => {});
      ctx.audit?.("auth.reauth.failed", { reason: "no_password" });
      throw new ReauthError("no_password", path);
    }

    try {
      const pwField = page.locator("#ap_password");
      if ((await pwField.count()) === 0) {
        // Page looks like a signin URL but the form isn't standard —
        // captcha-gated signin, weird interstitial, etc.
        const path = this.screenshotPath("reauth_no_password_field");
        await captureScreenshot(page, path).catch(() => {});
        ctx.audit?.("auth.reauth.failed", { reason: "unknown", url });
        throw new ReauthError("unknown", path);
      }

      await pwField.fill(password);
      await humanDelay();
      const submit = page.locator("#signInSubmit");
      if ((await submit.count()) > 0) {
        await submit.click();
      } else {
        await page.keyboard.press("Enter");
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});

      if (await this.isTwoFactorPage(page)) {
        const path = this.screenshotPath("reauth_two_factor");
        await captureScreenshot(page, path).catch(() => {});
        ctx.audit?.("auth.reauth.failed", { reason: "two_factor" });
        throw new ReauthError("two_factor", path);
      }
      if (await this.isCaptchaPage(page)) {
        const path = this.screenshotPath("reauth_captcha");
        await captureScreenshot(page, path).catch(() => {});
        ctx.audit?.("auth.reauth.failed", { reason: "captcha" });
        throw new ReauthError("captcha", path);
      }
      if (await this.isSignInPage(page)) {
        // Bounced back to signin — almost always wrong password.
        const path = this.screenshotPath("reauth_wrong_password");
        await captureScreenshot(page, path).catch(() => {});
        ctx.audit?.("auth.reauth.failed", { reason: "wrong_password" });
        throw new ReauthError("wrong_password", path);
      }

      ctx.audit?.("auth.reauth.completed");
      return true;
    } finally {
      // Defense-in-depth scrub: shred the local variable. Playwright's
      // process memory may retain copies inside the page snapshot,
      // so this isn't a guarantee — just removes the obvious one.
      password = "\0".repeat(password.length);
      void password;
    }
  }

  private async isSignInPage(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("/ap/signin") || url.includes("/ap/authorize")) return true;
    return await page.evaluate(() => !!document.querySelector("#ap_password")).catch(() => false);
  }

  private async isTwoFactorPage(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("/ap/mfa") || url.includes("/ap/verify") || url.includes("action=verify")) {
      return true;
    }
    return await page
      .evaluate(() => {
        const selectors = [
          "#auth-mfa-otpcode",
          "#authenticatorToken",
          "#otpCode",
          "#challengeCode",
          '[data-hook="otp-input"]',
        ];
        return selectors.some((s) => document.querySelector(s) !== null);
      })
      .catch(() => false);
  }

  private async isCaptchaPage(page: Page): Promise<boolean> {
    return await page
      .evaluate(() => {
        const selectors = [
          "#auth-captcha-image",
          "#captchacharacters",
          "form[action*='/errors/validateCaptcha']",
          "#recaptcha-container",
        ];
        return selectors.some((s) => document.querySelector(s) !== null);
      })
      .catch(() => false);
  }

  private screenshotPath(suffix: string): string {
    const screenshotsDir = process.env.TAI_EXECUTOR_SCREENSHOTS || `${process.env.HOME}/.tai-executor/screenshots`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${screenshotsDir}/${suffix}_${timestamp}.png`;
  }
}

/**
 * Extract an Amazon ASIN from a free-text string. Returns the first
 * 10-character match starting with "B0" (the format used for products
 * since ~2014). Returns null if no plausible ASIN is found.
 */
function extractAsin(s: string): string | null {
  // ASINs in URLs use /dp/<asin> or /gp/product/<asin>; in queries they
  // typically appear as a bare token. Word-boundary match.
  const m = s.match(/\b(B0[A-Z0-9]{8})\b/);
  return m ? m[1] : null;
}
