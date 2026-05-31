import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { listWorkflowRuns } from "../db/workflow-queries.js";
import type { EngineEvent, WorkflowEngine } from "./engine.js";

const SAFE_NAME_RE = /[^a-zA-Z0-9._-]/g;

function safeName(name: string): string {
  return name.replace(SAFE_NAME_RE, "_");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * On-disk log store for workflow step output. One directory per run
 * (`<baseDir>/<runId>/`), one file per step (`<step-name>.log`). When
 * attached to a WorkflowEngine, the store subscribes to engine events
 * and appends summaries on every step.started/.completed/.failed
 * transition. Step executors can also append directly via
 * appendStep(runId, stepName, text) for stdout/stderr capture.
 */
export class FileLogStore {
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  runDir(runId: string): string {
    return join(this.baseDir, runId);
  }

  stepLogPath(runId: string, stepName: string): string {
    return join(this.runDir(runId), `${safeName(stepName)}.log`);
  }

  beginRun(runId: string): void {
    mkdirSync(this.runDir(runId), { recursive: true });
  }

  appendStep(runId: string, stepName: string, text: string): void {
    if (!text) return;
    mkdirSync(this.runDir(runId), { recursive: true });
    appendFileSync(this.stepLogPath(runId, stepName), text);
  }

  /** Subscribe to engine events and write per-step summaries. */
  attach(engine: WorkflowEngine): () => void {
    return engine.onEvent((event: EngineEvent) => {
      switch (event.type) {
        case "run.started":
          this.beginRun(event.runId);
          this.appendStep(event.runId, "_run", `[start] workflow=${event.workflowName}\n`);
          break;
        case "run.completed":
          this.appendStep(event.runId, "_run", `[completed] ${stringify(event.output)}\n`);
          break;
        case "run.failed":
          this.appendStep(event.runId, "_run", `[failed] ${event.error}\n`);
          break;
        case "run.cancelled":
          this.appendStep(event.runId, "_run", `[cancelled]\n`);
          break;
        case "step.started":
          this.appendStep(event.runId, event.stepName, `[start] ${event.stepType} attempt ${event.attempt}\n`);
          break;
        case "step.completed":
          this.appendStep(event.runId, event.stepName, `[done] ${stringify(event.output)}\n`);
          break;
        case "step.failed":
          this.appendStep(event.runId, event.stepName, `[failed] ${event.error}\n`);
          break;
        case "step.skipped":
          this.appendStep(event.runId, event.stepName, `[skipped]\n`);
          break;
      }
    });
  }

  /**
   * Prune log directories for runs beyond the retain-per-workflow window.
   * Run rows in the DB are preserved — only on-disk log files go away.
   * Returns the number of run directories deleted.
   */
  pruneOldRuns(db: Database.Database, retainPerWorkflow: number): number {
    if (retainPerWorkflow < 0) return 0;
    if (!existsSync(this.baseDir)) return 0;

    // Collect runIds grouped by workflow, newest-first.
    const byWorkflow = new Map<string, string[]>();
    const allRuns = listWorkflowRuns(db, { limit: 100_000 });
    for (const r of allRuns) {
      let list = byWorkflow.get(r.workflow_name);
      if (!list) {
        list = [];
        byWorkflow.set(r.workflow_name, list);
      }
      list.push(r.id);
    }

    const keep = new Set<string>();
    for (const ids of byWorkflow.values()) {
      // listWorkflowRuns orders by started_at DESC, so the first N are newest.
      for (const id of ids.slice(0, retainPerWorkflow)) keep.add(id);
    }

    let deleted = 0;
    for (const entry of readdirSync(this.baseDir)) {
      const full = join(this.baseDir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!entry.startsWith("wfrun_")) continue;
      if (keep.has(entry)) continue;
      try {
        rmSync(full, { recursive: true, force: true });
        deleted++;
      } catch {
        /* best-effort */
      }
    }
    return deleted;
  }
}
