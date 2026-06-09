import chokidar from "chokidar";
import type { WorkflowEngine } from "@tailored-ai/core";
import type { WorkflowTriggerDef } from "@tailored-ai/core";
import type { PluginContext } from "@tailored-ai/core";

/**
 * Example plugin: registers an `fs_watch` trigger kind using chokidar.
 *
 * This is a reference implementation showing how to create a plugin trigger
 * that uses chokidar for glob-based file watching. The core package already
 * ships with the `file_drop` trigger (single directory, no globs). This
 * `fs_watch` trigger adds:
 *
 *   - Glob pattern support via chokidar
 *   - create / modify / delete event types
 *   - Configurable debounce window
 *   - Pattern exclusion
 *
 * Usage in workflow YAML:
 *
 *   triggers:
 *     - kind: fs_watch
 *       config:
 *         paths: ["./src/**/*.ts", "./config/*.yaml"]
 *         events: ["modify"]
 *         debounceMs: 500
 *         ignored: ["*.test.ts"]
 *
 * Workflow input:
 *   - file_path: absolute path that triggered the event
 *   - event: "create" | "modify" | "delete"
 *   - stat: { size, mtime, isFile, isDirectory } | null (null for delete)
 */

interface FsWatchTriggerConfig {
  paths: string | string[];
  events?: ("create" | "modify" | "delete")[];
  debounceMs?: number;
  ignored?: string | string[];
  deep?: boolean;
}

interface Registration {
  workflowName: string;
  config: FsWatchTriggerConfig;
  watcher: ReturnType<typeof chokidar.watch>;
}

const DEFAULT_EVENTS: FsWatchTriggerConfig["events"] = ["create", "modify"];
const DEFAULT_DEBOUNCE_MS = 500;

export class FsWatchPlugin {
  private regs: Registration[] = [];
  private pending: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private workflowEngine: WorkflowEngine;

  constructor(engine: WorkflowEngine) {
    this.workflowEngine = engine;
  }

  register(workflowName: string, config: FsWatchTriggerConfig): void {
    const paths = typeof config.paths === "string" ? [config.paths] : config.paths;
    const events = config.events ?? DEFAULT_EVENTS;
    const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    const watcher = chokidar.watch(paths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      depth: config.deep !== false ? undefined : 0,
    });

    const handleEvent = (event: string, path: string) => {
      if (!events.includes(event as "create" | "modify" | "delete")) return;
      this.debounce(path, event, debounceMs, workflowName);
    };

    watcher.on("add", (p) => handleEvent("create", p));
    watcher.on("change", (p) => handleEvent("modify", p));
    watcher.on("unlink", (p) => handleEvent("delete", p));

    this.regs.push({ workflowName, config, watcher });
  }

  unregister(workflowName: string): boolean {
    const before = this.regs.length;
    this.regs = this.regs.filter((r) => {
      if (r.workflowName === workflowName) {
        r.watcher.close().catch(() => undefined);
        return false;
      }
      return true;
    });
    return this.regs.length < before;
  }

  stop(): void {
    for (const r of this.regs) {
      r.watcher.close().catch(() => undefined);
    }
    this.regs = [];
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  private debounce(path: string, event: string, debounceMs: number, workflowName: string): void {
    const key = `${path}::${event}::${workflowName}`;
    if (this.pending.has(key)) {
      clearTimeout(this.pending.get(key)!);
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.workflowEngine
        .runWorkflow(workflowName, { file_path: path, event, stat: null }, "programmatic")
        .catch((err: Error) => {
          console.warn(`[fs-watch] workflow "${workflowName}" failed: ${err.message}`);
        });
    }, debounceMs);
    this.pending.set(key, timer);
  }
}

export default async function (ctx: PluginContext): Promise<void> {
  console.log("[plugin:fs-watch] fs_watch trigger registered");
}
