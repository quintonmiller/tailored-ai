import { launchStealthBrowser, navigateWithDelay } from "../adapters/playwright-stealth.js";
import type { ExecutorContext, ValidationResult } from "../types.js";
import type { OrderHistoryOutput, ReadAction } from "./types.js";

/**
 * amazon_read.order_history
 *
 * Read-only: fetch recent order history.
 * No sensitive data (no shipping address, no card info). Auto-approve.
 */
export class OrderHistoryAdapter implements ReadAction {
  public readonly type = "amazon_read.order_history";
  public readonly autoApprove = true;
  public readonly auditAction = "amazon_read.order_history";

  public validate(_input: Record<string, unknown>): ValidationResult {
    return { valid: true };
  }

  public async execute(_input: Record<string, unknown>, _ctx?: ExecutorContext): Promise<OrderHistoryOutput> {
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
        // Navigate to Your Orders page
        await navigateWithDelay(page, "https://www.amazon.com/gp/css/order-history");

        // Wait for order list to load
        await page.waitForSelector("[data-hook='order-row']", { timeout: 15000 }).catch(() => {});

        const orders = await page.evaluate(() => {
          const rows = document.querySelectorAll("[data-hook='order-row']");
          const result: Array<{
            order_id: string;
            date: string;
            status: string;
            total: string;
            items: string[];
          }> = [];

          for (const row of rows) {
            const orderIdEl = row.querySelector("[data-hook='order-id']");
            const dateEl = row.querySelector("[data-hook='order-buyer-date']");
            const statusEl = row.querySelector("[data-hook='order-status']");
            const totalEl = row.querySelector("[data-hook='order-total']");
            const itemEls = row.querySelectorAll("[data-hook='title']");

            const items: string[] = [];
            for (const item of itemEls) {
              const text = item.textContent?.trim();
              if (text) items.push(text);
            }

            result.push({
              order_id: orderIdEl?.textContent?.trim() || "",
              date: dateEl?.textContent?.trim() || "",
              status: statusEl?.textContent?.trim() || "",
              total: totalEl?.textContent?.trim() || "",
              items,
            });
          }

          return result;
        });

        return { orders };
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
}
