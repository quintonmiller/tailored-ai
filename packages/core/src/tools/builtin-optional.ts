/**
 * Built-in but *optional* tools — those whose construction is gated on a
 * config block (browser-mediator, trusted-actions). Each registers itself as a
 * ToolFactory on module import, the same shape an external plugin would use.
 *
 * Moving these out of the hardcoded if-blocks in createTools / createMetaTools
 * dogfoods the tool-factory registry: if any of these stops working, the
 * registry contract is broken.
 *
 * Importing this module side-effect-registers the factories.
 */

import { BrowserMediatorTool } from "./browser-mediator-tool.js";
import { CheckActionStatusTool, PurchaseItemTool, RequestActionTool, RequestReadTool } from "./request-action.js";
import { registerToolFactory } from "./tool-factories.js";

registerToolFactory("browser_mediator", (config, ctx) => {
  const bm = config.tools.browser_mediator;
  if (!bm?.enabled) return [];
  return [
    new BrowserMediatorTool({
      headless: bm.headless,
      timeoutMs: bm.timeoutMs,
      egressAllowList: bm.egressAllowList,
      db: bm.vaultEnabled ? (ctx.db as import("better-sqlite3").Database | undefined) : undefined,
    }),
  ];
});

// Google tools (gmail, google_calendar, google_drive) live in
// @tailored-ai/google-tools — import that package once at startup to register
// them. They are excluded from core to keep the dependency surface lean.

registerToolFactory("trusted_actions", (config) => {
  const ta = config.trustedActions;
  if (!ta?.enabled || !ta.url || !ta.sharedSecret) return [];
  const taiBase = ta.callbackBaseUrl ?? `http://host.docker.internal:${config.server?.port ?? 3000}`;
  const callbackUrl = `${taiBase.replace(/\/$/, "")}/api/trusted-actions/callback`;
  const opts = {
    url: ta.url,
    sharedSecret: ta.sharedSecret,
    callbackUrl,
  };
  return [
    new RequestActionTool(opts),
    new PurchaseItemTool(opts),
    new RequestReadTool(opts),
    new CheckActionStatusTool(opts),
  ];
});
