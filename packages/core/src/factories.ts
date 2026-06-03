import { resolve } from "node:path";
import type { AgentConfig } from "./config.js";
import type { EmbeddingProvider } from "./providers/embedding.js";
import { embeddingFactoryRegistry, providerFactoryRegistry } from "./providers/factories.js";
import type { AIProvider } from "./providers/interface.js";
import { createEgressPolicy } from "./security/egress-policy.js";
import { createTaskBackend } from "./tasks/factory.js";
import type { TaskBackend } from "./tasks/interface.js";
import { AdminTool } from "./tools/admin.js";
import { AskUserTool } from "./tools/ask-user.js";
import { BrowserTool } from "./tools/browser.js";
import { ClaudeCodeTool } from "./tools/claude-code.js";
import { CoreMemoryTool } from "./tools/core-memory.js";
import { createCustomTools } from "./tools/custom.js";
import { DelegateTool } from "./tools/delegate.js";
import { DiscordDmTool } from "./tools/discord-dm.js";
import { DocumentsTool } from "./tools/documents.js";
import { ExecTool } from "./tools/exec.js";
import { ExtractDocumentTool } from "./tools/extract-document.js";
import { FactsTool } from "./tools/facts.js";
import type { Tool } from "./tools/interface.js";
import { LoadSkillTool } from "./tools/load-skill.js";
import { MdToPdfTool } from "./tools/md-to-pdf.js";
import { MemoryTool } from "./tools/memory.js";
import { ProjectsTool } from "./tools/projects.js";
import { ReadTool } from "./tools/read.js";
import { RecallTool } from "./tools/recall.js";
import { ResourceAdminTool } from "./tools/resource-admin.js";
import { RunWorkflowTool } from "./tools/run-workflow.js";
import { TaskStatusTool } from "./tools/task-status.js";
import { TaskQueryTool, TasksTool } from "./tools/tasks.js";
import { runToolFactories } from "./tools/tool-factories.js";
import { WebFetchTool } from "./tools/web-fetch.js";
import { WebSearchTool } from "./tools/web-search.js";
import { WriteTool } from "./tools/write.js";
// Side-effect import: registers built-in optional tool factories
// (browser_mediator, trusted_actions) on module load.
import "./tools/builtin-optional.js";
import type { AgentRuntime } from "./runtime.js";

export interface CreateToolsOptions {
  getDiscord?: () => any;
  getOwnerId?: () => string | undefined;
  db?: import("better-sqlite3").Database;
  /** Override the task backend. Defaults to `createTaskBackend(config, db)` when `db` is provided. */
  taskBackend?: TaskBackend;
  /** Resolve the task backend per project at call time. When set, takes
   *  precedence over `taskBackend` and enables per-project routing
   *  (different repos / DBs for different projects). The runtime wires
   *  this so a single agent invocation can file tasks across multiple
   *  project-scoped trackers. */
  taskBackendResolver?: import("./tools/tasks.js").TaskBackendResolver;
  /** Optional embedding provider getter for semantic recall. */
  getEmbedder?: () => EmbeddingProvider | undefined;
  /** Memory backend accessor — when wired, the RecallTool's `query`
   *  action routes through `backend.query` instead of calling SQLite
   *  directly. Phase 2 wiring; Phase 3 will route the other actions too. */
  getMemoryBackend?: () => Promise<import("./memory/interface.js").MemoryBackend>;
  /** Notify hook fired after a successful task mutation. Wires the tasks
   *  tool to the task watcher so coder→reviewer handoffs re-trigger routing
   *  (docs/agent-unification.md, Phase 6). */
  notifyTaskEvent?: import("./tools/tasks.js").TasksToolNotify;
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
  const globalDir = resolve(contextDir, "global");
  const tools: Tool[] = [];
  if (config.tools.memory?.enabled !== false) {
    tools.push(new MemoryTool(globalDir));
  }
  if (config.tools.exec?.enabled !== false) {
    // Scratch lives under the configured TAI home so a per-user override or
    // a sandbox-injected $TAI_HOME picks it up. Falls back to ~/.tai inside
    // ExecTool when neither is set. (#60)
    const scratchDir = process.env.TAI_HOME ? resolve(process.env.TAI_HOME, "exec-outputs") : undefined;
    tools.push(new ExecTool(config.tools.exec?.allowedCommands, undefined, scratchDir));
  }
  if (config.tools.read?.enabled !== false) {
    tools.push(new ReadTool(config.tools.read?.allowedPaths));
  }
  if (config.tools.write?.enabled !== false) {
    tools.push(new WriteTool(config.tools.write?.allowedPaths));
  }
  if (config.tools.web_fetch?.enabled !== false) {
    tools.push(new WebFetchTool(undefined, createEgressPolicy(config.security?.egress)));
  }
  if (config.tools.web_search?.enabled) {
    if (config.tools.web_search.apiKey) {
      tools.push(new WebSearchTool(config.tools.web_search.apiKey, config.tools.web_search.maxResults));
    } else {
      console.warn(
        "[factories] tools.web_search.enabled is true but apiKey is empty (likely an unresolved ${ENV_VAR}); tool will not be registered.",
      );
    }
  }
  if (config.tools.facts?.enabled !== false && opts?.db) {
    tools.push(new FactsTool(opts.db, { getMemoryBackend: opts.getMemoryBackend }));
  }
  if (config.tools.recall?.enabled !== false && opts?.db) {
    tools.push(
      new RecallTool(opts.db, {
        defaultTtlDays: config.tools.recall?.defaultTtlDays,
        getEmbedder: opts.getEmbedder,
        embedModel: config.memory?.embeddings?.model,
        getMemoryBackend: opts.getMemoryBackend,
      }),
    );
  }
  // NOTE: CoreMemoryTool is registered as a META tool in createMetaTools(),
  // not as a regular tool here. Identity maintenance is foundational —
  // every named agent gets it regardless of its `tools:` allowlist.
  if (config.tools.tasks?.enabled !== false) {
    // Prefer the runtime-supplied resolver when present (multi-project
    // routing). Fall back to a single backend for plain callers + tests.
    const resolver = opts?.taskBackendResolver;
    const backend = opts?.taskBackend ?? (opts?.db ? createTaskBackend(config, opts.db) : undefined);
    if (resolver) {
      tools.push(new TasksTool(resolver, opts?.db, opts?.notifyTaskEvent), new TaskQueryTool(resolver));
    } else if (backend) {
      tools.push(new TasksTool(backend, opts?.db, opts?.notifyTaskEvent), new TaskQueryTool(backend));
    }
  }
  if (config.tools.discord_dm?.enabled) {
    if (opts?.getDiscord) {
      tools.push(new DiscordDmTool(opts.getDiscord, opts.getOwnerId ?? (() => undefined)));
    } else {
      console.warn(
        "[factories] tools.discord_dm.enabled is true but no Discord accessor was wired by the host; tool will not be registered.",
      );
    }
  }
  if (config.tools.claude_code?.enabled) {
    tools.push(new ClaudeCodeTool(config.tools.claude_code));
  }
  if (config.tools.browser?.enabled) {
    tools.push(new BrowserTool(config.tools.browser));
  }
  if (config.tools.md_to_pdf?.enabled) {
    tools.push(new MdToPdfTool());
  }
  if (config.tools.projects?.enabled !== false && opts?.db) {
    tools.push(new ProjectsTool(opts.db));
  }
  if (config.tools.documents?.enabled !== false && opts?.db) {
    const dir = resolve(config.tools.projects?.directory ?? "./data/projects");
    tools.push(new DocumentsTool(opts.db, dir));
  }
  if (config.tools.extract_document?.enabled) {
    const dir = resolve(config.tools.projects?.directory ?? "./data/projects");
    tools.push(new ExtractDocumentTool({ db: opts?.db, projectsDir: dir }));
  }
  if (config.tools.ask_user?.enabled !== false) {
    tools.push(
      new AskUserTool({
        contextDir,
        getDiscord: opts?.getDiscord ?? (() => undefined),
        getOwnerId: opts?.getOwnerId ?? (() => undefined),
      }),
    );
  }
  if (config.custom_tools) {
    tools.push(...createCustomTools(config.custom_tools));
  }
  // Tool-factory registry: built-in optional tools (browser_mediator,
  // trusted_actions, gmail, google_calendar, google_drive) register here on
  // import; external plugins do the same.
  tools.push(...runToolFactories(config, { db: opts?.db, configPath }));
  return tools;
}

export function createProvider(config: AgentConfig): { provider: AIProvider; model: string } {
  const id = config.agent.defaultProvider;
  const factory = providerFactoryRegistry.get(id);
  if (!factory) {
    const known = providerFactoryRegistry.list().join(", ") || "(none)";
    throw new Error(
      `No provider factory registered for "${id}". Known: ${known}. Register a custom factory with registerProviderFactory().`,
    );
  }
  return factory(config);
}

export function createMetaTools(runtime: AgentRuntime, contextDir: string, kbDir: string): Tool[] {
  const delegateTool = new DelegateTool({
    getConfig: () => runtime.getConfig(),
    db: runtime.db,
    getProvider: () => runtime.getProvider(),
    getTools: () => runtime.getTools(),
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
