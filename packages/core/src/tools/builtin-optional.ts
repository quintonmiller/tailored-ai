/**
 * Built-in but *optional* tools — those whose construction is gated on a
 * config block. Each registers itself as a ToolFactory on module import, the
 * same shape an external plugin would use.
 *
 * Moving these out of the hardcoded if-blocks in createTools / createMetaTools
 * dogfoods the tool-factory registry: if any of these stops working, the
 * registry contract is broken.
 *
 * Importing this module side-effect-registers the factories.
 */

import { BrowserMediatorTool } from "./browser-mediator-tool.js";
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

// The trusted-actions tools (request_action, purchase_item, request_read,
// check_action_status) live in @tailored-ai/trusted-actions and register from
// that package's plugin entry, beside the HTTP routes it already owns. They
// are client code for one executor — a feature, not a seam — and core carried
// them only because the package did not exist yet when they were written.
