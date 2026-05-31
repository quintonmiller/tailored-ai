import { dispatchToMediator, TOOL_DESCRIPTION, TOOL_NAME, TOOL_PARAMETERS } from "@tailored-ai/browser-mediator";
import type Database from "better-sqlite3";
import { BrowserMediator, type BrowserMediatorOptions } from "../browser/mediator.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * TAI Tool adapter around the framework-agnostic
 * `@tailored-ai/browser-mediator` package. The Tool boilerplate
 * (name/description/parameters) comes straight from the upstream
 * shared dispatcher so TAI and any other adapter stay in lock-step.
 */
export interface BrowserMediatorToolConfig {
  enabled?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  egressAllowList?: string[];
  alwaysHitlConfig?: BrowserMediatorOptions["alwaysHitlConfig"];
  /** When set, type_text values run through vault $ns.key expansion. */
  db?: Database.Database;
  vaultKey?: Buffer;
}

export class BrowserMediatorTool implements Tool {
  name = TOOL_NAME;
  description = TOOL_DESCRIPTION;
  parameters = TOOL_PARAMETERS as unknown as Record<string, unknown>;

  private mediator: BrowserMediator;

  constructor(config: BrowserMediatorToolConfig) {
    this.mediator = new BrowserMediator({
      headless: config.headless ?? true,
      timeoutMs: config.timeoutMs,
      egressAllowList: config.egressAllowList,
      alwaysHitlConfig: config.alwaysHitlConfig,
      db: config.db,
      vaultKey: config.vaultKey,
    });
  }

  /** Test/seam: swap the mediator for a fake. */
  setMediator(m: BrowserMediator): void {
    this.mediator = m;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const r = await dispatchToMediator(this.mediator, args);
    return { success: r.ok, output: r.output, error: r.error };
  }
}
