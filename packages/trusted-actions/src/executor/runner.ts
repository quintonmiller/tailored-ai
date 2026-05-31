/**
 * Status of an action in the approval gateway lifecycle.
 */
export type ActionStatus = "pending_approval" | "approved" | "rejected" | "running" | "completed" | "failed";

/**
 * An action in the trusted-actions system.
 */
export interface Action {
  id: string;
  type: string;
  status: ActionStatus;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  consumedAt?: Date;
}

/**
 * Audit log entry for action execution.
 */
export interface AuditEntry {
  id: string;
  actionId: string;
  event: "execute_begin" | "execute_end";
  timestamp: Date;
  details?: Record<string, unknown>;
}

/**
 * Action executor — implements a specific action type.
 */
export interface ActionExecutor {
  type: string;
  execute(input: Record<string, unknown>, ctx: ActionContext): Promise<Record<string, unknown>>;
}

/**
 * Execution context passed to action executors.
 */
export interface ActionContext {
  actionId: string;
  sessionId?: string;
}

/**
 * Registry of action executors by type.
 */
export interface ActionRegistry {
  get(type: string): ActionExecutor | undefined;
  register(executor: ActionExecutor): void;
}

/**
 * Data store for actions and audit logs.
 */
export interface ActionStore {
  /** Find the next approved action (FIFO by createdAt). */
  findApproved(): Action | undefined;
  /** Update an action's status and optional result/error. */
  updateStatus(id: string, status: ActionStatus, result?: Record<string, unknown>, error?: string): void;
  /** Write an audit log entry. */
  writeAudit(entry: Omit<AuditEntry, "id" | "timestamp">): void;
}

/**
 * Polling execution runner.
 *
 * Continuously polls the action store for approved actions,
 * executes them via the registry, and updates their status.
 */
export class ExecutionRunner {
  private running = false;
  private timerId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: ActionStore,
    private readonly registry: ActionRegistry,
    private readonly intervalMs: number = 5000,
  ) {}

  /**
   * Start the polling loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.timerId = setInterval(() => {
      if (this.running) this.tick();
    }, this.intervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Process one tick: pick up the next approved action and execute it.
   */
  async tick(): Promise<void> {
    const action = this.store.findApproved();
    if (!action) return;

    // Mark as running
    this.store.updateStatus(action.id, "running");
    this.store.writeAudit({
      actionId: action.id,
      event: "execute_begin",
      details: { type: action.type },
    });

    const executor = this.registry.get(action.type);
    if (!executor) {
      this.store.updateStatus(action.id, "failed", undefined, `No executor for type "${action.type}"`);
      this.store.writeAudit({
        actionId: action.id,
        event: "execute_end",
        details: { error: `No executor for type "${action.type}"` },
      });
      return;
    }

    try {
      const result = await executor.execute(action.input, { actionId: action.id });
      this.store.updateStatus(action.id, "completed", result);
      this.store.writeAudit({
        actionId: action.id,
        event: "execute_end",
        details: { status: "completed" },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.store.updateStatus(action.id, "failed", undefined, errorMsg);
      this.store.writeAudit({
        actionId: action.id,
        event: "execute_end",
        details: { status: "failed", error: errorMsg },
      });
    }
  }
}
