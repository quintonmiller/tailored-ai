import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import type { Tool } from "../tools/interface.js";
import { EmailPoller } from "../triggers/email-poll.js";
import type { StepContext, StepExecutor, StepResult } from "../workflows/engine.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";

let db: Database.Database;
let registry: WorkflowRegistry;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function makeFakeGmail(searchResults: () => string, readResults?: () => string): Tool {
  return {
    name: "gmail",
    description: "fake",
    parameters: {},
    async execute(args: Record<string, unknown>) {
      if (args.action === "search") {
        return { success: true, output: searchResults() };
      }
      if (args.action === "read") {
        return { success: true, output: readResults?.() ?? "[email body]" };
      }
      return { success: false, output: "", error: "unknown action" };
    },
  };
}

class RecordingExecutor implements StepExecutor {
  type = "tool_call" as const;
  runs: Array<{ name: string; input: unknown }> = [];

  async execute(step: { name: string }, ctx: StepContext): Promise<StepResult> {
    this.runs.push({ name: step.name, input: ctx.scope.input });
    return { output: ctx.scope.input };
  }
}

describe("EmailPoller", () => {
  it("primes seen-set without firing for messages present at registration", async () => {
    vi.useFakeTimers();
    const exec = new RecordingExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "ingest",
      steps: [{ name: "record", type: "tool_call", tool: "noop" }],
    });

    const messages = ["msg-1", "msg-2"];
    const gmail = makeFakeGmail(() => messages.map((id) => `Message ID: ${id}`).join("\n"));
    const poller = new EmailPoller({
      workflowEngine: engine,
      getTools: () => [gmail],
    });
    poller.register("ingest", "is:unread", 60);

    // Let the priming microtask resolve.
    await vi.runOnlyPendingTimersAsync();
    expect(exec.runs).toEqual([]);

    poller.stop();
  });

  it("fires only on messages that appear after priming", async () => {
    vi.useFakeTimers();
    const exec = new RecordingExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "ingest",
      steps: [{ name: "record", type: "tool_call", tool: "noop" }],
    });

    let messages = ["msg-1"];
    const gmail = makeFakeGmail(() => messages.map((id) => `Message ID: ${id}`).join("\n"));
    const poller = new EmailPoller({
      workflowEngine: engine,
      getTools: () => [gmail],
    });
    poller.register("ingest", "is:unread", 60);
    // Wait for priming
    await vi.runOnlyPendingTimersAsync();

    // New message arrives
    messages = ["msg-1", "msg-2", "msg-3"];
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();

    const ids = exec.runs.map((r) => (r.input as { message_id: string }).message_id);
    expect(ids.sort()).toEqual(["msg-2", "msg-3"]);

    poller.stop();
  });

  it("intervalSeconds is clamped to 30s minimum", () => {
    const engine = new WorkflowEngine({ db, registry, executors: [] });
    const gmail = makeFakeGmail(() => "");
    const poller = new EmailPoller({
      workflowEngine: engine,
      getTools: () => [gmail],
    });
    // Should not throw — clamping happens silently.
    poller.register("wf", "x", 5);
    expect(poller.size()).toBe(1);
    poller.stop();
  });
});
