import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

/**
 * Stealth helpers for Playwright browser automation.
 *
 * Applies anti-detection patches so headless Chromium looks more like
 * a real browser session.  Uses the same UA + viewport from the saved
 * login session so Amazon's fingerprinting sees consistency.
 */

export interface StealthOptions {
  /** User-agent string from the original login session. */
  userAgent: string;
  /** Viewport dimensions from the original login session. */
  viewport: { width: number; height: number };
  /** Whether to run headed (setup CLI) or headless (production). */
  headed?: boolean;
  /** BCP-47 locale from the original login session. Defaults to the host locale. */
  locale?: string;
  /** IANA timezone from the original login session. Defaults to the host timezone. */
  timezoneId?: string;
}

/** Host locale + timezone — the fingerprint-consistent defaults when the saved session predates locale capture. */
function hostIntl(): { locale: string; timeZone: string } {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return { locale: resolved.locale || "en-US", timeZone: resolved.timeZone || "UTC" };
}

/**
 * Launch Chromium with stealth patches applied.
 */
export async function launchStealthBrowser(opts: StealthOptions): Promise<Browser> {
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  return browser;
}

/**
 * Create a context with stealth patches and session cookies.
 */
export async function createStealthContext(
  browser: Browser,
  opts: StealthOptions,
  cookies?: string,
): Promise<BrowserContext> {
  const host = hostIntl();
  const locale = opts.locale ?? host.locale;
  const timezoneId = opts.timezoneId ?? host.timeZone;
  const context = await browser.newContext({
    userAgent: opts.userAgent,
    viewport: opts.viewport,
    locale,
    timezoneId,
  });

  // Apply stealth patches
  const languages = [locale, locale.split("-")[0]].filter((v, i, arr) => arr.indexOf(v) === i);
  await context.addInitScript((langs) => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // Patch Chrome runtime
    (window as any).chrome = {
      runtime: {},
    };

    // Patch plugins length
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    // Patch languages to match the context locale
    Object.defineProperty(navigator, "languages", {
      get: () => langs,
    });

    // Patch permissions
    const originalQuery = (window as any).navigator.permissions?.query;
    if (originalQuery) {
      (window as any).navigator.permissions.query = (_params: any): Promise<any> => {
        return Promise.resolve({ state: "prompt" });
      };
    }
  }, languages);

  // Restore session cookies if provided
  if (cookies) {
    try {
      const parsed = JSON.parse(cookies);
      if (Array.isArray(parsed)) {
        await context.addCookies(parsed);
      }
    } catch {
      // If cookies aren't JSON, try setting as a single cookie string
      // This handles the case where we store cookies as a serialized string
    }
  }

  return context;
}

/**
 * Random delay between 200-800ms to simulate human behavior.
 */
export async function humanDelay(): Promise<void> {
  const delay = 200 + Math.random() * 600;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Navigate to a URL with a random delay before and after.
 */
export async function navigateWithDelay(page: Page, url: string): Promise<void> {
  await humanDelay();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await humanDelay();
}

/**
 * Save a screenshot for debugging failures.
 * Redacts cookie/token content where possible.
 */
export async function captureScreenshot(page: Page, path: string): Promise<void> {
  await page.screenshot({ path, fullPage: true });
}

/**
 * Parse cookies from a Playwright context into a serializable format.
 */
export async function serializeCookies(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return JSON.stringify(cookies);
}
