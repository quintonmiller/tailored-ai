import { launchStealthBrowser, navigateWithDelay } from "../adapters/playwright-stealth.js";
import type { ExecutorContext, ValidationResult } from "../types.js";
import type { CartStateOutput, ReadAction } from "./types.js";

/**
 * amazon_read.cart_state
 *
 * Read-only: fetch current shopping cart contents.
 * No sensitive data. Auto-approve.
 */
export class CartStateAdapter implements ReadAction {
  public readonly type = "amazon_read.cart_state";
  public readonly autoApprove = true;
  public readonly auditAction = "amazon_read.cart_state";

  public validate(_input: Record<string, unknown>): ValidationResult {
    return { valid: true };
  }

  public async execute(_input: Record<string, unknown>, _ctx?: ExecutorContext): Promise<CartStateOutput> {
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

      try {
        // Navigate to cart
        await navigateWithDelay(page, "https://www.amazon.com/gp/cart/view.html");

        // Wait for cart content
        await page.waitForSelector("#cart-subtotal .sc-list", { timeout: 15000 }).catch(() => {});

        const items = await page.evaluate(() => {
          const itemRows = document.querySelectorAll("#cart-subtotal .sc-list > li");
          const result: Array<{
            title: string;
            price: string;
            quantity: number;
            url: string;
          }> = [];

          for (const row of itemRows) {
            const titleEl = row.querySelector("[data-hook='title']");
            const priceEl = row.querySelector("[data-hook='item-subtotal']") || row.querySelector("[data-a-price]");
            const qtyEl = row.querySelector("[data-hook='quantity']");
            const linkEl = row.querySelector("[data-hook='title'] a");

            result.push({
              title: titleEl?.textContent?.trim() || "",
              price: priceEl?.textContent?.trim() || "",
              quantity: parseInt(qtyEl?.textContent || "1", 10),
              url: linkEl?.getAttribute("href") || "",
            });
          }

          return result;
        });

        return {
          items,
          total_items: items.length,
        };
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
}
