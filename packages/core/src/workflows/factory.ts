import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { AgentRuntime } from "../runtime.js";
import { createSandbox } from "../sandboxes/factory.js";
import type { SandboxKind } from "../sandboxes/interface.js";
import { populateBuiltinExecutors } from "./builtin-executors.js";
import { WorkflowEngine } from "./engine.js";
import { FormExecutor } from "./executors/form.js";
import type { EmailSender } from "./executors/notify.js";
import { FileLogStore } from "./logs.js";

/**
 * Build a WorkflowEngine pre-wired with the standard executors and
 * concurrency caps from the runtime's config. Returns the engine; the
 * caller is responsible for retaining a reference.
 *
 * Built-in executors are registered into the runtime's StepExecutorRegistry
 * via {@link populateBuiltinExecutors} and then instantiated through
 * `registry.buildAll(ctx)`. Plugins that registered factories before this
 * call (via `ctx.stepExecutors.register`) are instantiated in the same pass,
 * so built-ins and plugin executors share one construction path.
 *
 * The only exception is FormExecutor: it depends on the engine's FormRegistry
 * which is only available after construction, so it is still registered via
 * `engine.registerExecutor` post-construction.
 */
export function createWorkflowEngine(opts: {
  runtime: AgentRuntime;
  db: Database.Database;
  /** Returns the active email sender, when one is wired. */
  getEmail?: () => EmailSender | undefined;
  /** Default email recipient list when a notify step doesn't supply `to`. */
  getDefaultEmailRecipients?: () => string[];
}): WorkflowEngine {
  const { runtime, db } = opts;
  // Resolve the outbound sink + owner per-step through the runtime's outbound
  // registry (#66): channel-message / notify / form steps pass their optional
  // channel id and fall back to the default channel when none is given.
  const resolveOutbound = (id?: string) => runtime.resolveOutbound(id);
  const getOwnerId = (id?: string) => runtime.getOwnerId(id);
  const cfg = runtime.getConfig();
  const wfCfg = cfg.workflows ?? {};
  const byAgent = wfCfg.maxConcurrentByAgent ?? {};
  const defaultCap = byAgent._default ?? 2;
  const agentConcurrency = (name: string): number => byAgent[name] ?? defaultCap;

  // Ensure all built-in factories are registered in the runtime's registry.
  // Idempotent: re-registering the same type on hot-reload replaces the entry.
  const stepRegistry = runtime.getStepExecutorRegistry();
  populateBuiltinExecutors(stepRegistry);

  // Instantiate all registered factories (built-ins + any plugin-registered)
  // using the shared context object. The factory map is the source of truth;
  // the hardcoded array is gone.
  const executorCtx = {
    runtime,
    db,
    resolveOutbound,
    getOwnerId,
    getEmail: opts.getEmail,
    getDefaultEmailRecipients: opts.getDefaultEmailRecipients,
  };

  const engine = new WorkflowEngine({
    db,
    registry: runtime.getWorkflows(),
    maxConcurrent: wfCfg.maxConcurrent ?? 4,
    agentConcurrency,
    createSandbox: (kind: SandboxKind) => createSandbox(runtime.getConfig(), { sandbox: kind }),
    // Run-scoped resolver: snapshotted at start of each run so executors and
    // sandbox prepare hit the project root instead of the server's cwd.
    getProjectPath: () => runtime.getActiveProject()?.path,
    executors: stepRegistry.buildAll(executorCtx),
  });

  // FormExecutor depends on the engine's FormRegistry, so register it after
  // construction. The same wiring path keeps the registry private to the
  // engine while allowing the executor to share its DB-backed state.
  engine.registerExecutor(
    new FormExecutor({
      registry: engine.forms,
      resolveOutbound,
      getOwnerId,
    }),
  );

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

  // Mirror the engine's executors into the runtime's resource registry so
  // tooling (authoring, UI listing, agent discovery via task_status) sees the
  // same surface as the engine itself. The engine remains the source of
  // truth; the registry is a discoverable view.
  for (const exec of engine.listExecutors()) {
    stepRegistry.registerBuiltin(exec);
  }

  return engine;
}
