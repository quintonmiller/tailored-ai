import { existsSync, type FSWatcher, watch as fsWatch, mkdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { WorkflowEngine } from "../workflows/engine.js";
import type { WorkflowTriggerDef } from "../workflows/types.js";

/**
 * Watches a directory and fires a workflow per newly-stable file. "Stable"
 * means the file's mtime hasn't changed for `stableForMs` — this handles
 * the case where a large file is still being copied in.
 *
 * On fire, the workflow's `input` is:
 *   - file_path: absolute path on disk
 *   - file_name: basename (no directory)
 *   - file_ext:  lowercase extension without the leading dot (e.g. "pdf")
 *
 * Multiple workflows can watch the same directory — the registry keeps them
 * independent and dedupes nothing (intentional; let workflows fan out).
 */

export interface FileDropWatcherOptions {
  workflowEngine: WorkflowEngine;
  /** Resolves trigger paths against this base when they're relative. */
  baseDir?: string;
  /** Override clock for tests. */
  now?: () => number;
  /** Override mtime probe for tests. */
  statFile?: (path: string) => { mtimeMs: number; size: number } | null;
}

interface Registration {
  workflowName: string;
  trigger: Extract<WorkflowTriggerDef, { kind: "file_drop" }>;
  watcher: FSWatcher;
  watchedPath: string;
}

interface PendingFile {
  path: string;
  workflowName: string;
  extensionsFilter: Set<string> | null;
  lastSeenMtime: number;
  stableForMs: number;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_STABLE_MS = 1500;

export class FileDropWatcher {
  private opts: FileDropWatcherOptions;
  private regs: Registration[] = [];
  private pending = new Map<string, PendingFile>();

  constructor(opts: FileDropWatcherOptions) {
    this.opts = opts;
  }

  /**
   * Register a workflow's file_drop trigger. Starts the underlying fs.watch
   * immediately; throws if the directory cannot be opened.
   */
  register(workflowName: string, trigger: Extract<WorkflowTriggerDef, { kind: "file_drop" }>): void {
    const watchedPath = this.resolvePath(trigger.path);
    if (!existsSync(watchedPath)) {
      mkdirSync(watchedPath, { recursive: true });
    }
    const watcher = fsWatch(watchedPath, { persistent: true }, (_eventType, filename) => {
      if (!filename) return;
      this.handleEvent(workflowName, trigger, watchedPath, filename);
    });
    this.regs.push({ workflowName, trigger, watcher, watchedPath });
  }

  /** Tear down all watchers. Idempotent. */
  stop(): void {
    for (const reg of this.regs) {
      try {
        reg.watcher.close();
      } catch {
        /* ignore */
      }
    }
    this.regs = [];
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  /**
   * Remove every registration for `workflowName`. Used by the workflow
   * trigger coordinator when a workflow is deleted or its triggers change
   * across a hot-reload. Returns true if at least one registration was
   * removed.
   */
  unregister(workflowName: string): boolean {
    const before = this.regs.length;
    const keep: Registration[] = [];
    for (const reg of this.regs) {
      if (reg.workflowName === workflowName) {
        try {
          reg.watcher.close();
        } catch {
          /* ignore */
        }
        continue;
      }
      keep.push(reg);
    }
    this.regs = keep;
    // Drop pending debounce timers for the removed workflow too.
    for (const [path, p] of this.pending.entries()) {
      if (p.workflowName === workflowName) {
        clearTimeout(p.timer);
        this.pending.delete(path);
      }
    }
    return this.regs.length < before;
  }

  /** Number of currently registered triggers (test helper). */
  size(): number {
    return this.regs.length;
  }

  private resolvePath(p: string): string {
    if (isAbsolute(p)) return p;
    return resolve(this.opts.baseDir ?? process.cwd(), p);
  }

  private handleEvent(
    workflowName: string,
    trigger: Extract<WorkflowTriggerDef, { kind: "file_drop" }>,
    dir: string,
    filename: string,
  ): void {
    const path = join(dir, filename);
    const stat = this.opts.statFile ? this.opts.statFile(path) : safeStat(path);
    if (!stat) {
      // File was removed before we could read it.
      const key = `${workflowName}::${path}`;
      const pending = this.pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
      }
      return;
    }
    const extensions = parseExtensions(trigger.extensions);
    const ext = extname(path).slice(1).toLowerCase();
    if (extensions && !extensions.has(ext)) return;

    const stableForMs = trigger.stableForMs ?? DEFAULT_STABLE_MS;
    const key = `${workflowName}::${path}`;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.lastSeenMtime = stat.mtimeMs;
      existing.timer = setTimeout(() => this.fire(key), stableForMs);
      return;
    }
    const entry: PendingFile = {
      path,
      workflowName,
      extensionsFilter: extensions,
      lastSeenMtime: stat.mtimeMs,
      stableForMs,
      timer: setTimeout(() => this.fire(key), stableForMs),
    };
    this.pending.set(key, entry);
  }

  private fire(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    const input = {
      file_path: entry.path,
      file_name: basename(entry.path),
      file_ext: extname(entry.path).slice(1).toLowerCase(),
    };
    this.opts.workflowEngine.runWorkflow(entry.workflowName, input, "programmatic").catch((err: Error) => {
      console.warn(`[file_drop] workflow "${entry.workflowName}" failed for ${entry.path}: ${err.message}`);
    });
  }
}

function safeStat(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path);
    if (!s.isFile()) return null;
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function parseExtensions(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const exts = raw
    .split(",")
    .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  return exts.length > 0 ? new Set(exts) : null;
}
