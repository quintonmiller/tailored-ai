import type Database from "better-sqlite3";
import { cancelOrphanedForms } from "../db/form-queries.js";
import {
  createWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  recordWorkflowStep,
  updateWorkflowRun,
  updateWorkflowStep,
  type WorkflowRun,
  type WorkflowTrigger,
} from "../db/workflow-queries.js";
import type { Sandbox, SandboxHandle, SandboxKind } from "../sandboxes/interface.js";
import { evaluateExpression } from "./expression.js";
import { FormRegistry } from "./form-registry.js";
import type { WorkflowRegistry } from "./registry.js";
import { resolveValue, type Scope } from "./scope.js";
import { loadSecretsMap } from "./secrets.js";
import { KeyedSemaphore, Semaphore } from "./semaphore.js";
import type {
  ConditionStep,
  OnErrorPolicy,
  RetryPolicy,
  StepType,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowStepDef,
} from "./types.js";

export interface StepContext {
  runId: string;
  stepId: string;
  scope: Scope;
  signal: AbortSignal;
  engine: WorkflowEngine;
  parentStepId: string | null;
  /**
   * Dry-run mode: side-effecting executors (notify, channel_message,
   * http_request with mutating method, shell, tool_call) check this and
   * log-only instead of executing. Read-only ops still run normally so the
   * pipeline produces realistic intermediate values.
   */
  dryRun?: boolean;
  /**
   * Run-level sandbox + handle when `WorkflowDefinition.sandbox` is set.
   * Steps that route through a sandbox (shell, worktree) read these to share
   * one container across the whole run. Undefined for `host` (default) so the
   * existing direct-execution paths stay.
   */
  sandbox?: Sandbox;
  sandboxHandle?: SandboxHandle;
  /**
   * Resolved project root for this run. Set when the runtime has an active
   * project; absent in global mode. Executors that anchor to a filesystem
   * location (shell, tool_call, worktree) prefer this over `process.cwd()`
   * so a workflow launched from any directory still executes against the
   * intended project. See [#64].
   */
  projectPath?: string;
}

export interface RunOptions {
  /** When true, side-effecting executors log instead of executing. */
  dryRun?: boolean;
}

export interface StepResult {
  output: unknown;
  /** Sibling step names to mark as skipped. Used by `condition` steps. */
  skip?: string[];
}

export interface StepExecutor {
  type: StepType;
  execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult>;
}

export interface EngineOptions {
  db: Database.Database;
  registry: WorkflowRegistry;
  executors?: StepExecutor[];
  /** Global cap on concurrent workflow runs. Default 4. */
  maxConcurrent?: number;
  /** Per-agent cap on concurrent agent_run steps. Looked up by agent name. */
  agentConcurrency?: (agentName: string) => number;
  /**
   * Factory for run-level sandboxes. Called once per run when the workflow
   * definition sets `sandbox`. Omitting it (or returning a HostSandbox) keeps
   * the existing host-only behavior. Tests usually leave it unset.
   */
  createSandbox?: (kind: SandboxKind) => Sandbox;
  /**
   * Resolve the active project root at the moment a run starts. The result
   * is captured on the run handle and threaded onto every step's
   * `StepContext.projectPath` so filesystem-anchored executors (shell,
   * tool_call, worktree, sandbox) use the project root instead of
   * `process.cwd()`. Returning `undefined` means "no active project"
   * (global mode) — executors fall back to their own defaults.
   */
  getProjectPath?: () => string | undefined;
  /** Override clock for tests. */
  now?: () => Date;
}

export class WorkflowError extends Error {}
export class CancelledError extends WorkflowError {
  constructor(message = "workflow cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}
export class DeadlineError extends WorkflowError {
  constructor(message = "step deadline exceeded") {
    super(message);
    this.name = "DeadlineError";
  }
}

interface RunHandle {
  abort: AbortController;
  workflowName: string;
  dryRun: boolean;
  /** Resolved at run-start so a mid-run project switch doesn't change the cwd of in-flight steps. */
  projectPath?: string;
}

export type EngineEvent =
  | { type: "run.started"; runId: string; workflowName: string }
  | { type: "run.completed"; runId: string; output: unknown }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.cancelled"; runId: string }
  | {
      type: "step.started";
      runId: string;
      stepId: string;
      stepName: string;
      stepType: StepType;
      attempt: number;
    }
  | {
      type: "step.completed";
      runId: string;
      stepId: string;
      stepName: string;
      output: unknown;
    }
  | {
      type: "step.failed";
      runId: string;
      stepId: string;
      stepName: string;
      error: string;
    }
  | { type: "step.skipped"; runId: string; stepId: string; stepName: string };

type EventListener = (event: EngineEvent) => void;

export class WorkflowEngine {
  private db: Database.Database;
  private registry: WorkflowRegistry;
  private executors = new Map<StepType, StepExecutor>();
  private runSemaphore: Semaphore;
  private agentSemaphores: KeyedSemaphore;
  private active = new Map<string, RunHandle>();
  private now: () => Date;
  private listeners = new Set<EventListener>();
  private createSandbox: ((kind: SandboxKind) => Sandbox) | undefined;
  private getProjectPath: (() => string | undefined) | undefined;
  /** Sandbox + handle prepared for an active run; cleaned up in `runWorkflow`'s finally. */
  private runSandboxes = new Map<string, { sandbox: Sandbox; handle: SandboxHandle }>();
  readonly forms: FormRegistry;

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.runSemaphore = new Semaphore(opts.maxConcurrent ?? 4);
    const cap = opts.agentConcurrency ?? (() => 2);
    this.agentSemaphores = new KeyedSemaphore(cap);
    this.now = opts.now ?? (() => new Date());
    this.createSandbox = opts.createSandbox;
    this.getProjectPath = opts.getProjectPath;
    this.forms = new FormRegistry(this.db);
    for (const exec of opts.executors ?? []) this.registerExecutor(exec);
  }

  registerExecutor(exec: StepExecutor): void {
    this.executors.set(exec.type, exec);
  }

  hasExecutor(type: StepType): boolean {
    return this.executors.has(type);
  }

  /** Snapshot of currently-registered executors. Used by the resource registry mirror. */
  listExecutors(): StepExecutor[] {
    return Array.from(this.executors.values());
  }

  /** Subscribe to engine events. Returns unsubscribe. */
  onEvent(cb: EventListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: EngineEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error(`[workflow] event listener error: ${(err as Error).message}`);
      }
    }
  }

  /** True iff the run is currently in flight in this engine instance. */
  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Cancel a running workflow run. Idempotent. */
  cancel(runId: string): boolean {
    const handle = this.active.get(runId);
    if (!handle) return false;
    handle.abort.abort();
    // Best-effort: tear down any pending-form waiters tied to this run so
    // the executor unblocks immediately instead of waiting on the abort hook.
    this.forms.cancelRun(runId);
    return true;
  }

  /**
   * Execute a workflow run end-to-end. Persists state at every transition
   * so the run is restartable. Returns the final WorkflowRun row.
   */
  async runWorkflow(
    name: string,
    input: unknown = {},
    trigger: WorkflowTrigger = "programmatic",
    options: RunOptions = {},
  ): Promise<WorkflowRun> {
    const reg = this.registry.get(name);
    if (!reg) throw new WorkflowError(`unknown workflow: ${name}`);
    const def = reg.definition;

    const run = createWorkflowRun(this.db, {
      workflow_name: name,
      trigger,
      input,
      status: "pending",
    });

    const abort = new AbortController();
    const projectPath = this.resolveProjectPath();
    this.active.set(run.id, {
      abort,
      workflowName: name,
      dryRun: options.dryRun === true,
      projectPath,
    });

    let runRelease: (() => void) | null = null;
    let workflowDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      runRelease = await this.runSemaphore.acquire();
      if (abort.signal.aborted) throw new CancelledError();
      updateWorkflowRun(this.db, run.id, { status: "running" });
      this.emit({ type: "run.started", runId: run.id, workflowName: name });

      if (def.deadlineMs) {
        workflowDeadlineTimer = setTimeout(() => abort.abort(), def.deadlineMs);
      }

      await this.prepareRunSandbox(run.id, def, projectPath);

      const scope: Scope = {
        input,
        steps: {},
        env: process.env as Record<string, string | undefined>,
        secrets: this.loadSecretsForRun(name),
      };
      const outputs =
        def.executionMode === "graph" && def.graph
          ? await this.runStepGraph(def.steps, def.graph, scope, abort.signal, run.id, null)
          : await this.runStepList(def.steps, scope, abort.signal, run.id, null);

      const finalOutput = outputs[def.steps[def.steps.length - 1]?.name] ?? null;
      const finished = updateWorkflowRun(this.db, run.id, {
        status: "completed",
        output: finalOutput,
        finished_at: this.now().toISOString(),
      });
      this.emit({ type: "run.completed", runId: run.id, output: finalOutput });
      return finished!;
    } catch (err) {
      const isCancel = err instanceof CancelledError || abort.signal.aborted;
      const status = isCancel ? "cancelled" : "failed";
      const message = (err as Error).message;
      const finished = updateWorkflowRun(this.db, run.id, {
        status,
        error: message,
        finished_at: this.now().toISOString(),
      });
      if (isCancel) this.emit({ type: "run.cancelled", runId: run.id });
      else this.emit({ type: "run.failed", runId: run.id, error: message });
      return finished!;
    } finally {
      if (workflowDeadlineTimer) clearTimeout(workflowDeadlineTimer);
      await this.cleanupRunSandbox(run.id);
      runRelease?.();
      this.active.delete(run.id);
    }
  }

  /**
   * Prepare a run-level sandbox when the workflow declares one. Container
   * setup happens once per run; the handle is shared with every step via
   * `StepContext`. Missing factory or "host" kind is a no-op.
   */
  private async prepareRunSandbox(
    runId: string,
    def: WorkflowDefinition,
    projectPath: string | undefined,
  ): Promise<void> {
    if (!def.sandbox || def.sandbox === "host") return;
    if (!this.createSandbox) {
      throw new WorkflowError(
        `workflow "${def.name}" requests sandbox "${def.sandbox}" but no sandbox factory was provided to the engine`,
      );
    }
    const sandbox = this.createSandbox(def.sandbox);
    const handle = await sandbox.prepare({ cwd: projectPath ?? process.cwd() });
    this.runSandboxes.set(runId, { sandbox, handle });
  }

  /**
   * Snapshot the current project root from the injected resolver. Called once
   * per run at start so an `setActiveProject` switch mid-run doesn't shift the
   * cwd of in-flight steps.
   */
  private resolveProjectPath(): string | undefined {
    if (!this.getProjectPath) return undefined;
    try {
      const path = this.getProjectPath();
      return path && path.length > 0 ? path : undefined;
    } catch (err) {
      console.warn(`[workflow] getProjectPath threw: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async cleanupRunSandbox(runId: string): Promise<void> {
    const entry = this.runSandboxes.get(runId);
    if (!entry) return;
    this.runSandboxes.delete(runId);
    try {
      await entry.sandbox.cleanup(entry.handle);
    } catch (err) {
      console.warn(`[workflow] sandbox cleanup failed: ${(err as Error).message}`);
    }
  }

  /**
   * Execute a list of steps sequentially, threading outputs into the
   * scope's `steps.<name>` and `prev` fields. `condition` steps may add
   * to a skip set so later siblings are marked skipped.
   *
   * Used both at top level and inside `loop`/`parallel` step bodies.
   */
  async runStepList(
    steps: WorkflowStepDef[],
    parentScope: Scope,
    signal: AbortSignal,
    runId: string,
    parentStepId: string | null,
  ): Promise<Record<string, unknown>> {
    const outputs: Record<string, unknown> = { ...(parentScope.steps ?? {}) };
    const skipNames = new Set<string>();
    let prev: unknown = parentScope.prev;

    for (const step of steps) {
      if (signal.aborted) throw new CancelledError();
      if (skipNames.has(step.name)) {
        const stepRow = recordWorkflowStep(this.db, {
          run_id: runId,
          step_name: step.name,
          step_type: step.type,
          parent_step_id: parentStepId,
        });
        updateWorkflowStep(this.db, stepRow.id, {
          status: "skipped",
          finished_at: this.now().toISOString(),
        });
        this.emit({
          type: "step.skipped",
          runId,
          stepId: stepRow.id,
          stepName: step.name,
        });
        outputs[step.name] = null;
        continue;
      }

      const scope: Scope = {
        ...parentScope,
        steps: outputs,
        prev,
      };
      const { output, skip } = await this.runStep(step, scope, signal, runId, parentStepId);
      outputs[step.name] = output;
      prev = output;
      if (skip) for (const n of skip) skipNames.add(n);
    }
    return outputs;
  }

  /**
   * Execute steps as a DAG derived from `graph.edges`. Steps whose
   * dependencies have all completed run concurrently as a "wave"; the next
   * wave starts only once the current one settles.
   *
   * Differences from runStepList:
   * - Sibling steps within a wave do NOT see each other on `scope.steps`
   *   (matches the explicit `parallel` step's semantics — prevents race-y
   *   cross-reads). Downstream waves see all prior outputs.
   * - `prev` is set to the most-recently-completed step's output (best effort;
   *   ambiguous when a wave has multiple completions, so callers should use
   *   `steps.NAME` rather than `prev` in graph mode).
   * - Condition steps still set skipNames; the `__trigger__` source is treated
   *   as always-resolved.
   */
  async runStepGraph(
    steps: WorkflowStepDef[],
    graph: WorkflowGraph,
    parentScope: Scope,
    signal: AbortSignal,
    runId: string,
    parentStepId: string | null,
  ): Promise<Record<string, unknown>> {
    const byName = new Map(steps.map((s) => [s.name, s] as const));
    const deps = buildDependencyMap(steps, graph);

    const outputs: Record<string, unknown> = { ...(parentScope.steps ?? {}) };
    const skipNames = new Set<string>();
    const completed = new Set<string>(["__trigger__"]);
    let prev: unknown = parentScope.prev;

    while (completed.size - 1 < steps.length) {
      if (signal.aborted) throw new CancelledError();

      // Steps whose deps are all satisfied (or skipped) and that haven't run.
      const ready: WorkflowStepDef[] = [];
      for (const step of steps) {
        if (completed.has(step.name)) continue;
        const need = deps.get(step.name) ?? new Set();
        let ok = true;
        for (const d of need) {
          if (!completed.has(d)) {
            ok = false;
            break;
          }
        }
        if (ok) ready.push(step);
      }

      if (ready.length === 0) {
        // Either a cycle or unreachable nodes — mark the remainder skipped.
        for (const s of steps) {
          if (!completed.has(s.name)) {
            const stepRow = recordWorkflowStep(this.db, {
              run_id: runId,
              step_name: s.name,
              step_type: s.type,
              parent_step_id: parentStepId,
            });
            updateWorkflowStep(this.db, stepRow.id, {
              status: "skipped",
              finished_at: this.now().toISOString(),
            });
            this.emit({ type: "step.skipped", runId, stepId: stepRow.id, stepName: s.name });
            outputs[s.name] = null;
            completed.add(s.name);
          }
        }
        break;
      }

      // Skipped steps don't run — record + emit + mark completed in this pass.
      const toRun: WorkflowStepDef[] = [];
      for (const step of ready) {
        if (skipNames.has(step.name)) {
          const stepRow = recordWorkflowStep(this.db, {
            run_id: runId,
            step_name: step.name,
            step_type: step.type,
            parent_step_id: parentStepId,
          });
          updateWorkflowStep(this.db, stepRow.id, {
            status: "skipped",
            finished_at: this.now().toISOString(),
          });
          this.emit({ type: "step.skipped", runId, stepId: stepRow.id, stepName: step.name });
          outputs[step.name] = null;
          completed.add(step.name);
        } else {
          toRun.push(step);
        }
      }

      if (toRun.length === 0) continue;

      // Snapshot scope shared by everyone in this wave — they don't see each
      // other's outputs (deliberate; same posture as ParallelExecutor).
      const waveScope: Scope = {
        ...parentScope,
        steps: { ...outputs },
        prev,
      };

      const results = await Promise.allSettled(
        toRun.map((step) => this.runStep(step, waveScope, signal, runId, parentStepId)),
      );

      const errors: string[] = [];
      for (let i = 0; i < toRun.length; i++) {
        const step = toRun[i];
        const result = results[i];
        if (result.status === "fulfilled") {
          outputs[step.name] = result.value.output;
          prev = result.value.output;
          if (result.value.skip) for (const n of result.value.skip) skipNames.add(n);
          completed.add(step.name);
        } else {
          const err = result.reason as Error;
          if (err instanceof CancelledError || signal.aborted) throw new CancelledError();
          errors.push(`${step.name}: ${err.message}`);
          // Mark completed-with-failure so the wave can move on; downstream
          // dependents will be unreachable and end up skipped above.
          completed.add(step.name);
          outputs[step.name] = null;
        }
      }

      // If any non-`onError: continue` step failed in this wave, the engine's
      // runStep already rethrew — but Promise.allSettled swallowed it. We
      // surface the first failure so the run is marked failed.
      if (errors.length > 0) {
        const firstFail = toRun.find(
          (s, i) => results[i].status === "rejected" && (s.onError ?? "fail") !== "continue",
        );
        if (firstFail) {
          throw new Error(errors.join("; "));
        }
        // Otherwise all failures were `continue` — keep going.
      }
      // Mute the unused-name lint when no validation fails.
      void byName;
    }

    return outputs;
  }

  /**
   * Execute a single step with retry, onError, and deadline policies.
   * Persists state transitions to workflow_steps. Returns the step's
   * output and any sibling skip set.
   */
  async runStep(
    step: WorkflowStepDef,
    scope: Scope,
    signal: AbortSignal,
    runId: string,
    parentStepId: string | null,
  ): Promise<StepResult> {
    if (signal.aborted) throw new CancelledError();

    const stepRow = recordWorkflowStep(this.db, {
      run_id: runId,
      step_name: step.name,
      step_type: step.type,
      parent_step_id: parentStepId,
    });

    const onError: OnErrorPolicy = step.onError ?? "fail";
    const retry: RetryPolicy | undefined =
      step.retry ?? (onError === "retry" ? { maxAttempts: 3, backoffMs: 1000 } : undefined);
    const maxAttempts = retry?.maxAttempts ?? 1;
    const backoffMs = retry?.backoffMs ?? 0;

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) throw new CancelledError();
      updateWorkflowStep(this.db, stepRow.id, {
        status: "running",
        attempt,
        started_at: this.now().toISOString(),
      });
      this.emit({
        type: "step.started",
        runId,
        stepId: stepRow.id,
        stepName: step.name,
        stepType: step.type,
        attempt,
      });
      try {
        const sb = this.runSandboxes.get(runId);
        const handle = this.active.get(runId);
        const result = await this.executeWithDeadline(step, {
          runId,
          stepId: stepRow.id,
          scope,
          signal,
          engine: this,
          parentStepId,
          dryRun: handle?.dryRun === true,
          sandbox: sb?.sandbox,
          sandboxHandle: sb?.handle,
          projectPath: handle?.projectPath,
        });
        updateWorkflowStep(this.db, stepRow.id, {
          status: "completed",
          output: result.output,
          finished_at: this.now().toISOString(),
        });
        this.emit({
          type: "step.completed",
          runId,
          stepId: stepRow.id,
          stepName: step.name,
          output: result.output,
        });
        return result;
      } catch (err) {
        lastError = err as Error;
        if (signal.aborted || lastError instanceof CancelledError) {
          updateWorkflowStep(this.db, stepRow.id, {
            status: "failed",
            error: "cancelled",
            finished_at: this.now().toISOString(),
          });
          throw new CancelledError();
        }
        if (attempt < maxAttempts) {
          if (backoffMs > 0) {
            await this.sleep(backoffMs * 2 ** (attempt - 1), signal);
          }
          continue;
        }
        // Exhausted attempts.
        updateWorkflowStep(this.db, stepRow.id, {
          status: "failed",
          error: lastError.message,
          finished_at: this.now().toISOString(),
        });
        this.emit({
          type: "step.failed",
          runId,
          stepId: stepRow.id,
          stepName: step.name,
          error: lastError.message,
        });
        if (onError === "continue") {
          return { output: null };
        }
        throw lastError;
      }
    }
    // Should be unreachable.
    throw lastError ?? new Error(`step "${step.name}" did not run`);
  }

  /** Acquire a per-agent semaphore slot for an agent_run step. */
  async acquireAgentSlot(agentName: string, signal: AbortSignal, stepId: string): Promise<() => void> {
    if (signal.aborted) throw new CancelledError();
    updateWorkflowStep(this.db, stepId, { blocked_on: `agent:${agentName}` });
    const release = await this.agentSemaphores.acquire(agentName);
    updateWorkflowStep(this.db, stepId, { blocked_on: null });
    return release;
  }

  private async executeWithDeadline(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    if (step.type === "condition") return this.runCondition(step as ConditionStep, ctx);
    const exec = this.executors.get(step.type);
    if (!exec) throw new WorkflowError(`no executor registered for step type "${step.type}"`);
    if (!step.deadlineMs) return exec.execute(step, ctx);

    return new Promise<StepResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const local = new AbortController();
      const onParentAbort = () => local.abort();
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });
      timer = setTimeout(() => {
        local.abort();
        reject(new DeadlineError(`step "${step.name}" exceeded deadlineMs ${step.deadlineMs}`));
      }, step.deadlineMs);

      const scopedCtx: StepContext = { ...ctx, signal: local.signal };
      exec
        .execute(step, scopedCtx)
        .then((result) => {
          if (timer) clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onParentAbort);
          resolve(result);
        })
        .catch((err) => {
          if (timer) clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onParentAbort);
          reject(err);
        });
    });
  }

  private async runCondition(step: ConditionStep, ctx: StepContext): Promise<StepResult> {
    const truthy = evaluateExpression(step.if, ctx.scope);
    const skip = truthy ? (step.else ?? []) : (step.then ?? []);
    return { output: null, skip };
  }

  /** Resolve a value against a scope (typed entry for executors). */
  resolve(value: unknown, scope: Scope): unknown {
    return resolveValue(value, scope);
  }

  /** Mark in-flight runs as interrupted on startup. Returns count. */
  static promoteOrphanedRuns(db: Database.Database): number {
    const runs = listWorkflowRuns(db, { status: "running" });
    const now = new Date().toISOString();
    let count = 0;
    for (const r of runs) {
      updateWorkflowRun(db, r.id, { status: "interrupted", finished_at: now });
      count++;
    }
    const pending = listWorkflowRuns(db, { status: "pending" });
    for (const r of pending) {
      updateWorkflowRun(db, r.id, { status: "interrupted", finished_at: now });
      count++;
    }
    // Forms attached to interrupted runs would otherwise linger as "pending"
    // and confuse the UI. Sweep them.
    cancelOrphanedForms(db);
    return count;
  }

  /** Test helper. */
  getRun(id: string): WorkflowRun | null {
    return getWorkflowRun(this.db, id);
  }

  /**
   * Load secrets for a workflow into a name → value map. Errors are
   * swallowed (with a console warning) so a broken encryption key doesn't
   * crash unrelated workflows.
   */
  private loadSecretsForRun(workflowName: string): Record<string, string> {
    try {
      return loadSecretsMap(this.db, workflowName);
    } catch (err) {
      console.warn(`[workflow] failed to load secrets for "${workflowName}": ${(err as Error).message}`);
      return {};
    }
  }

  /**
   * Test/debug helper: returns the per-step predecessor set the graph runner
   * uses. Exposed so unit tests can pin the exact dependencies they expect.
   */
  static computeDependencies(steps: WorkflowStepDef[], graph: WorkflowGraph): Map<string, Set<string>> {
    return buildDependencyMap(steps, graph);
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new CancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * Build a per-step set of predecessor step names from the workflow graph.
 * Edges from `__trigger__` mark a step as an entry point with no real
 * dependency (treated as always-resolved). Self-loops are filtered. Edges
 * pointing at unknown steps are ignored.
 */
function buildDependencyMap(steps: WorkflowStepDef[], graph: WorkflowGraph): Map<string, Set<string>> {
  const valid = new Set(steps.map((s) => s.name));
  const deps = new Map<string, Set<string>>();
  for (const s of steps) deps.set(s.name, new Set());
  for (const edge of graph.edges ?? []) {
    if (!valid.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    if (edge.from === "__trigger__") {
      // Entry points have no real predecessors; the graph runner treats
      // __trigger__ as always-resolved so we just leave the dep set empty
      // when only __trigger__ feeds the step.
      continue;
    }
    if (!valid.has(edge.from)) continue;
    deps.get(edge.to)!.add(edge.from);
  }
  return deps;
}
