import { launchStealthBrowser, navigateWithDelay } from "../adapters/playwright-stealth.js";
import type { ValidationResult } from "../types.js";
import type { ProductSummaryOutput, ReadAction } from "./types.js";

/**
 * amazon_read.product_summary
 *
 * Read-only: fetch product title, price, image, url.
 * No sensitive data, no approval gate. Auto-approve.
 */
export class ProductSummaryAdapter implements ReadAction {
  public readonly type = "amazon_read.product_summary";
  public readonly autoApprove = true;
  public readonly auditAction = "amazon_read.product_summary";

  public validate(input: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];
    if (!input.url && !input.query) {
      errors.push("Must provide either 'url' or 'query'");
    }
    if (input.url) {
      if (typeof input.url !== "string") {
        errors.push("url must be a string");
      } else {
        try {
          const parsed = new URL(input.url);
          if (parsed.hostname !== "amazon.com" && !parsed.hostname.endsWith(".amazon.com")) {
            errors.push("URL must point to amazon.com");
          }
        } catch {
          errors.push("Invalid URL format");
        }
      }
    }
    if (input.query && typeof input.query !== "string") {
      errors.push("query must be a string");
    }
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  public async execute(input: Record<string, unknown>): Promise<ProductSummaryOutput> {
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
        let productUrl = input.url as string | undefined;

        if (!productUrl && input.query) {
          // Search for the product
          const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(input.query as string)}`;
          await navigateWithDelay(page, searchUrl);

          const result = await page.evaluate(() => {
            const resultEl = document.querySelector('[data-component-type="s-search-result"]');
            if (!resultEl) return null;
            const titleEl = resultEl.querySelector("h2 a");
            return titleEl?.getAttribute("href") || null;
          });

          if (result) {
            productUrl = result.startsWith("http") ? result : `https://www.amazon.com${result}`;
          }
        }

        if (!productUrl) {
          throw new Error("No product URL available");
        }

        await navigateWithDelay(page, productUrl);

        const product = await page.evaluate(() => {
          const titleEl = document.querySelector("#title");
          const priceEl =
            document.querySelector("#priceblock_ourprice") ||
            document.querySelector("#price_inside_buybox") ||
            document.querySelector("[data-a-size='xl'] span.a-offscreen");
          const imgEl = document.querySelector("#landingImage");

          return {
            title: titleEl?.textContent?.trim() || "",
            price: priceEl?.textContent?.trim() || "",
            image: imgEl?.getAttribute("src") || "",
          };
        });

        return {
          title: product.title,
          price: product.price,
          image: product.image,
          url: productUrl,
        };
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
}
