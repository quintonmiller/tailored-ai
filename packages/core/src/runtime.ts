import { type FSWatcher, statSync, watch } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { resolveAgent } from "./agent/agents.js";
import { EMPTY_HOOKS, mergeHooks, type ResolvedHooks } from "./agent/hooks.js";
import type { AgentLoopOptions } from "./agent/loop.js";
import { findOrCreateSession, type Session } from "./agent/session.js";
import type { ApprovalRequest, ApprovalResponse } from "./approval.js";
import { type AgentConfig, type AgentHook, mergeProjectOverlay, validateConfig } from "./config.js";
import { getProject } from "./db/project-queries.js";
import type { MemoryBackend } from "./memory/interface.js";
import { resolveMemoryBackend } from "./memory/registry.js";
import type { ProjectContext, ProjectRef } from "./projects/resolve.js";
import type { AIProvider } from "./providers/interface.js";
import { AgentRegistry } from "./resources/agent.js";
import { migrateConfigAgentsToResources, populateAgentsFromDisk } from "./resources/agent-migration.js";
import { BundleRegistry } from "./resources/bundle.js";
import { KbRegistry, populateBuiltinKbs } from "./resources/kb-registry.js";
import { PromptRegistry } from "./resources/prompt-registry.js";
import { ProviderRegistry } from "./resources/provider-registry.js";
import { SkillRegistry } from "./resources/skill.js";
import { StepExecutorRegistry } from "./resources/step-executor-registry.js";
import { ToolRegistry } from "./resources/tool-registry.js";
import { populateBuiltinTriggers, TriggerKindRegistry } from "./resources/trigger-registry.js";
import { createSandbox } from "./sandboxes/factory.js";
import { globalSandboxRegistry } from "./sandboxes/registry.js";
import { createTaskBackend } from "./tasks/factory.js";
import type { TaskBackend } from "./tasks/interface.js";
import type { Tool } from "./tools/interface.js";
import { resolveWorkflowsDir } from "./workflows/loader.js";
import { WorkflowRegistry } from "./workflows/registry.js";
import type { WorkflowDefinition } from "./workflows/types.js";

export interface RuntimeOptions {
  configPath: string;
  db: Database.Database;
  contextDir: string;
  kbDir: string;
  createTools: (
    config: AgentConfig,
    contextDir: string,
    configPath?: string,
    opts?: {
      db?: Database.Database;
      getDiscord?: () => any;
      getOwnerId?: () => string | undefined;
      taskBackend?: TaskBackend;
      getEmbedder?: () => import("./providers/embedding.js").EmbeddingProvider | undefined;
      getMemoryBackend?: () => Promise<MemoryBackend>;
    },
  ) => Tool[];
  createProvider: (config: AgentConfig) => { provider: AIProvider; model: string };
  /** Optional embedding-provider factory. Returns undefined when embeddings are disabled. */
  createEmbedder?: (config: AgentConfig) => import("./providers/embedding.js").EmbeddingProvider | undefined;
}

export class AgentRuntime {
  readonly configPath: string;
  readonly db: Database.Database;
  readonly contextDir: string;
  readonly kbDir: string;

  private _config: AgentConfig;
  // Tools live in _toolRegistry; getTools() reads from it. No separate array.
  private _provider: AIProvider;
  private _model: string;
  private _taskBackend: TaskBackend;
  /**
   * Lazy memory backend. Constructed on first `getMemoryBackend()` and
   * rebuilt on `reload()` so a config flip swaps the active backend the
   * same way it swaps tools/provider. The promise is reused across
   * concurrent callers so we don't double-construct.
   */
  private _memoryBackend: Promise<MemoryBackend> | undefined;
  private _generation = 0;
  private _watcher: FSWatcher | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _shutdownController = new AbortController();

  private _reloadListeners: Array<() => void> = [];
  private _configLock: Promise<void> = Promise.resolve();
  private _metaTools: Tool[] = [];
  private _createTools: RuntimeOptions["createTools"];
  private _createProvider: RuntimeOptions["createProvider"];
  private _createEmbedder: RuntimeOptions["createEmbedder"];
  private _embedder: import("./providers/embedding.js").EmbeddingProvider | undefined;
  private _loadConfig: (path: string) => AgentConfig;
  private _toolRegistry: ToolRegistry = new ToolRegistry();
  private _providerRegistry: ProviderRegistry = new ProviderRegistry();
  private _skillRegistry: SkillRegistry = new SkillRegistry();
  private _agentRegistry: AgentRegistry = new AgentRegistry();
  private _bundleRegistry: BundleRegistry = new BundleRegistry();
  private _stepExecutorRegistry: StepExecutorRegistry = new StepExecutorRegistry();
  private _kbRegistry: KbRegistry = new KbRegistry();
  private _promptRegistry: PromptRegistry = new PromptRegistry();
  private _triggerRegistry: TriggerKindRegistry = (() => {
    const r = new TriggerKindRegistry();
    populateBuiltinTriggers(r);
    return r;
  })();
  private _workflows: WorkflowRegistry = new WorkflowRegistry();
  private _workflowEngine: import("./workflows/engine.js").WorkflowEngine | undefined;
  private _activeProject: ProjectContext | null = null;

  constructor(
    opts: RuntimeOptions,
    loadConfig: (path: string) => AgentConfig,
    initialConfig: AgentConfig,
    initialProject?: ProjectContext | null,
  ) {
    this.configPath = opts.configPath;
    this.db = opts.db;
    this.contextDir = opts.contextDir;
    this.kbDir = opts.kbDir;
    this._createTools = opts.createTools;
    this._createProvider = opts.createProvider;
    this._createEmbedder = opts.createEmbedder;
    this._loadConfig = loadConfig;
    this._activeProject = initialProject ?? null;

    const merged = mergeProjectOverlay(initialConfig, this._activeProject?.overlay);
    this._config = merged;
    this._taskBackend = createTaskBackend(merged, opts.db);
    this._embedder = opts.createEmbedder?.(merged);
    const builtinTools =
      opts.createTools(merged, opts.contextDir, opts.configPath, {
        db: opts.db,
        taskBackend: this._taskBackend,
        getEmbedder: () => this._embedder,
        getMemoryBackend: () => this.getMemoryBackend(),
      }) ?? [];
    for (const tool of builtinTools) this._toolRegistry.registerBuiltin(tool);
    const { provider, model } = opts.createProvider(merged);
    this._provider = provider;
    this._model = model;
    this._providerRegistry.registerBuiltin({
      id: merged.agent.defaultProvider,
      provider,
      defaultModel: model,
    });
    this._workflows.setDirectory(resolveWorkflowsDir(merged.workflows?.directory));
    this._workflows.setExtraTriggerKinds(() => this._triggerRegistry.list().map((m) => m.kind));
    this._workflows.reloadFromDisk();
    populateBuiltinKbs(this._kbRegistry, this.kbDir);

    // S11.4: agents-as-resources migration. Exports any config.yaml agents to
    // data/authored-resources/agent/<id>/manifest.yaml on first run, then
    // populates the AgentRegistry from disk. config.yaml agents still resolve
    // through the legacy fallback in resolveAgent for back-compat.
    try {
      const { migrated, resynced } = migrateConfigAgentsToResources(merged, this.contextDir);
      if (migrated.length > 0) {
        console.log(
          `[agents] migrated ${migrated.length} agent(s) from config.yaml to authored-resources: ${migrated.join(", ")}`,
        );
      }
      if (resynced.length > 0) {
        console.log(
          `[agents] resynced ${resynced.length} agent manifest(s) from config.yaml (drift detected): ${resynced.join(", ")}`,
        );
      }
      populateAgentsFromDisk(this._agentRegistry, this.contextDir);
    } catch (err) {
      console.warn(`[agents] migration step failed: ${(err as Error).message}`);
    }
  }

  getWorkflows(): WorkflowRegistry {
    return this._workflows;
  }

  registerWorkflow(workflow: WorkflowDefinition): void {
    this._workflows.register(workflow);
  }

  setWorkflowEngine(engine: import("./workflows/engine.js").WorkflowEngine | undefined): void {
    this._workflowEngine = engine;
  }

  getWorkflowEngine(): import("./workflows/engine.js").WorkflowEngine | undefined {
    return this._workflowEngine;
  }

  getConfig(): AgentConfig {
    return this._config;
  }
  getTools(): Tool[] {
    // Source of truth is the tool registry. Built-ins register through
    // createTools → registerBuiltin; plugins call registerBuiltin directly.
    // Same code path for both.
    return this._toolRegistry.list();
  }
  getProvider(): AIProvider {
    return this._provider;
  }
  getModel(): string {
    return this._model;
  }
  getTaskBackend(): TaskBackend {
    return this._taskBackend;
  }
  /**
   * Resolve the configured memory backend (default "builtin" SQLite).
   * Lazy — first caller pays the construction cost; subsequent callers
   * get the cached promise. The backend is rebuilt on `reload()`.
   * Throws when the configured provider id has no registered factory.
   */
  getMemoryBackend(): Promise<MemoryBackend> {
    if (!this._memoryBackend) {
      this._memoryBackend = resolveMemoryBackend(this);
    }
    return this._memoryBackend;
  }
  /** Returns the configured embedding provider, or undefined when embeddings are disabled. */
  getEmbedder(): import("./providers/embedding.js").EmbeddingProvider | undefined {
    return this._embedder;
  }
  /** Expose the underlying tool resource registry for skills, agent-authored tools, and inspection. */
  getToolRegistry(): ToolRegistry {
    return this._toolRegistry;
  }
  /** Expose the provider resource registry. Multiple providers can be registered for switching. */
  getProviderRegistry(): ProviderRegistry {
    return this._providerRegistry;
  }
  /** Expose the skill registry. Agents can layer skills via `agents.<name>.skills: [...]`. */
  getSkillRegistry(): SkillRegistry {
    return this._skillRegistry;
  }
  /** Expose the agent registry. As of S11.4 agents are first-class resources, parallel to skills/tools/etc. */
  getAgentRegistry(): AgentRegistry {
    return this._agentRegistry;
  }
  /** Expose the bundle registry. Bundles are curated collections; their members are opt-in. */
  getBundleRegistry(): BundleRegistry {
    return this._bundleRegistry;
  }
  /** Expose the workflow step-executor registry — surfaces both built-ins and any agent-authored ones. */
  getStepExecutorRegistry(): StepExecutorRegistry {
    return this._stepExecutorRegistry;
  }
  /** Expose the trigger-kind catalog (built-ins + community/agent-authored). */
  getTriggerRegistry(): TriggerKindRegistry {
    return this._triggerRegistry;
  }
  /** Knowledge-base resource registry. */
  getKbRegistry(): KbRegistry {
    return this._kbRegistry;
  }
  /** Prompt resource registry. */
  getPromptRegistry(): PromptRegistry {
    return this._promptRegistry;
  }
  get generation(): number {
    return this._generation;
  }
  get shutdownSignal(): AbortSignal {
    return this._shutdownController.signal;
  }

  /** Signal all in-flight agent loops to stop gracefully. */
  initiateShutdown(): void {
    this._shutdownController.abort();
  }

  /** The project whose `.tai.yaml` overlay is merged into the active config (or null in global mode). */
  getActiveProject(): ProjectContext | null {
    return this._activeProject;
  }

  /**
   * Switch the active project. Triggers a `reload()` so the new overlay (or its
   * removal, when set to null) takes effect immediately. Subsystems that hold
   * a runtime reference will see the new config on their next read.
   */
  setActiveProject(project: ProjectContext | null): void {
    this._activeProject = project;
    this.reload();
  }

  /**
   * Look up a registered project by id. Returns the routing-time
   * {@link ProjectRef} (id/name/path) — channels and other routing call
   * sites use this so they don't have to import db query helpers or reach
   * into `runtime.db` directly.
   *
   * See [#38](https://github.com/quintonmiller/tailored-ai/issues/38).
   */
  getProjectByName(id: string): ProjectRef | undefined {
    const row = getProject(this.db, id);
    if (!row?.path) return undefined;
    return { id: row.id, name: row.title, path: row.path };
  }

  /**
   * Find or create a session keyed by `key`, using the runtime's current
   * model + default provider. Convenience accessor so channels and other
   * consumers don't import {@link findOrCreateSession} and pass
   * `runtime.db` by hand.
   *
   * See [#38](https://github.com/quintonmiller/tailored-ai/issues/38).
   */
  findOrCreateSession(opts: { key: string; project?: ProjectRef | null }): Session {
    return findOrCreateSession(
      this.db,
      opts.key,
      this._model,
      this._config.agent.defaultProvider,
      opts.project?.id ?? null,
    );
  }

  /** Register meta tools (delegate, task_status, admin) to be included in all loop options. */
  setMetaTools(tools: Tool[]): void {
    this._metaTools = tools;
  }

  /** Read the registered meta tools. Used by the exploratory worker so the
   * `online.tools` allowlist doesn't accidentally strip orchestration tools. */
  getMetaTools(): Tool[] {
    return this._metaTools;
  }

  reload(): void {
    try {
      const baseConfig = this._loadConfig(this.configPath);
      const config = mergeProjectOverlay(baseConfig, this._activeProject?.overlay);

      // Project-scoped validation: emit overlay warnings with a project prefix so
      // the user can tell which file introduced a dangling tool/agent reference.
      if (this._activeProject?.overlay && Object.keys(this._activeProject.overlay).length > 0) {
        const baseWarnings = new Set(validateConfig(baseConfig));
        for (const w of validateConfig(config)) {
          if (!baseWarnings.has(w)) {
            console.warn(`[project:${this._activeProject.id}] Warning: ${w}`);
          }
        }
      }

      const taskBackend = createTaskBackend(config, this.db);
      const embedder = this._createEmbedder?.(config);
      const tools =
        this._createTools(config, this.contextDir, this.configPath, {
          db: this.db,
          taskBackend,
          getEmbedder: () => embedder,
          getMemoryBackend: () => this.getMemoryBackend(),
        }) ?? [];
      const { provider, model } = this._createProvider(config);
      // Clean up old tools that have a destroy hook (e.g. browser processes).
      // destroyAll() runs in parallel and swallows individual errors so one
      // bad tool can't block reload.
      const oldRegistry = this._toolRegistry;
      oldRegistry.destroyAll().catch((e) => {
        console.error("[runtime] destroyAll failed:", (e as Error).message);
      });
      const newToolRegistry = new ToolRegistry();
      for (const tool of tools) newToolRegistry.registerBuiltin(tool);
      const newProviderRegistry = new ProviderRegistry();
      newProviderRegistry.registerBuiltin({
        id: config.agent.defaultProvider,
        provider,
        defaultModel: model,
      });
      this._config = config;
      this._toolRegistry = newToolRegistry;
      this._providerRegistry = newProviderRegistry;
      this._taskBackend = taskBackend;
      this._embedder = embedder;
      // Drop the cached memory backend so the next getMemoryBackend() call
      // re-resolves against the new config. A pending close() on the old
      // backend runs in the background.
      const previous = this._memoryBackend;
      this._memoryBackend = undefined;
      previous
        ?.then((b) => b.close?.())
        ?.catch((e) => console.error("[runtime] memory backend close failed:", (e as Error).message));
      this._provider = provider;
      this._model = model;
      this._generation++;
      this._workflows.setDirectory(resolveWorkflowsDir(config.workflows?.directory));
      this._workflows.reloadFromDisk();
      const projectTag = this._activeProject ? ` [project:${this._activeProject.id}]` : "";
      console.log(`[runtime] Reloaded config (generation ${this._generation})${projectTag}`);
      for (const cb of this._reloadListeners) {
        try {
          cb();
        } catch (e) {
          console.error("[runtime] Reload listener error:", (e as Error).message);
        }
      }
    } catch (err) {
      console.error(`[runtime] Reload failed, keeping previous state:`, (err as Error).message);
    }
  }

  onReload(cb: () => void): void {
    this._reloadListeners.push(cb);
  }

  private _pollTimer: ReturnType<typeof setInterval> | undefined;
  private _lastMtimeMs = 0;

  startWatching(): void {
    if (this._watcher || this._pollTimer) return;
    try {
      this._watcher = watch(this.configPath, () => {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this.reload(), 500);
      });
      // Verify the watcher actually fires by keeping it — if it errors, fallback below
      this._watcher.on("error", () => {
        console.warn("[runtime] fs.watch failed, falling back to polling");
        this._watcher?.close();
        this._watcher = undefined;
        this._startPolling();
      });
      console.log(`[runtime] Watching ${this.configPath} for changes`);
    } catch {
      console.warn(`[runtime] Could not watch ${this.configPath}, using polling fallback`);
      this._startPolling();
    }
  }

  private _startPolling(): void {
    if (this._pollTimer) return;
    try {
      this._lastMtimeMs = statSync(this.configPath).mtimeMs;
    } catch {
      /* ignore */
    }
    this._pollTimer = setInterval(() => {
      try {
        const mtime = statSync(this.configPath).mtimeMs;
        if (mtime > this._lastMtimeMs) {
          this._lastMtimeMs = mtime;
          this.reload();
        }
      } catch {
        /* file may be temporarily unavailable */
      }
    }, 2000);
    console.log(`[runtime] Polling ${this.configPath} for changes (2s interval)`);
  }

  stopWatching(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._watcher?.close();
    this._watcher = undefined;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
    this._workflows.stopWatching();
  }

  startWatchingWorkflows(): void {
    this._workflows.startWatching();
  }

  /** Serialize config read-modify-write operations to prevent lost writes. */
  withConfigLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this._configLock;
    let resolve: (v: undefined) => void;
    this._configLock = new Promise<void>((r) => {
      resolve = r;
    });
    return prev.then(fn).finally(() => resolve!(undefined));
  }

  /**
   * Resolve hooks for a given agent + optional overrides (e.g. cron job hooks).
   * Agent hooks run first, override hooks are appended.
   */
  resolveHooks(opts: {
    agentName?: string;
    /** @deprecated Use agentName instead. */
    profileName?: string;
    overrideHooks?: { beforeRun?: AgentHook | AgentHook[]; afterRun?: AgentHook | AgentHook[] };
  }): ResolvedHooks {
    const name = opts.agentName ?? opts.profileName;
    const agentHooks = name ? this._config.agents[name]?.hooks : undefined;
    if (!agentHooks && !opts.overrideHooks) return EMPTY_HOOKS;
    return mergeHooks(agentHooks, opts.overrideHooks);
  }

  /**
   * Default observer callbacks for {@link runAgentLoop} that log tool calls
   * and approval transitions through `console.log`. Every first-party channel
   * (Discord, Slack) used to hand-roll these identical handlers; spread the
   * return value onto your `runAgentLoop` opts instead so a future format
   * change happens in one place.
   *
   *     const response = await runAgentLoop(content, {
   *       ...loopOpts,
   *       ...runtime.defaultLoopObservers({ prefix: `[slack] [${user}]` }),
   *     });
   *
   * Pass `prefix` to scope log lines to your channel/user. Defaults to `[tai]`.
   */
  defaultLoopObservers(opts: { prefix?: string } = {}): {
    onToolCall: (name: string, args: Record<string, unknown>) => void;
    onApprovalRequest: (req: ApprovalRequest) => void;
    onApprovalResponse: (req: ApprovalRequest, res: ApprovalResponse) => void;
  } {
    const prefix = opts.prefix ?? "[tai]";
    return {
      onToolCall: (name, args) => {
        // Truncate args so a noisy `write_file` doesn't dump kilobytes of code.
        const argsStr = JSON.stringify(args);
        const trimmed = argsStr.length > 200 ? `${argsStr.slice(0, 200)}…` : argsStr;
        console.log(`${prefix} tool: ${name}(${trimmed})`);
      },
      onApprovalRequest: (req) => {
        console.log(`${prefix} approval requested: ${req.description}`);
      },
      onApprovalResponse: (req, res) => {
        console.log(
          `${prefix} approval ${res.approved ? "granted" : "denied"}: ${req.toolName} (${res.responseTimeMs}ms)`,
        );
      },
    };
  }

  /**
   * Build a session key in the format every first-party channel + downstream
   * consumer uses. Encoded as either
   *
   *     <channelId>:<userId>
   *     <channelId>:<projectId>:<userId>
   *
   * so that the same user in two different projects gets isolated history,
   * and `<channelId>:<userId>` continues to mean "global / no project".
   *
   * Channels used to hand-roll this string; now they call this helper so the
   * format lives in one place and stays consistent across transports. Pair
   * with {@link parseSessionKey} when downstream code needs to extract the
   * pieces (currently autopilot / task-watcher prefix-match on raw strings).
   *
   * Throws on inputs containing `:` since the delimiter would corrupt parse.
   * See [#39](https://github.com/quintonmiller/tailored-ai/issues/39).
   */
  makeSessionKey(opts: { channelId: string; userId: string; project?: ProjectRef | null }): string {
    const { channelId, userId, project } = opts;
    if (!channelId) throw new Error("makeSessionKey: channelId is required");
    if (!userId) throw new Error("makeSessionKey: userId is required");
    if (channelId.includes(":")) throw new Error(`makeSessionKey: channelId cannot contain ':' (got "${channelId}")`);
    if (userId.includes(":")) throw new Error(`makeSessionKey: userId cannot contain ':' (got "${userId}")`);
    if (project) {
      if (project.id.includes(":")) {
        throw new Error(`makeSessionKey: project.id cannot contain ':' (got "${project.id}")`);
      }
      return `${channelId}:${project.id}:${userId}`;
    }
    return `${channelId}:${userId}`;
  }

  /**
   * Inverse of {@link makeSessionKey}. Returns `undefined` for keys that
   * don't match the documented shape — callers should treat that as "this
   * isn't one of ours" rather than throwing, since downstream surfaces
   * (CLI sessions, web sessions, custom integrations) may use freeform
   * session ids.
   */
  parseSessionKey(key: string): { channelId: string; userId: string; projectId?: string } | undefined {
    const parts = key.split(":");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { channelId: parts[0], userId: parts[1] };
    }
    if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
      return { channelId: parts[0], projectId: parts[1], userId: parts[2] };
    }
    return undefined;
  }

  /**
   * Build a standard AgentLoopOptions from the current runtime state.
   * Callers can spread additional fields (onToolCall, onToolResult, etc.) on top.
   */
  buildLoopOptions(opts: {
    session: Session;
    agentName?: string;
    /** @deprecated Use agentName instead. */
    profileName?: string;
    modelOverride?: string;
    extraTools?: Tool[];
    /**
     * Per-call project override. When set, the loop's `cwd` comes from this
     * project rather than the runtime's active project. Accepts either a
     * {@link ProjectRef} (routing only, the common channel case) or a
     * fully-loaded {@link ProjectContext}.
     */
    project?: ProjectRef | ProjectContext | null;
  }): AgentLoopOptions {
    const agentName = opts.agentName ?? opts.profileName;
    const config = this._config;
    const resolveSkill = (id: string) => this._skillRegistry.get(id);
    const describeSkill = (id: string) => {
      const entry = this._skillRegistry.listWithManifests().find((r) => r.manifest.id === id);
      return entry ? { description: entry.manifest.description } : undefined;
    };
    const listSkillIds = () => this._skillRegistry.listWithManifests().map((r) => r.manifest.id);
    const resolveAgentDef = (id: string) => this._agentRegistry.get(id);
    const resolveOpts = { resolveSkill, describeSkill, listSkillIds, resolveAgentDef };
    const resolved = resolveAgent(
      agentName,
      config,
      this.getTools(),
      opts.modelOverride,
      this.contextDir,
      this.kbDir,
      resolveOpts,
    );
    const extraTools = [...this._metaTools, ...(opts.extraTools ?? [])];
    const globalKbDir = resolve(this.kbDir, "global");

    // Deduplicate tools by name (agent tools take priority, extra tools fill gaps)
    const dedup = (tools: Tool[]): Tool[] => {
      const seen = new Set<string>();
      return tools.filter((t) => {
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        return true;
      });
    };

    const agent = agentName ? config.agents?.[agentName] : undefined;
    const sandbox = globalSandboxRegistry.track(createSandbox(config, agent), {
      agentName,
      sessionId: opts.session.id,
    });

    const callProject = opts.project !== undefined ? opts.project : this._activeProject;
    return {
      provider: this._provider,
      session: opts.session,
      db: this.db,
      cwd: callProject?.path,
      tools: dedup([...resolved.tools, ...extraTools]),
      extraInstructions: resolved.instructions,
      maxToolRounds: resolved.maxToolRounds,
      maxHistoryTokens: config.agent.maxHistoryTokens,
      temperature: resolved.temperature,
      contextDir: this.contextDir,
      agentContextDir: resolved.contextDir,
      kbDir: globalKbDir,
      agentKbDir: resolved.kbDir,
      signal: this._shutdownController.signal,
      nudgeOnText: resolved.nudgeOnText,
      nudgeMessage: resolved.nudgeMessage,
      skipGlobalContext: resolved.skipGlobalContext,
      summarizeOnTrim: resolved.summarizeOnTrim,
      injectMemory: resolved.injectMemory,
      memoryInjectBudgetTokens: resolved.memoryInjectBudgetTokens,
      memoryInjectLimit: resolved.memoryInjectLimit,
      getMemoryBackend: () => this.getMemoryBackend(),
      memoryInjectEmbedder: this._embedder,
      budgetWarnings: resolved.budgetWarnings,
      permissions: config.permissions,
      sandbox,
      skillCatalog: resolved.skillCatalog,
      systemPrompt: resolved.systemPrompt,
      // Tool-context agent name (docs/agent-unification.md). Every call to
      // a tool that maintains identity (core_memory, Sleep) needs a stable
      // agent string. When the caller doesn't specify one (anonymous chat
      // via Discord DM, fresh CLI runs), fall back to "default" so tools
      // can still attribute writes — assuming the config has a `default`
      // agent (which is the documented convention). Callers like the
      // exploratory worker can still override by passing their own
      // toolContextExtras — those override fields are spread AFTER this
      // in the loop body (see agent/loop.ts ToolContext construction).
      toolContextExtras: {
        agentName: agentName ?? (config.agents?.default ? "default" : undefined),
      },
      getTools: () => {
        const r = resolveAgent(
          agentName,
          this._config,
          this.getTools(),
          opts.modelOverride,
          this.contextDir,
          this.kbDir,
          resolveOpts,
        );
        return dedup([...r.tools, ...extraTools]);
      },
      getProvider: () => this._provider,
    };
  }
}
