import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { AgentRuntime } from "../runtime.js";
import { createSandbox } from "../sandboxes/factory.js";
import type { SandboxKind } from "../sandboxes/interface.js";
import { createEgressPolicy } from "../security/egress-policy.js";
import { WorkflowEngine } from "./engine.js";
import { AgentRunExecutor } from "./executors/agent-run.js";
import { ChannelMessageExecutor } from "./executors/channel-message.js";
import { FormExecutor } from "./executors/form.js";
import { HttpRequestExecutor } from "./executors/http-request.js";
import { LoopExecutor } from "./executors/loop.js";
import { type EmailSender, NotifyExecutor } from "./executors/notify.js";
import { ParallelExecutor } from "./executors/parallel.js";
import { ShellExecutor } from "./executors/shell.js";
import { ToolCallExecutor } from "./executors/tool-call.js";
import { TriggerWorkflowExecutor } from "./executors/trigger-workflow.js";
import { WorktreeExecutor } from "./executors/worktree.js";
import { FileLogStore } from "./logs.js";

/**
 * Build a WorkflowEngine pre-wired with the standard executors and
 * concurrency caps from the runtime's config. Returns the engine; the
 * caller is responsible for retaining a reference.
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

  const engine = new WorkflowEngine({
    db,
    registry: runtime.getWorkflows(),
    maxConcurrent: wfCfg.maxConcurrent ?? 4,
    agentConcurrency,
    createSandbox: (kind: SandboxKind) => createSandbox(runtime.getConfig(), { sandbox: kind }),
    // Run-scoped resolver: snapshotted at start of each run so executors and
    // sandbox prepare hit the project root instead of the server's cwd.
    getProjectPath: () => runtime.getActiveProject()?.path,
    executors: [
      new AgentRunExecutor({ runtime, db }),
      new ToolCallExecutor({
        getTools: () => runtime.getTools(),
        // cwd defaults are last-resort; per-run StepContext.projectPath wins.
        env: process.env as Record<string, string>,
      }),
      new ShellExecutor(),
      new WorktreeExecutor(),
      new LoopExecutor(),
      new ParallelExecutor(),
      new ChannelMessageExecutor({
        resolveOutbound,
        getOwnerId,
        events: runtime.events,
      }),
      new TriggerWorkflowExecutor(),
      new HttpRequestExecutor({ egressPolicy: createEgressPolicy(cfg.security?.egress) }),
      new NotifyExecutor({
        resolveOutbound,
        getOwnerId,
        getEmail: opts.getEmail,
        getDefaultEmailRecipients: opts.getDefaultEmailRecipients,
      }),
    ],
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
  const stepRegistry = runtime.getStepExecutorRegistry();
  for (const exec of engine.listExecutors()) {
    stepRegistry.registerBuiltin(exec);
  }

  return engine;
}
