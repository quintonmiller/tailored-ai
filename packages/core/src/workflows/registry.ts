import { type FSWatcher, watch } from "node:fs";
import { loadWorkflowsFromDir } from "./loader.js";
import type { RegisteredWorkflow, WorkflowDefinition } from "./types.js";

/**
 * In-memory registry of workflow definitions. Maintains both file-loaded
 * and programmatically registered workflows. Programmatic registrations
 * survive `reload()` (file-loaded ones are wiped and re-read).
 */
export class WorkflowRegistry {
  private fileWorkflows = new Map<string, RegisteredWorkflow>();
  private programmaticWorkflows = new Map<string, RegisteredWorkflow>();
  private dir: string | undefined;
  private watcher: FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private listeners: Array<() => void> = [];
  private lastErrors: Array<{ path: string; error: string }> = [];

  setDirectory(dir: string | undefined): void {
    this.dir = dir;
  }

  getDirectory(): string | undefined {
    return this.dir;
  }

  /** Reload the file-backed registry. Programmatic workflows are kept. */
  reloadFromDisk(): void {
    if (!this.dir) {
      this.fileWorkflows.clear();
      this.lastErrors = [];
      this.generation++;
      this.notify();
      return;
    }
    const result = loadWorkflowsFromDir(this.dir);
    this.lastErrors = result.errors;
    const next = new Map<string, RegisteredWorkflow>();
    this.generation++;
    for (const wf of result.workflows) {
      next.set(wf.name, {
        definition: wf,
        source: this.dir,
        generation: this.generation,
      });
    }
    this.fileWorkflows = next;
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        console.warn(`[workflows] ${e.path}: ${e.error}`);
      }
    }
    this.notify();
  }

  /**
   * Register or replace a programmatically defined workflow. Programmatic
   * workflows take precedence over file-loaded ones with the same name.
   */
  register(workflow: WorkflowDefinition, source = "programmatic"): void {
    this.generation++;
    this.programmaticWorkflows.set(workflow.name, {
      definition: workflow,
      source,
      generation: this.generation,
    });
    this.notify();
  }

  unregister(name: string): boolean {
    const existed = this.programmaticWorkflows.delete(name);
    if (existed) {
      this.generation++;
      this.notify();
    }
    return existed;
  }

  get(name: string): RegisteredWorkflow | undefined {
    return this.programmaticWorkflows.get(name) ?? this.fileWorkflows.get(name);
  }

  list(): RegisteredWorkflow[] {
    const seen = new Set<string>();
    const all: RegisteredWorkflow[] = [];
    for (const wf of this.programmaticWorkflows.values()) {
      seen.add(wf.definition.name);
      all.push(wf);
    }
    for (const wf of this.fileWorkflows.values()) {
      if (!seen.has(wf.definition.name)) all.push(wf);
    }
    return all.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  getErrors(): Array<{ path: string; error: string }> {
    return [...this.lastErrors];
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  /**
   * Watch the workflows directory for changes. Reloads on any add/change/
   * remove with a 500ms debounce.
   */
  startWatching(): void {
    if (this.watcher || !this.dir) return;
    try {
      this.watcher = watch(this.dir, { recursive: false }, () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.reloadFromDisk(), 500);
      });
      this.watcher.on("error", (err) => {
        console.warn(`[workflows] watcher error: ${(err as Error).message}`);
      });
      console.log(`[workflows] Watching ${this.dir} for changes`);
    } catch (err) {
      console.warn(`[workflows] Could not watch ${this.dir}: ${(err as Error).message}`);
    }
  }

  stopWatching(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (e) {
        console.error(`[workflows] change listener error: ${(e as Error).message}`);
      }
    }
  }
}
