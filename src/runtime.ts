import { readFileSync, watch, type FSWatcher } from 'node:fs';
import type Database from 'better-sqlite3';
import type { AgentConfig } from './config.js';
import type { AIProvider } from './providers/interface.js';
import type { Tool } from './tools/interface.js';

export interface RuntimeOptions {
  configPath: string;
  db: Database.Database;
  contextDir: string;
  createTools: (config: AgentConfig, contextDir: string) => Tool[];
  createProvider: (config: AgentConfig) => { provider: AIProvider; model: string };
}

export class AgentRuntime {
  readonly configPath: string;
  readonly db: Database.Database;
  readonly contextDir: string;

  private _config: AgentConfig;
  private _tools: Tool[];
  private _provider: AIProvider;
  private _model: string;
  private _generation = 0;
  private _watcher: FSWatcher | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  private _reloadListeners: Array<() => void> = [];
  private _configLock: Promise<void> = Promise.resolve();
  private _createTools: RuntimeOptions['createTools'];
  private _createProvider: RuntimeOptions['createProvider'];
  private _loadConfig: (path: string) => AgentConfig;

  constructor(
    opts: RuntimeOptions,
    loadConfig: (path: string) => AgentConfig,
    initialConfig: AgentConfig,
  ) {
    this.configPath = opts.configPath;
    this.db = opts.db;
    this.contextDir = opts.contextDir;
    this._createTools = opts.createTools;
    this._createProvider = opts.createProvider;
    this._loadConfig = loadConfig;

    this._config = initialConfig;
    this._tools = opts.createTools(initialConfig, opts.contextDir);
    const { provider, model } = opts.createProvider(initialConfig);
    this._provider = provider;
    this._model = model;
  }

  getConfig(): AgentConfig { return this._config; }
  getTools(): Tool[] { return this._tools; }
  getProvider(): AIProvider { return this._provider; }
  getModel(): string { return this._model; }
  get generation(): number { return this._generation; }

  reload(): void {
    try {
      const config = this._loadConfig(this.configPath);
      const tools = this._createTools(config, this.contextDir);
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
        try { cb(); } catch (e) {
          console.error('[runtime] Reload listener error:', (e as Error).message);
        }
      }
    } catch (err) {
      console.error(`[runtime] Reload failed, keeping previous state:`, (err as Error).message);
    }
  }

  onReload(cb: () => void): void {
    this._reloadListeners.push(cb);
  }

  startWatching(): void {
    if (this._watcher) return;
    try {
      this._watcher = watch(this.configPath, () => {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this.reload(), 500);
      });
      console.log(`[runtime] Watching ${this.configPath} for changes`);
    } catch {
      console.warn(`[runtime] Could not watch ${this.configPath}`);
    }
  }

  stopWatching(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._watcher?.close();
    this._watcher = undefined;
  }

  /** Serialize config read-modify-write operations to prevent lost writes. */
  withConfigLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this._configLock;
    let resolve: (v: void) => void;
    this._configLock = new Promise<void>((r) => { resolve = r; });
    return prev.then(fn).finally(() => resolve!());
  }
}
