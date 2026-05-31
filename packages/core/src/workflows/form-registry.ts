import type Database from "better-sqlite3";
import {
  createFormPending,
  getFormPending,
  getFormPendingByStep,
  listFormPending,
  updateFormPending,
  type WorkflowFormPending,
} from "../db/form-queries.js";
import { validateWorkflowInputs } from "./inputs.js";
import type { WorkflowInputsSchema } from "./types.js";

export interface RegisterFormInput {
  runId: string;
  stepId: string;
  stepName: string;
  prompt: string;
  fields: WorkflowInputsSchema;
  timeoutMs: number;
}

export interface FormRegisterResult {
  formId: string;
  promise: Promise<Record<string, unknown>>;
}

export class FormTimeoutError extends Error {
  constructor(message = "form timed out") {
    super(message);
    this.name = "FormTimeoutError";
  }
}

export class FormCancelledError extends Error {
  constructor(message = "form cancelled") {
    super(message);
    this.name = "FormCancelledError";
  }
}

export interface FormPendingEvent {
  type: "form.pending";
  runId: string;
  stepId: string;
  stepName: string;
  formId: string;
  prompt: string;
  fields: WorkflowInputsSchema;
  expiresAt: string | null;
}

export interface FormSubmittedEvent {
  type: "form.submitted";
  runId: string;
  stepName: string;
  formId: string;
  values: Record<string, unknown>;
}

export type FormEvent = FormPendingEvent | FormSubmittedEvent;
type FormListener = (event: FormEvent) => void;

interface Waiter {
  formId: string;
  resolve: (values: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  fields: WorkflowInputsSchema;
}

/**
 * Tracks pending forms and the in-process promise resolvers they'll resolve
 * with on submission. Persists pending state to SQLite so the UI can render
 * the form list even when the engine instance doesn't see it.
 *
 * Server restart kills the in-memory resolvers; the engine's
 * `promoteOrphanedRuns()` path cancels their DB rows so the UI doesn't show
 * ghosts.
 */
export class FormRegistry {
  private waiters = new Map<string, Waiter>();
  private listeners = new Set<FormListener>();
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  onEvent(cb: FormListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: FormEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error(`[forms] listener error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Persist the pending form and return a promise that resolves on submit
   * or rejects on timeout/cancel. Uses run_id + step_name as the waiter key.
   */
  register(input: RegisterFormInput): FormRegisterResult {
    const expiresAt = input.timeoutMs > 0 ? new Date(Date.now() + input.timeoutMs).toISOString() : null;
    const row = createFormPending(this.db, {
      run_id: input.runId,
      step_id: input.stepId,
      step_name: input.stepName,
      prompt: input.prompt,
      fields: input.fields,
      expires_at: expiresAt,
    });
    const key = waiterKey(input.runId, input.stepName);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer =
        input.timeoutMs > 0
          ? setTimeout(() => {
              this.waiters.delete(key);
              updateFormPending(this.db, row.id, { status: "expired" });
              reject(new FormTimeoutError(`form "${input.stepName}" timed out`));
            }, input.timeoutMs)
          : null;
      this.waiters.set(key, {
        formId: row.id,
        resolve,
        reject,
        timer,
        fields: input.fields,
      });
    });
    this.emit({
      type: "form.pending",
      runId: input.runId,
      stepId: input.stepId,
      stepName: input.stepName,
      formId: row.id,
      prompt: input.prompt,
      fields: input.fields,
      expiresAt,
    });
    return { formId: row.id, promise };
  }

  /**
   * Validate the submitted payload against the form's schema; on success,
   * resolve the in-process waiter and update the DB. Returns `{ ok: true }`
   * or an error envelope the HTTP layer can return verbatim.
   */
  submit(
    runId: string,
    stepName: string,
    payload: unknown,
  ): { ok: true; values: Record<string, unknown> } | { ok: false; status: number; error: string; details?: string[] } {
    const key = waiterKey(runId, stepName);
    const waiter = this.waiters.get(key);
    if (!waiter) {
      // No live waiter — check DB to disambiguate (already submitted vs unknown).
      const persisted = getFormPendingByStep(this.db, runId, stepName);
      if (!persisted) return { ok: false, status: 404, error: "no pending form for this step" };
      if (persisted.status !== "pending") {
        return { ok: false, status: 409, error: `form is ${persisted.status}` };
      }
      return { ok: false, status: 410, error: "form expired or its engine is no longer running" };
    }
    const { errors, values } = validateWorkflowInputs(waiter.fields, payload);
    if (errors.length > 0) {
      return { ok: false, status: 400, error: "validation failed", details: errors };
    }
    if (waiter.timer) clearTimeout(waiter.timer);
    this.waiters.delete(key);
    updateFormPending(this.db, waiter.formId, { status: "submitted", submitted: values });
    waiter.resolve(values);
    this.emit({
      type: "form.submitted",
      runId,
      stepName,
      formId: waiter.formId,
      values,
    });
    return { ok: true, values };
  }

  /**
   * Cancel all pending forms for a run (used when the run itself is
   * cancelled). Resolves nothing — rejects the waiter so the executor can
   * fail the step cleanly.
   */
  cancelRun(runId: string): void {
    const toCancel: Array<[string, Waiter]> = [];
    for (const [key, w] of this.waiters) {
      if (key.startsWith(`${runId}|`)) toCancel.push([key, w]);
    }
    for (const [key, w] of toCancel) {
      if (w.timer) clearTimeout(w.timer);
      this.waiters.delete(key);
      updateFormPending(this.db, w.formId, { status: "cancelled" });
      w.reject(new FormCancelledError());
    }
  }

  listPending(runId?: string): WorkflowFormPending[] {
    return listFormPending(this.db, { run_id: runId, status: "pending" });
  }

  get(formId: string): WorkflowFormPending | null {
    return getFormPending(this.db, formId);
  }
}

function waiterKey(runId: string, stepName: string): string {
  return `${runId}|${stepName}`;
}
