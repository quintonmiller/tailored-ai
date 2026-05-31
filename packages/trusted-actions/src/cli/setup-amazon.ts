import { createStealthContext, launchStealthBrowser, serializeCookies } from "../adapters/playwright-stealth.js";
import { AgeStore } from "../secrets/age-store.js";

/**
 * One-time Amazon login CLI.
 *
 * Usage: `tai-executor setup amazon`
 *
 * Opens a HEADED Chromium window. The user logs in manually.
 * The CLI detects when the session is established (cookie present),
 * saves the session to the encrypted store, and verifies by
 * navigating to the orders page.
 */

export interface SetupAmazonOptions {
  /** Directory for encrypted secrets. */
  secretsDir?: string;
  /** Passphrase for encryption. */
  passphrase?: string;
}

export async function setupAmazon(opts?: SetupAmazonOptions): Promise<void> {
  console.log("🔐 Amazon Login Setup");
  console.log("======================");
  console.log("A browser window will open. Please log in to your Amazon account.");
  console.log("The CLI will detect when you're logged in and save your session.");
  console.log("Press Ctrl+C to cancel.\n");

  const store = new AgeStore({
    secretsDir: opts?.secretsDir,
    passphrase: opts?.passphrase,
  });

  // Launch headed browser
  const browser = await launchStealthBrowser({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    headed: true,
  });

  const context = await createStealthContext(browser, {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // Navigate to Amazon
  await page.goto("https://www.amazon.com", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  console.log("Waiting for login... (checking for session cookies)");

  // Poll for login detection
  const loginDetected = await waitForLogin(page, 300_000);

  if (!loginDetected) {
    console.log("\n⚠️  Timed out waiting for login. Session not saved.");
    await browser.close();
    process.exit(1);
    return;
  }

  console.log("✅ Login detected!");

  // Save session
  console.log("Saving session...");
  const cookies = await serializeCookies(context);
  const session = {
    cookies,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    savedAt: new Date().toISOString(),
  };

  await store.save("amazon_session", JSON.stringify(session));
  console.log("✅ Session saved to encrypted store.");

  // Verify by navigating to orders page
  console.log("Verifying session by visiting orders page...");
  await page.goto("https://www.amazon.com/orders", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const isLoggedIn = await page.evaluate(() => {
    // Check if we're on the orders page (not redirected to login)
    return !document.URL.includes("signin") && !document.URL.includes("ap-signin");
  });

  if (isLoggedIn) {
    console.log("✅ Verification successful — you're logged in!");

    // Cache the default shipping address
    console.log("Caching default shipping address...");
    const address = await page.evaluate(() => {
      const addressEl =
        document.querySelector("#shipping-address-section") || document.querySelector('[data-hook="shipping-address"]');
      return addressEl?.textContent?.trim() || "";
    });

    if (address) {
      const updatedSession = {
        ...session,
        defaultAddress: address,
      };
      await store.save("amazon_session", JSON.stringify(updatedSession));
      console.log(`✅ Default address cached: ${address}`);
    }
  } else {
    console.log("⚠️  Verification failed — session may be incomplete.");
    console.log("    You can re-run this command to try again.");
  }

  console.log("\n✅ Setup complete! You can now use 'purchase.amazon' actions.");
  await browser.close();
}

/**
 * Poll for login detection. The previous heuristic falsely fired on
 * anonymous visits because:
 *   - `session-id` is set for EVERY visitor as an anonymous tracker,
 *     not as a logged-in marker.
 *   - `#nav-account-list` exists on the page when logged out (it's
 *     the "Hello, sign in / Lists" dropdown).
 *
 * The real signal is the `at-main` cookie (or `at-acbus` on the US
 * site; `at-*` more generally). That's the access token Amazon sets
 * only AFTER a successful sign-in. We also cross-check the nav text —
 * "Hello, sign in" means we're still anonymous regardless of cookies.
 */
async function waitForLogin(page: any, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  let printedHint = false;

  while (Date.now() - startTime < timeoutMs) {
    // 1. Real "logged in" cookies. document.cookie hides httpOnly entries,
    //    so use the Playwright context's cookies API.
    const cookies = await page.context().cookies();
    const hasAccessToken = cookies.some(
      (c: { name: string }) => c.name === "at-main" || c.name.startsWith("at-acb") || c.name === "sess-at-main",
    );

    // 2. Nav-bar greeting. When logged out it says "Hello, sign in";
    //    when logged in it says "Hello, <first name>".
    const navText = await page
      .evaluate(() => {
        const el = document.querySelector("#nav-link-accountList-nav-line-1");
        return el?.textContent?.trim() ?? "";
      })
      .catch(() => "");
    const navSaysSignedIn = navText.length > 0 && !/sign\s*in/i.test(navText);

    if (hasAccessToken && navSaysSignedIn) {
      return true;
    }

    // Helpful hint after a few seconds so the user knows what we want.
    if (!printedHint && Date.now() - startTime > 4000) {
      console.log('  ↳ Click "Hello, sign in" in the top-right and complete the login flow.');
      printedHint = true;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("  Still waiting...");
  }

  return false;
}
