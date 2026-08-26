/**
 * The `tool_called` workflow trigger, which until now never fired.
 *
 * It was declared in `WorkflowTriggerDef`, validated by the loader, and
 * advertised through the resource trigger registry as "Fires when a specific
 * tool is invoked" — and nothing dispatched it (#561). A deployment could write
 * the config, watch it validate, see it in the UI, and get nothing.
 *
 * It could not be fixed alone: every other trigger kind has a poller, and this
 * one needs to know when a tool ran. `agent.post_tool_use` is that, and this is
 * its first consumer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "../events.js";
import { ToolCalledTrigger } from "../plugins/tool-called-trigger.js";
import type { AgentRuntime } from "../runtime.js";
import type { RegisteredWorkflow } from "../workflows/types.js";

let events: TypedEventBus;
let started: Array<{ name: string; input: unknown }>;
let trigger: ToolCalledTrigger | undefined;

beforeEach(() => {
  events = new TypedEventBus();
  started = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  trigger?.stop();
  trigger = undefined;
  vi.restoreAllMocks();
});

function workflow(name: string, tool?: string): RegisteredWorkflow {
  return {
    definition: {
      name,
      steps: [],
      ...(tool ? { triggers: [{ kind: "tool_called" as const, tool }] } : {}),
    },
    source: "programmatic",
    generation: 1,
  } as RegisteredWorkflow;
}

function fakeRuntime(workflows: RegisteredWorkflow[], withEngine = true): AgentRuntime {
  const engine = {
    async runWorkflow(name: string, input: unknown) {
      started.push({ name, input });
      return {};
    },
  };
  return {
    events,
    getWorkflows: () => ({ list: () => workflows }),
    getWorkflowEngine: () => (withEngine ? engine : undefined),
  } as unknown as AgentRuntime;
}

function used(tool: string, args: Record<string, unknown> = {}, output = "ok") {
  events.emit("agent.post_tool_use", {
    sessionId: "s",
    projectId: null,
    tool,
    args,
    output,
    success: true,
    durationMs: 1,
  });
}

describe("tool_called", () => {
  it("runs a workflow whose trigger names the tool", async () => {
    trigger = new ToolCalledTrigger({ runtime: fakeRuntime([workflow("audit", "exec")]) });
    used("exec", { command: "ls" });
    await Promise.resolve();

    expect(started).toHaveLength(1);
    expect(started[0].name).toBe("audit");
  });

  it("hands the workflow what the tool was given and what it returned", async () => {
    trigger = new ToolCalledTrigger({ runtime: fakeRuntime([workflow("audit", "exec")]) });
    used("exec", { command: "ls" }, "a.txt");
    await Promise.resolve();

    expect(started[0].input).toEqual({ tool: "exec", args: { command: "ls" }, output: "a.txt" });
  });

  it("ignores a workflow that names a different tool", async () => {
    trigger = new ToolCalledTrigger({ runtime: fakeRuntime([workflow("audit", "write")]) });
    used("exec");
    await Promise.resolve();

    expect(started).toEqual([]);
  });

  it("ignores a workflow with no triggers", async () => {
    trigger = new ToolCalledTrigger({ runtime: fakeRuntime([workflow("plain")]) });
    used("exec");
    await Promise.resolve();

    expect(started).toEqual([]);
  });

  it("runs every workflow that matches", async () => {
    trigger = new ToolCalledTrigger({
      runtime: fakeRuntime([workflow("audit", "exec"), workflow("notify", "exec"), workflow("other", "write")]),
    });
    used("exec");
    await Promise.resolve();

    expect(started.map((s) => s.name).sort()).toEqual(["audit", "notify"]);
  });

  it("does nothing when there is no workflow engine on this path", async () => {
    // A CLI single-message run has no engine. Nothing to start, and nothing
    // worth warning about on every tool call.
    trigger = new ToolCalledTrigger({ runtime: fakeRuntime([workflow("audit", "exec")], false) });
    used("exec");
    await Promise.resolve();

    expect(started).toEqual([]);
  });

  it("stops listening when disposed", async () => {
    trigger = new ToolCalledTrigger({ runtime: fakeRuntime([workflow("audit", "exec")]) });
    trigger.stop();
    used("exec");
    await Promise.resolve();

    expect(started).toEqual([]);
  });

  it("does not let a failing workflow escape into the tool call", async () => {
    // Fire and forget: the tool has already returned and the model is waiting
    // on the loop. A workflow's failure is not the turn's problem.
    const runtime = {
      events,
      getWorkflows: () => ({ list: () => [workflow("audit", "exec")] }),
      getWorkflowEngine: () => ({
        runWorkflow: async () => {
          throw new Error("workflow exploded");
        },
      }),
    } as unknown as AgentRuntime;
    trigger = new ToolCalledTrigger({ runtime });

    expect(() => used("exec")).not.toThrow();
    await Promise.resolve();
  });
});
