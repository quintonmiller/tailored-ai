import type { AgentConfig } from "./config.js";
import type { EventBus } from "./events.js";
import type { EmbeddingProvider } from "./providers/embedding.js";
import {
  buildOpenAICompatibleProvider,
  embeddingFactoryRegistry,
  isInlineOpenAICompatible,
  providerFactoryRegistry,
} from "./providers/factories.js";
import type { AIProvider } from "./providers/interface.js";
import type { TaskBackend } from "./tasks/interface.js";
import { AdminTool } from "./tools/admin.js";
import { CoreMemoryTool } from "./tools/core-memory.js";
import { DelegateTool } from "./tools/delegate.js";
import type { Tool } from "./tools/interface.js";
import { LoadSkillTool } from "./tools/load-skill.js";
import { ResourceAdminTool } from "./tools/resource-admin.js";
import { RunWorkflowTool } from "./tools/run-workflow.js";
import { TaskStatusTool } from "./tools/task-status.js";
import type { TaskBackendResolver, TasksToolNotify } from "./tools/tasks.js";
import { runToolFactories } from "./tools/tool-factories.js";
// Side-effect import: registers all built-in tool factories (memory, exec,
// read, write, web_fetch, web_search, facts, recall, tasks, notify_owner,
// claude_code, browser, md_to_pdf, projects, documents, extract_document,
// ask_user, custom_tools) on module load.
import "./tools/builtin.js";
// Side-effect import: registers built-in optional tool factories
// (browser_mediator, trusted_actions) on module load.
import "./tools/builtin-optional.js";
import type { AgentRuntime } from "./runtime.js";

export interface CreateToolsOptions {
  resolveOutbound?: (channelId?: string) => import("./channels/outbound.js").OutboundNotifier | undefined;
  /** Deliver a message straight to another agent and return its reply. */
  deliverAgentMessage?: (to: string, from: string, body: string) => Promise<string>;
  getOwnerId?: (channelId?: string) => string | undefined;
  /** Repeat gate for unsolicited outbound messages. See NotificationGate. */
  getNotificationGate?: () => import("./notifications/dedup.js").NotificationGate | undefined;
  db?: import("better-sqlite3").Database;
  /** Override the task backend. Defaults to `createTaskBackend(config, db)` when `db` is provided. */
  taskBackend?: TaskBackend;
  /** Resolve the task backend per project at call time. When set, takes
   *  precedence over `taskBackend` and enables per-project routing
   *  (different repos / DBs for different projects). The runtime wires
   *  this so a single agent invocation can file tasks across multiple
   *  project-scoped trackers. */
  taskBackendResolver?: TaskBackendResolver;
  /** Optional embedding provider getter for semantic recall. */
  getEmbedder?: () => EmbeddingProvider | undefined;
  /** Memory backend accessor — when wired, the RecallTool's `query`
   *  action routes through `backend.query` instead of calling SQLite
   *  directly. Phase 2 wiring; Phase 3 will route the other actions too. */
  getMemoryBackend?: () => Promise<import("./memory/interface.js").MemoryBackend>;
  /** Notify hook fired after a successful task mutation. Wires the tasks
   *  tool to the task watcher so coder→reviewer handoffs re-trigger routing
   *  (docs/agent-unification.md, Phase 6). */
  notifyTaskEvent?: TasksToolNotify;
  /** Runtime event bus. When supplied, the tasks tool emits typed
   *  `task.created` / `task.updated` / `task.transitioned` / `task.commented`
   *  events for plugin subscribers (`docs/platform-vision.md`, Slice 2).
   *  Distinct from `notifyTaskEvent`: the notify hook is the legacy watcher
   *  callback that re-runs routing; the bus is the new public surface that
   *  plugins consume. */
  events?: EventBus;
}

/**
 * Build an embedding provider from config. Returns undefined when embeddings
 * are disabled (the default), required config is missing, or the requested
 * factory id is not registered.
 */
export function createEmbedder(config: AgentConfig): EmbeddingProvider | undefined {
  const cfg = config.memory?.embeddings;
  if (!cfg?.enabled) return undefined;
  const id = cfg.type ?? "openai_compatible";
  const factory = embeddingFactoryRegistry.get(id);
  if (!factory) {
    const known = embeddingFactoryRegistry.list().join(", ") || "(none)";
    console.warn(`[factories] No embedding factory registered for "${id}". Known: ${known}. Disabling embeddings.`);
    return undefined;
  }
  return factory(config);
}

export function createTools(
  config: AgentConfig,
  contextDir: string,
  configPath?: string,
  opts?: CreateToolsOptions,
): Tool[] {
  // NOTE: CoreMemoryTool is registered as a META tool in createMetaTools(),
  // not as a regular tool here. Identity maintenance is foundational —
  // every named agent gets it regardless of its `tools:` allowlist.

  // Every tool — built-in and plugin — constructs through the tool-factory
  // registry. Built-in factories are registered by the side-effect imports
  // of tools/builtin.ts and tools/builtin-optional.ts above; plugin factories
  // register when the plugin module is imported at startup.
  return runToolFactories(config, {
    db: opts?.db,
    configPath,
    contextDir,
    resolveOutbound: opts?.resolveOutbound,
    getOwnerId: opts?.getOwnerId,
    getNotificationGate: opts?.getNotificationGate,
    deliverAgentMessage: opts?.deliverAgentMessage,
    taskBackend: opts?.taskBackend,
    taskBackendResolver: opts?.taskBackendResolver,
    getEmbedder: opts?.getEmbedder,
    getMemoryBackend: opts?.getMemoryBackend,
    notifyTaskEvent: opts?.notifyTaskEvent,
    events: opts?.events,
  });
}

export function createProvider(config: AgentConfig): { provider: AIProvider; model: string } {
  const id = config.agent.defaultProvider;
  const factory = providerFactoryRegistry.get(id);
  // A registered factory id always wins over an inline type (#253).
  if (factory) return factory(config);

  // No factory under this id. If the config opts into the built-in
  // OpenAI-compatible provider — `type: openai_compatible`, or a bare
  // `baseUrl` — build it inline under `id` so multiple OpenAI-wire endpoints
  // (local vLLM + DeepSeek + Groq + …) can coexist without a per-vendor
  // plugin (#253).
  const cfg = config.providers[id];
  if (isInlineOpenAICompatible(cfg)) {
    return buildOpenAICompatibleProvider(cfg, id);
  }

  const known = providerFactoryRegistry.list().join(", ") || "(none)";
  throw new Error(
    `No provider factory registered for "${id}". Known: ${known}. ` +
      `Hosted providers ship as plugins — install the package that registers "${id}" ` +
      `(e.g. @tailored-ai/provider-${id}) and add it to the plugins: list, ` +
      `register a custom factory with registerProviderFactory(), ` +
      `or set providers.${id}.type: openai_compatible (with a baseUrl) to use the built-in OpenAI-compatible provider.`,
  );
}

export function createMetaTools(runtime: AgentRuntime, contextDir: string, kbDir: string): Tool[] {
  const delegateTool = new DelegateTool({
    getConfig: () => runtime.getConfig(),
    db: runtime.db,
    getProvider: () => runtime.getProvider(),
    // Resolvable, not registered: the delegate target's `tools:` allowlist may
    // name a meta tool, and it will hold one at run time either way. Lazy, so
    // it reads the meta tools this call is in the middle of building.
    getTools: () => runtime.getResolvableTools(),
    contextDir,
    kbDir,
  });
  const taskStatusTool = new TaskStatusTool();
  const adminTool = new AdminTool(runtime);
  const runWorkflowTool = new RunWorkflowTool({
    getEngine: () => runtime.getWorkflowEngine(),
    getRegistry: () => runtime.getWorkflows(),
  });
  const resourceAdminTool = new ResourceAdminTool({ runtime });
  const loadSkillTool = new LoadSkillTool({ getSkillRegistry: () => runtime.getSkillRegistry() });
  // CoreMemoryTool: always available, even when an agent's `tools:` allowlist
  // omits it. The agent needs to be able to maintain its own identity
  // regardless of which other tools it's been narrowed to.
  const coreMemoryTool = new CoreMemoryTool(runtime.db, {
    getMemoryBackend: () => runtime.getMemoryBackend(),
  });

  // Trusted-actions tools used to be constructed inline here. They now
  // register through the tool-factory registry (tools/builtin-optional.ts)
  // and arrive via createTools → runToolFactories. Plugin authors writing a
  // similar config-gated tool follow the same path.
  return [delegateTool, taskStatusTool, adminTool, runWorkflowTool, resourceAdminTool, loadSkillTool, coreMemoryTool];
}
