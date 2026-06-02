import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { Registry } from "../registry.js";
import type { Tool } from "./interface.js";

export interface ToolFactoryContext {
  /** Database handle (when available — some setups run without persistence). */
  db?: Database.Database;
  /** Other arbitrary options passed through from createTools. */
  [key: string]: unknown;
}

/**
 * A factory that produces zero or more Tools based on config + context.
 * Returning an empty array means "this factory's config is disabled or
 * incomplete — skip me." Useful for optional integrations whose tools only
 * exist when the user opts in (browser-mediator, trusted-actions, …).
 */
export type ToolFactory = (config: AgentConfig, ctx: ToolFactoryContext) => Tool[];

export const toolFactoryRegistry = new Registry<ToolFactory>("tool-factory");

/**
 * @deprecated Prefer the {@link Plugin} contract: have the host construct a
 * {@link PluginContext} and call `ctx.tools.register(id, factory)` instead.
 * This module-scope free function will be removed once internal consumers
 * are migrated — see #47 for the plan.
 */
export function registerToolFactory(id: string, factory: ToolFactory): void {
  toolFactoryRegistry.register(id, factory);
}

/**
 * Run every registered factory and aggregate the tools they produce. Called
 * by createTools after the always-on built-ins (memory, read, write, exec, …)
 * are constructed.
 */
export function runToolFactories(config: AgentConfig, ctx: ToolFactoryContext): Tool[] {
  const out: Tool[] = [];
  for (const [id, factory] of toolFactoryRegistry.entriesList()) {
    try {
      const produced = factory(config, ctx);
      out.push(...produced);
    } catch (err) {
      console.warn(`[tool-factory:${id}] failed to construct tools: ${(err as Error).message} — skipping`);
    }
  }
  return out;
}
