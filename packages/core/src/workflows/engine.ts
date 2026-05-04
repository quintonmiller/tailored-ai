import type Database from "better-sqlite3";
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
import { evaluateExpression } from "./expression.js";
import { resolveValue, type Scope } from "./scope.js";
import { KeyedSemaphore, Semaphore } from "./semaphore.js";
import type { WorkflowRegistry } from "./registry.js";
import type {
  ConditionStep,
  OnErrorPolicy,
  RetryPolicy,
  StepType,
  WorkflowDefinition,
  WorkflowStepDef,
} from "./types.js";

export interface StepContext {
  runId: string;
  stepId: string;
  scope: Scope;
  signal: AbortSignal;
  engine: WorkflowEngine;
  parentStepId: string | null;
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

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.runSemaphore = new Semaphore(opts.maxConcurrent ?? 4);
    const cap = opts.agentConcurrency ?? (() => 2);
    this.agentSemaphores = new KeyedSemaphore(cap);
    this.now = opts.now ?? (() => new Date());
    for (const exec of opts.executors ?? []) this.registerExecutor(exec);
  }

  registerExecutor(exec: StepExecutor): void {
    this.executors.set(exec.type, exec);
  }

  hasExecutor(type: StepType): boolean {
    return this.executors.has(type);
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
    this.active.set(run.id, { abort, workflowName: name });

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

      const scope: Scope = {
        input,
        steps: {},
        env: process.env as Record<string, string | undefined>,
      };
      const outputs = await this.runStepList(def.steps, scope, abort.signal, run.id, null);

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
      runRelease?.();
      this.active.delete(run.id);
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
        const result = await this.executeWithDeadline(step, {
          runId,
          stepId: stepRow.id,
          scope,
          signal,
          engine: this,
          parentStepId,
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
    const skip = truthy ? step.else ?? [] : step.then ?? [];
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
    return count;
  }

  /** Test helper. */
  getRun(id: string): WorkflowRun | null {
    return getWorkflowRun(this.db, id);
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
