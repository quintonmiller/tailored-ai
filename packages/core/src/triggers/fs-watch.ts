import { existsSync, type Stats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import chokidar, { FSWatcher } from "chokidar";
import type { WorkflowEngine } from "../workflows/engine.js";
import type { WorkflowTriggerDef } from "../workflows/types.js";

/**
 * Watches one or more paths (including glob patterns) and fires a workflow
 * on create / modify / delete events. Uses `chokidar` for recursive glob
 * support and cross-platform reliability.
 *
 * On fire, the workflow's `input` is:
 *   - file_path: absolute path that triggered the event
 *   - event: "create" | "modify" | "delete"
 *   - stat: Stats object (omitted for "delete" events)
 *
 * Multiple workflows can watch overlapping paths — the watcher deduplicates
 * the underlying chokidar instance per unique path+events combo, then fans
 * out to all registered workflows.
 */

export interface FsWatchTriggerConfig {
  /** One or more paths or glob patterns to watch. Resolved against `baseDir` when relative. */
  paths: string | string[];
  /** Which events to react to. Default: ["create", "modify"]. */
  events?: ("create" | "modify" | "delete")[];
  /** Debounce window in ms. Default: 500. */
  debounceMs?: number;
  /** Ignore patterns (glob). Default: excludes `.git/` and `node_modules/`. */
  ignored?: string | string[];
  /** When true, watch only the top-level entries (no recursive glob descent). Default: true. */
  deep?: boolean;
}

export interface FsWatcherOptions {
  workflowEngine: WorkflowEngine;
  /** Resolves trigger paths against this base when they're relative. */
  baseDir?: string;
  /** Override clock for tests. */
  now?: () => number;
}

interface Registration {
  workflowName: string;
  config: FsWatchTriggerConfig;
}

interface PendingEvent {
  path: string;
  event: "create" | "modify" | "delete";
  timer: ReturnType<typeof setTimeout>;
  /** Map workflowName → scheduled flag (true = already scheduled, skip dupe). */
  scheduled: Set<string>;
}

const DEFAULT_EVENTS: Array<"create" | "modify" | "delete"> = ["create", "modify"];
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_IGNORED: string[] = [".git/**", "node_modules/**"];

export class FsWatcher {
  private opts: FsWatcherOptions;
  private registrations: Map<string, Registration> = new Map();
  private watchers: Map<string, FSWatcher> = new Map();
  private pending = new Map<string, PendingEvent>();

  constructor(opts: FsWatcherOptions) {
    this.opts = opts;
  }

  /**
   * Register a workflow's fs_watch trigger. Creates or reuses a chokidar
   * watcher for the resolved paths. Throws if paths cannot be resolved.
   */
  register(workflowName: string, trigger: Extract<WorkflowTriggerDef, { kind: "fs_watch" }>): void {
    this.registrations.set(workflowName, { workflowName, config: trigger.config });
    this.ensureWatcher(trigger.config);
  }

  /** Tear down all watchers. Idempotent. */
  stop(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close().catch(() => undefined);
    }
    this.watchers.clear();
    this.registrations.clear();
    for (const [, pe] of this.pending.entries()) {
      clearTimeout(pe.timer);
    }
    this.pending.clear();
  }

  /**
   * Remove every registration for `workflowName`. Returns true if at least
   * one registration was removed.
   */
  unregister(workflowName: string): boolean {
    const had = this.registrations.delete(workflowName);
    // Clear pending events for this workflow.
    for (const [, pe] of this.pending.entries()) {
      pe.scheduled.delete(workflowName);
      if (pe.scheduled.size === 0) {
        clearTimeout(pe.timer);
        this.pending.delete(pe.path + "::" + pe.event);
      }
    }

    // Rebuild watcher set: only keep watchers that still have registrations.
    const activeConfigs = [...this.registrations.values()].map((r) => r.config);
    const activePaths = new Set<string>();
    for (const cfg of activeConfigs) {
      for (const path of this.resolvePaths(cfg.paths)) {
        activePaths.add(path);
      }
    }

    // Close watchers whose paths are no longer needed.
    for (const [key, watcher] of this.watchers.entries()) {
      if (!activePaths.has(key)) {
        watcher.close().catch(() => undefined);
        this.watchers.delete(key);
      }
    }

    // Ensure watchers for remaining paths (handles re-registration).
    for (const cfg of activeConfigs) {
      this.ensureWatcher(cfg);
    }

    return had;
  }

  /** Number of currently registered triggers (test helper). */
  size(): number {
    return this.registrations.size;
  }

  private resolvePaths(p: string | string[]): string[] {
    const arr = typeof p === "string" ? [p] : p;
    return arr.map((path) => (isAbsolute(path) ? path : resolve(this.opts.baseDir ?? process.cwd(), path)));
  }

  private ensureWatcher(config: FsWatchTriggerConfig): void {
    const resolved = this.resolvePaths(config.paths);
    const events = config.events ?? DEFAULT_EVENTS;
    const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const ignored = config.ignored
      ? typeof config.ignored === "string"
        ? [config.ignored]
        : config.ignored
      : DEFAULT_IGNORED;

    const key = resolved.join("\0");
    if (this.watchers.has(key)) return;

    const watcher = chokidar.watch(resolved, {
      persistent: true,
      ignoreInitial: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      depth: config.deep !== false ? undefined : 0,
      ignored: (path, stats) => {
        if (stats && !stats.isFile()) return false;
        for (const pattern of ignored) {
          if (path.includes(pattern.replace(/\/\*\*$/, "").replace(/\*/g, ""))) return true;
        }
        return false;
      },
    });

    const handleEvent = (event: "create" | "modify" | "delete", path: string) => {
      if (!events.includes(event)) {
        return;
      }
      this.handleEvent(event, path, debounceMs);
    };

    watcher.on("add", (p) => handleEvent("create", p));
    watcher.on("change", (p) => handleEvent("modify", p));
    watcher.on("unlink", (p) => handleEvent("delete", p));

    watcher.on("error", (err) => {
      console.warn(`[fs-watch] watcher error: ${(err as Error).message}`);
    });

    this.watchers.set(key, watcher);
  }

  private handleEvent(event: "create" | "modify" | "delete", path: string, debounceMs: number): void {
    const key = `${path}::${event}`;
    let pending = this.pending.get(key);

    if (!pending) {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this.fireAll(path, event);
      }, debounceMs);
      pending = { path, event, timer, scheduled: new Set() };
      this.pending.set(key, pending);
      return;
    }

    // Extend the timer if this is a new batch.
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.pending.delete(key);
      this.fireAll(path, event);
    }, debounceMs);
  }

  private fireAll(path: string, event: "create" | "delete" | "modify"): void {
    const registrations = [...this.registrations.values()].filter((r) => {
      const resolved = this.resolvePaths(r.config.paths);
      return resolved.some((p) => path.startsWith(p.replace(/\*\*/g, "").replace(/\*/g, "")));
    });

    for (const reg of registrations) {
      const stat = event !== "delete" ? safeStat(path) : null;
      const input = {
        file_path: path,
        event,
        stat: stat
          ? {
              size: stat.size,
              mtime: stat.mtimeMs,
              isFile: stat.isFile(),
              isDirectory: stat.isDirectory(),
            }
          : null,
      };
      this.opts.workflowEngine
        .runWorkflow(reg.workflowName, input, "programmatic")
        .catch((err: Error) => {
          console.warn(`[fs-watch] workflow "${reg.workflowName}" failed for ${path}: ${err.message}`);
        });
    }
  }
}

function safeStat(path: string): Stats | null {
  try {
    if (!existsSync(path)) return null;
    return require("node:fs").statSync(path);
  } catch {
    return null;
  }
}
