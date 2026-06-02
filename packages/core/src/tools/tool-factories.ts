import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import type { Registries } from "../registries.js";
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

/**
 * Run every registered factory in the runtime's tool registry and aggregate
 * the tools they produce. Called by createTools after the always-on built-ins
 * (memory, read, write, exec, …) are constructed.
 */
export function runToolFactories(registries: Registries, config: AgentConfig, ctx: ToolFactoryContext): Tool[] {
  const out: Tool[] = [];
  for (const [id, factory] of registries.tools.entriesList()) {
    try {
      const produced = factory(config, ctx);
      out.push(...produced);
    } catch (err) {
      console.warn(`[tool-factory:${id}] failed to construct tools: ${(err as Error).message} — skipping`);
    }
  }
  return out;
}
