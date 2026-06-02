/**
 * Built-in but *optional* tools — those whose construction is gated on a
 * config block (browser-mediator, trusted-actions). Each is a ToolFactory
 * shaped the same way an external plugin would be.
 *
 * Seeded into every runtime's tool registry by {@link registerCoreBuiltins}.
 * Each factory remains gated on its own config; registration just makes
 * them resolvable by id.
 */

import type { PluginContext } from "../plugin-context.js";
import { BrowserMediatorTool } from "./browser-mediator-tool.js";
import { CheckActionStatusTool, PurchaseItemTool, RequestActionTool, RequestReadTool } from "./request-action.js";
import type { ToolFactory } from "./tool-factories.js";

const browserMediatorFactory: ToolFactory = (config, ctx) => {
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
};

const trustedActionsFactory: ToolFactory = (config) => {
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
};

// Google tools (gmail, google_calendar, google_drive) live in
// @tailored-ai/google-tools — install that package as a plugin to register
// them. Excluded from core to keep the dep surface lean.

/**
 * Register the built-in optional tools (browser_mediator, trusted_actions)
 * against the given PluginContext.
 */
export function registerBuiltinOptionalTools(ctx: PluginContext): void {
  ctx.tools.register("browser_mediator", browserMediatorFactory);
  ctx.tools.register("trusted_actions", trustedActionsFactory);
}
