import { type FSWatcher, statSync, watch } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { EMPTY_HOOKS, mergeHooks, type ResolvedHooks } from "./agent/hooks.js";
import type { AgentLoopOptions } from "./agent/loop.js";
import { resolveAgent } from "./agent/agents.js";
import type { Session } from "./agent/session.js";
import type { AgentConfig, AgentHook } from "./config.js";
import type { AIProvider } from "./providers/interface.js";
import type { Tool } from "./tools/interface.js";

export interface RuntimeOptions {
  configPath: string;
  db: Database.Database;
  contextDir: string;
  kbDir: string;
  createTools: (config: AgentConfig, contextDir: string, configPath?: string, opts?: { db?: Database.Database; getDiscord?: () => any; getOwnerId?: () => string | undefined }) => Tool[];
  createProvider: (config: AgentConfig) => { provider: AIProvider; model: string };
}

export class AgentRuntime {
  readonly configPath: string;
  readonly db: Database.Database;
  readonly contextDir: string;
  readonly kbDir: string;

  private _config: AgentConfig;
  private _tools: Tool[];
  private _provider: AIProvider;
  private _model: string;
  private _generation = 0;
  private _watcher: FSWatcher | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _shutdownController = new AbortController();

  private _reloadListeners: Array<() => void> = [];
  private _configLock: Promise<void> = Promise.resolve();
  private _metaTools: Tool[] = [];
  private _createTools: RuntimeOptions["createTools"];
  private _createProvider: RuntimeOptions["createProvider"];
  private _loadConfig: (path: string) => AgentConfig;

  constructor(opts: RuntimeOptions, loadConfig: (path: string) => AgentConfig, initialConfig: AgentConfig) {
    this.configPath = opts.configPath;
    this.db = opts.db;
    this.contextDir = opts.contextDir;
    this.kbDir = opts.kbDir;
    this._createTools = opts.createTools;
    this._createProvider = opts.createProvider;
    this._loadConfig = loadConfig;

    this._config = initialConfig;
    this._tools = opts.createTools(initialConfig, opts.contextDir, opts.configPath, { db: opts.db });
    const { provider, model } = opts.createProvider(initialConfig);
    this._provider = provider;
    this._model = model;
  }

  getConfig(): AgentConfig {
    return this._config;
  }
  getTools(): Tool[] {
    return this._tools;
  }
  getProvider(): AIProvider {
    return this._provider;
  }
  getModel(): string {
    return this._model;
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

  /** Register meta tools (delegate, task_status, admin) to be included in all loop options. */
  setMetaTools(tools: Tool[]): void {
    this._metaTools = tools;
  }

  reload(): void {
    try {
      const config = this._loadConfig(this.configPath);
      const tools = this._createTools(config, this.contextDir, this.configPath, { db: this.db });
      const { provider, model } = this._createProvider(config);
      // Clean up old tools that have a destroy hook (e.g. browser processes)
      const oldTools = this._tools;
      for (const tool of oldTools) {
        tool.destroy?.().catch((e) => {
          console.error(`[runtime] Error destroying tool "${tool.name}":`, (e as Error).message);
        });
      }
      this._config = config;
      this._tools = tools;
      this._provider = provider;
      this._model = model;
      this._generation++;
      console.log(`[runtime] Reloaded config (generation ${this._generation})`);
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
  }): AgentLoopOptions {
    const agentName = opts.agentName ?? opts.profileName;
    const config = this._config;
    const resolved = resolveAgent(
      agentName,
      config,
      this._tools,
      opts.modelOverride,
      this.contextDir,
      this.kbDir,
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

    return {
      provider: this._provider,
      session: opts.session,
      db: this.db,
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
      permissions: config.permissions,
      getTools: () => {
        const r = resolveAgent(
          agentName,
          this._config,
          this._tools,
          opts.modelOverride,
          this.contextDir,
          this.kbDir,
        );
        return dedup([...r.tools, ...extraTools]);
      },
      getProvider: () => this._provider,
    };
  }
}
