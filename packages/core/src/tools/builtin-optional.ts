/**
 * Built-in but *optional* tools — those whose construction is gated on a
 * config block (browser-mediator, trusted-actions). Each is a ToolFactory
 * shaped the same way an external plugin would be.
 *
 * Recommended: call {@link registerBuiltinOptionalTools} against your
 * runtime's PluginContext during boot. The module-level side effect at
 * the bottom of this file stays during the deprecation window so existing
 * core consumers don't break — see #47.
 *
 * Why these live here rather than in createTools's if-blocks: dogfooding
 * the tool-factory registry. If any of these stops working through the
 * registry, the registry contract is broken.
 */

import type { PluginContext } from "../plugin-context.js";
import { BrowserMediatorTool } from "./browser-mediator-tool.js";
import { CheckActionStatusTool, PurchaseItemTool, RequestActionTool, RequestReadTool } from "./request-action.js";
import { registerToolFactory, type ToolFactory } from "./tool-factories.js";

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
// @tailored-ai/google-tools — import that package once at startup to register
// them. They are excluded from core to keep the dependency surface lean.

/**
 * Register the built-in optional tools (browser_mediator, trusted_actions)
 * against the given PluginContext. Each remains gated on its own config
 * block; the registration just makes the factory available.
 */
export function registerBuiltinOptionalTools(ctx: PluginContext): void {
  ctx.tools.register("browser_mediator", browserMediatorFactory);
  ctx.tools.register("trusted_actions", trustedActionsFactory);
}

/**
 * @deprecated Importing this module for side effects is going away. Prefer
 * {@link registerBuiltinOptionalTools} called against your runtime's
 * PluginContext. See #47.
 */
registerToolFactory("browser_mediator", browserMediatorFactory);
/** @deprecated See above. */
registerToolFactory("trusted_actions", trustedActionsFactory);
