import { get as getActionHandler } from "../actions/registry.js";
import { writeAudit } from "../audit/log.js";
import { getDb } from "../db/schema.js";
import { AgeStore } from "../secrets/age-store.js";
import type { ExecutorContext } from "../types.js";
import {
  type Action,
  type ActionRegistry,
  type ActionStatus,
  type ActionStore,
  type AuditEntry,
  ExecutionRunner,
} from "./runner.js";

/**
 * Adapter from the in-memory ExecutionRunner store/registry interfaces
 * to the real SQLite DB + action registry. Wraps both so the runner can
 * pick up approved actions and execute them via the registered
 * adapters (e.g. AmazonPurchaseAdapter).
 */

function row2Action(row: {
  id: string;
  type: string;
  input_json: string;
  status: ActionStatus;
  result_json: string | null;
  error: string | null;
  requested_at: string;
  decided_at: string | null;
  completed_at: string | null;
}): Action {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(row.input_json);
  } catch {
    /* leave empty */
  }
  let result: Record<string, unknown> | undefined;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json);
    } catch {
      /* leave undefined */
    }
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    input,
    result,
    error: row.error ?? undefined,
    createdAt: new Date(row.requested_at),
    updatedAt: new Date(row.decided_at || row.requested_at),
    consumedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  };
}

function makeStore(onTerminal: (actionId: string) => void): ActionStore {
  return {
    findApproved(): Action | undefined {
      const row = getDb()
        .prepare(
          `SELECT id, type, input_json, status, result_json, error,
                  requested_at, decided_at, completed_at
           FROM actions
           WHERE status = 'approved'
           ORDER BY decided_at ASC
           LIMIT 1`,
        )
        .get() as Parameters<typeof row2Action>[0] | undefined;
      return row ? row2Action(row) : undefined;
    },
    updateStatus(id: string, status: ActionStatus, result?: Record<string, unknown>, error?: string): void {
      const db = getDb();
      const isTerminal = status === "completed" || status === "failed";
      db.prepare(
        `UPDATE actions
           SET status = ?,
               result_json = ?,
               error = ?,
               completed_at = ${isTerminal ? "datetime('now')" : "completed_at"}
         WHERE id = ?`,
      ).run(status, result ? JSON.stringify(result) : null, error ?? null, id);
      if (isTerminal) onTerminal(id);
    },
    writeAudit(entry: Omit<AuditEntry, "id" | "timestamp">): void {
      writeAudit(getDb(), {
        actor: "executor",
        action: entry.event,
        context: JSON.stringify({
          action_id: entry.actionId,
          ...(entry.details ?? {}),
        }),
      });
    },
  };
}

function makeRegistry(): ActionRegistry {
  return {
    get(type: string) {
      const h = getActionHandler(type);
      if (!h) return undefined;
      // Bridge the runner's expected (input, {actionId,sessionId}) ctx
      // to the adapter's full ExecutorContext.
      return {
        type,
        execute: async (input, runCtx) => {
          const store = new AgeStore();
          const actionId = runCtx?.actionId;
          const ctx: ExecutorContext = {
            decryptCredentials: async (key: string) => {
              const blob = await store.load(key);
              if (!blob) throw new Error(`Missing credential: ${key}`);
              return blob;
            },
            sendPush: async () => {
              /* not used by adapters today */
            },
            captureScreenshot: async () => {
              /* adapters do their own */
            },
            abort: (error: string) => {
              throw new Error(error);
            },
            audit: (action, context) => {
              writeAudit(getDb(), {
                actor: "executor",
                action,
                context: JSON.stringify({ action_id: actionId, ...(context ?? {}) }),
              });
            },
          };
          return await h.execute(input, ctx);
        },
      };
    },
    register() {
      // Not used here — adapters register via actions/registry directly.
    },
  };
}

let runnerInstance: ExecutionRunner | null = null;

export function startActionRunner(opts: {
  intervalMs?: number;
  onTerminal: (actionId: string) => void;
}): ExecutionRunner {
  if (runnerInstance) return runnerInstance;
  const store = makeStore(opts.onTerminal);
  const registry = makeRegistry();
  runnerInstance = new ExecutionRunner(store, registry, opts.intervalMs ?? 5000);
  runnerInstance.start();
  return runnerInstance;
}

export function stopActionRunner(): void {
  if (runnerInstance) {
    runnerInstance.stop();
    runnerInstance = null;
  }
}
