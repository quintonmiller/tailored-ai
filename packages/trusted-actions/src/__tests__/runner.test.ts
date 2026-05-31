import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Action,
  type ActionExecutor,
  type ActionRegistry,
  type ActionStore,
  type AuditEntry,
  ExecutionRunner,
} from "../executor/runner.js";

class FakeStore implements ActionStore {
  private actions: Action[] = [];
  public auditLog: AuditEntry[] = [];

  add(action: Action): void {
    this.actions.push(action);
  }

  findApproved(): Action | undefined {
    return this.actions.find((a) => a.status === "approved");
  }

  updateStatus(id: string, status: Action["status"], result?: Record<string, unknown>, error?: string): void {
    const action = this.actions.find((a) => a.id === id);
    if (action) {
      action.status = status;
      action.result = result;
      action.error = error;
      action.updatedAt = new Date();
    }
  }

  writeAudit(entry: Omit<AuditEntry, "id" | "timestamp">): void {
    this.auditLog.push({
      id: `audit-${this.auditLog.length}`,
      ...entry,
      timestamp: new Date(),
    });
  }
}

class FakeRegistry implements ActionRegistry {
  private executors = new Map<string, ActionExecutor>();

  register(executor: ActionExecutor): void {
    this.executors.set(executor.type, executor);
  }

  get(type: string): ActionExecutor | undefined {
    return this.executors.get(type);
  }
}

describe("ExecutionRunner", () => {
  let store: FakeStore;
  let registry: FakeRegistry;
  let runner: ExecutionRunner;

  beforeEach(() => {
    store = new FakeStore();
    registry = new FakeRegistry();
    runner = new ExecutionRunner(store, registry, 100);
  });

  afterEach(() => {
    runner.stop();
  });

  it("executes approved actions and updates status to completed", async () => {
    registry.register({
      type: "test_action",
      async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
        return { executed: true, input };
      },
    });

    store.add({
      id: "action-1",
      type: "test_action",
      status: "approved",
      input: { key: "value" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await runner.tick();

    const action = store.actions[0];
    expect(action.status).toBe("completed");
    expect(action.result).toEqual({ executed: true, input: { key: "value" } });
    expect(store.auditLog.length).toBe(2);
    expect(store.auditLog[0].event).toBe("execute_begin");
    expect(store.auditLog[1].event).toBe("execute_end");
  });

  it("marks action as failed when executor throws", async () => {
    registry.register({
      type: "failing_action",
      async execute(): Promise<Record<string, unknown>> {
        throw new Error("boom");
      },
    });

    store.add({
      id: "action-2",
      type: "failing_action",
      status: "approved",
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await runner.tick();

    const action = store.actions[0];
    expect(action.status).toBe("failed");
    expect(action.error).toBe("boom");
  });

  it("marks action as failed when no executor found", async () => {
    store.add({
      id: "action-3",
      type: "unknown_type",
      status: "approved",
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await runner.tick();

    const action = store.actions[0];
    expect(action.status).toBe("failed");
    expect(action.error).toContain("No executor for type");
  });

  it("does nothing when no approved actions", async () => {
    store.add({
      id: "action-4",
      type: "test_action",
      status: "pending_approval",
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await runner.tick();

    const action = store.actions[0];
    expect(action.status).toBe("pending_approval");
    expect(store.auditLog.length).toBe(0);
  });

  it("polls on interval when started", async () => {
    const tickSpy = vi.spyOn(runner, "tick").mockResolvedValue();
    runner.start();

    // Wait for a couple of ticks
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    runner.stop();
  });

  it("stops polling when stopped", async () => {
    const tickSpy = vi.spyOn(runner, "tick").mockResolvedValue();
    runner.start();

    await new Promise((resolve) => setTimeout(resolve, 150));
    const callsAfterStart = tickSpy.mock.calls.length;

    runner.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(tickSpy.mock.calls.length).toBe(callsAfterStart);
  });
});
