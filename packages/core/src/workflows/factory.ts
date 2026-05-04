import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { AgentRuntime } from "../runtime.js";
import { WorkflowEngine } from "./engine.js";
import { AgentRunExecutor } from "./executors/agent-run.js";
import { LoopExecutor } from "./executors/loop.js";
import { ParallelExecutor } from "./executors/parallel.js";
import { ShellExecutor } from "./executors/shell.js";
import { ToolCallExecutor } from "./executors/tool-call.js";
import { FileLogStore } from "./logs.js";

/**
 * Build a WorkflowEngine pre-wired with the standard executors and
 * concurrency caps from the runtime's config. Returns the engine; the
 * caller is responsible for retaining a reference.
 */
export function createWorkflowEngine(opts: {
  runtime: AgentRuntime;
  db: Database.Database;
}): WorkflowEngine {
  const { runtime, db } = opts;
  const cfg = runtime.getConfig();
  const wfCfg = cfg.workflows ?? {};
  const byAgent = wfCfg.maxConcurrentByAgent ?? {};
  const defaultCap = byAgent._default ?? 2;
  const agentConcurrency = (name: string): number => byAgent[name] ?? defaultCap;

  const engine = new WorkflowEngine({
    db,
    registry: runtime.getWorkflows(),
    maxConcurrent: wfCfg.maxConcurrent ?? 4,
    agentConcurrency,
    executors: [
      new AgentRunExecutor({ runtime, db }),
      new ToolCallExecutor({
        getTools: () => runtime.getTools(),
        workingDirectory: process.cwd(),
        env: process.env as Record<string, string>,
      }),
      new ShellExecutor({ cwd: process.cwd() }),
      new LoopExecutor(),
      new ParallelExecutor(),
    ],
  });

  // Attach on-disk logging + apply retention sweep on startup.
  const logDir = resolve(process.cwd(), "data/workflow-runs");
  const store = new FileLogStore(logDir);
  store.attach(engine);
  const retain = wfCfg.retainRuns ?? 100;
  try {
    store.pruneOldRuns(db, retain);
  } catch (err) {
    console.warn(`[workflows] retention sweep failed: ${(err as Error).message}`);
  }

  return engine;
}
