import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { createVaultTable } from "../../vault/schema.js";
import { getVaultKey, vaultSet } from "../../vault/vault.js";
import { AlwaysHitlRefusedError, BrowserMediator, EgressBlockedError } from "../mediator.js";

// Skip the whole suite when no browser binary is present. Playwright throws
// a recognisable error from chromium.launch() in that case; we probe once.
async function browserAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

let SKIP = false;
const describeMaybe = (name: string, fn: () => void) =>
  describe(name, () => {
    beforeAll(async () => {
      SKIP = !(await browserAvailable());
      if (SKIP) console.warn(`[mediator-integration] skipping — no browser available`);
    });
    fn();
  });

/** Tiny HTTP server we control — used as the "allowed" host in tests. */
async function startTestServer(html: string): Promise<{ server: Server; url: string }> {
  return await new Promise((resolveStart) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) throw new Error("bad address");
      resolveStart({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describeMaybe("BrowserMediator integration", () => {
  it("blocks navigation to a host not on the allow-list", async () => {
    if (SKIP) return;
    const m = new BrowserMediator({ egressAllowList: ["allowed.test"] });
    await m.start();
    try {
      await expect(m.navigate("http://blocked.test/")).rejects.toBeInstanceOf(EgressBlockedError);
    } finally {
      await m.close();
    }
  });

  it("allows navigation to an allow-listed host and reads its text", async () => {
    if (SKIP) return;
    const { server, url } = await startTestServer(
      `<html><body><h1>welcome</h1><a href="/next">Keep going</a></body></html>`,
    );
    const m = new BrowserMediator({ egressAllowList: ["127.0.0.1"] });
    await m.start();
    try {
      const navOut = await m.navigate(url);
      expect(navOut).toContain("Navigated to");
      const text = await m.readText();
      expect(text.toLowerCase()).toContain("welcome");
      const links = await m.readLinks();
      expect(links[0].text).toBe("Keep going");
      expect(links[0].node_id).toMatch(/^el:bm-[0-9a-f]{12}:\d+$/);
    } finally {
      await m.close();
      server.close();
    }
  });

  it("refuses to click always-HITL buttons", async () => {
    if (SKIP) return;
    const { server, url } = await startTestServer(
      `<html><body><button id="po">Place your order</button></body></html>`,
    );
    const m = new BrowserMediator({ egressAllowList: ["127.0.0.1"] });
    await m.start();
    try {
      await m.navigate(url);
      await expect(m.click("text=Place your order")).rejects.toBeInstanceOf(AlwaysHitlRefusedError);
    } finally {
      await m.close();
      server.close();
    }
  });

  it("expands $ns.key vault refs in type_text without echoing the secret", async () => {
    if (SKIP) return;
    const db = new Database(":memory:");
    createVaultTable(db);
    const key = getVaultKey();
    vaultSet(db, "test", "password", "hunter2-actual-secret", false, key);
    const { server, url } = await startTestServer(`<html><body><input id="pw" type="text" /></body></html>`);
    const audit: Array<Record<string, unknown>> = [];
    const m = new BrowserMediator({
      egressAllowList: ["127.0.0.1"],
      db,
      vaultKey: key,
      audit: (e) => audit.push(e as unknown as Record<string, unknown>),
    });
    await m.start();
    try {
      await m.navigate(url);
      const result = await m.typeText("text=", "$test.password");
      // The page received the real secret (verified via DOM read-back).
      // Audit log + return value show only the masked form.
      const page = (m as unknown as { page: import("playwright").Page }).page;
      const dom = await page.locator("#pw").inputValue();
      expect(dom).toBe("hunter2-actual-secret");
      expect(result).not.toContain("hunter2");
      const typeEntry = audit.find((a) => a.action === "type_text");
      expect(JSON.stringify(typeEntry)).not.toContain("hunter2");
      expect(JSON.stringify(typeEntry)).toContain("<masked:$test.password>");
    } finally {
      await m.close();
      server.close();
      db.close();
    }
  });

  it("sanitizes a credit-card number in read_text output", async () => {
    if (SKIP) return;
    // 4242 4242 4242 4242 is a Stripe test PAN; passes Luhn.
    const { server, url } = await startTestServer(
      `<html><body><p>Card on file: 4242424242424242 ending in 4242.</p></body></html>`,
    );
    const m = new BrowserMediator({ egressAllowList: ["127.0.0.1"] });
    await m.start();
    try {
      await m.navigate(url);
      const text = await m.readText();
      expect(text).not.toContain("4242424242424242");
      expect(text).toContain("[REDACTED-PAN]");
    } finally {
      await m.close();
      server.close();
    }
  });
});
