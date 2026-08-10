import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import type { EventBus } from "../events.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { Registry } from "../registry.js";
import type { TaskBackend } from "../tasks/interface.js";
import type { Tool } from "./interface.js";
import type { TaskBackendResolver, TasksToolNotify } from "./tasks.js";

export interface ToolFactoryContext {
  /** Database handle (when available — some setups run without persistence). */
  db?: Database.Database;
  /** Absolute path to config file. Used by tools that need to locate
   *  sibling config artefacts (e.g. browser-mediator vault). */
  configPath?: string;
  /** Root context directory (parent of global/, agents/, kb/). */
  contextDir?: string;
  /** Resolve an outbound notifier for the given channel id. */
  resolveOutbound?: (channelId?: string) => import("../channels/outbound.js").OutboundNotifier | undefined;
  /** Resolve the owner id for the given channel id. */
  getOwnerId?: (channelId?: string) => string | undefined;
  /**
   * Repeat gate for unsolicited outbound messages. Tools that push at the user
   * without being asked should route through it; tools answering a request
   * should not.
   */
  getNotificationGate?: () => import("../notifications/dedup.js").NotificationGate | undefined;
  /** Single task backend (simple callers / tests). */
  taskBackend?: TaskBackend;
  /** Per-project task backend resolver (multi-project routing). When set,
   *  takes precedence over taskBackend. */
  taskBackendResolver?: TaskBackendResolver;
  /** Embedding provider getter for semantic recall. */
  getEmbedder?: () => EmbeddingProvider | undefined;
  /** Memory backend accessor for RecallTool / FactsTool. */
  getMemoryBackend?: () => Promise<import("../memory/interface.js").MemoryBackend>;
  /** Runtime-owned clock and timezone used by civil-time tools. */
  timeProvider?: import("../time/provider.js").ResolvedTimeProvider;
  /** Notify hook fired after a successful task mutation. */
  notifyTaskEvent?: TasksToolNotify;
  /** Runtime event bus. Tools emit typed events for plugin subscribers. */
  events?: EventBus;
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

export function registerToolFactory(id: string, factory: ToolFactory): void {
  toolFactoryRegistry.register(id, factory);
}

/**
 * The fixed set of meta-tool names always injected by createMetaTools().
 * validateConfig iterates this instead of a hardcoded inline array so both
 * stay in sync automatically.
 */
export const META_TOOL_NAMES: ReadonlyArray<string> = [
  "delegate",
  "task_status",
  "admin",
  "memory",
  "ask_user",
  "run_workflow",
  "resource_admin",
  "load_skill",
];

/**
 * Run every registered factory and aggregate the tools they produce. Called
 * by createTools; both built-in and plugin factories go through this path.
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
