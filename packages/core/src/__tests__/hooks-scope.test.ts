/**
 * Which occurrences a config-declared hook actually reaches, and what it runs
 * with when it gets there.
 *
 * Both halves are regressions rather than features. A hook could be declared
 * on any name in the catalog, and on most of them it bound cleanly and never
 * fired — dispatch scoped by a `payload.agent` that two thirds of the events do
 * not have, and four more spell `agentName`. And a hook that did fire invoked
 * its tool with neither the agent's file boundary nor its command rules, so the
 * guard outranked the thing it guarded.
 *
 * The table at the top is the point: it asserts the reach of the whole catalog
 * rather than of the two events that happened to work, because "declared and
 * never fired" is invisible to a test that only covers what already works.
 */
import { describe, expect, it } from "vitest";
import { registerEventHookHandler, runEventHooks } from "../agent/event-hooks.js";
import { type AgentConfig, validateConfig } from "../config.js";
import { AGENT_SCOPED_EVENTS, isAgentScopedEvent, KNOWN_BROADCAST_EVENTS, TypedEventBus } from "../events.js";
import { ConfigHooks } from "../plugins/config-hooks.js";
import type { AgentRuntime } from "../runtime.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

function tool(name: string, run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>): Tool {
  return { name, description: "", parameters: { type: "object", properties: {} }, execute: run };
}

function runtimeFor(
  config: AgentConfig,
  opts: { tools?: Tool[]; events: TypedEventBus; toolContext?: Partial<ToolContext> } = {
    events: new TypedEventBus(),
  },
): AgentRuntime {
  return {
    events: opts.events,
    getConfig: () => config,
    getTools: () => opts.tools ?? [],
    agentToolContext: () => opts.toolContext ?? {},
  } as unknown as AgentRuntime;
}

/** A config with one hook, declared either under an agent or at the top level. */
function configWith(event: string, where: "agent" | "deployment", extra: Record<string, unknown> = {}): AgentConfig {
  const on = { [event]: [{ type: "probe", ...extra }] };
  return {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: {},
    agent: { defaultProvider: "openai_compatible", extraInstructions: "" },
    agents: where === "agent" ? { reviewer: { hooks: { on } } } : {},
    ...(where === "deployment" ? { hooks: { on } } : {}),
    channels: {},
    tools: {},
    custom_tools: {},
    commands: {},
    cron: { enabled: false, jobs: [] },
    webhooks: { enabled: false, routes: [] },
    context: { directory: "./c", kbDirectory: "./k" },
  } as unknown as AgentConfig;
}

/** Register a handler that records every occurrence it is handed. */
function probe(): { seen: Record<string, unknown>[]; dispose: () => void } {
  const seen: Record<string, unknown>[] = [];
  const dispose = registerEventHookHandler("probe", async (ctx) => {
    seen.push(ctx.payload);
    return { output: "ok" };
  });
  return { seen, dispose };
}

/** Emit and let the broadcast path's fire-and-forget dispatch settle. */
async function emit(events: TypedEventBus, event: string, payload: Record<string, unknown>) {
  (events as unknown as { emit(e: string, p: unknown): void }).emit(event, payload);
  await new Promise((r) => setTimeout(r, 10));
}

describe("reach across the whole event catalog", () => {
  // Every broadcast event, declared at the top level, with a payload that
  // carries nothing but its own name. Before deployment-level hooks existed,
  // 24 of these bound and never fired.
  for (const event of KNOWN_BROADCAST_EVENTS) {
    it(`a deployment hook on ${event} fires`, async () => {
      const events = new TypedEventBus();
      const { seen, dispose } = probe();
      const hooks = new ConfigHooks({ runtime: runtimeFor(configWith(event, "deployment"), { events }) });

      await emit(events, event, { marker: event });

      expect(seen).toHaveLength(1);
      hooks.stop();
      dispose();
    });
  }

  it("an agent hook fires on every event that names an agent, under either spelling", async () => {
    // The four `agentName` events are the ones this used to miss: the payload
    // named the agent right there and the scoping looked for the other word.
    const agentScoped = AGENT_SCOPED_EVENTS.filter((e) => KNOWN_BROADCAST_EVENTS.includes(e as never));
    const missed: string[] = [];

    for (const event of agentScoped) {
      for (const spelling of ["agent", "agentName"] as const) {
        const events = new TypedEventBus();
        const { seen, dispose } = probe();
        const hooks = new ConfigHooks({ runtime: runtimeFor(configWith(event, "agent"), { events }) });

        await emit(events, event, { [spelling]: "reviewer" });

        if (seen.length !== 1) missed.push(`${event} (${spelling})`);
        hooks.stop();
        dispose();
      }
    }

    expect(missed).toEqual([]);
  });
});

describe("agent scoping", () => {
  it("does not fire for a different agent", async () => {
    const events = new TypedEventBus();
    const { seen, dispose } = probe();
    const hooks = new ConfigHooks({ runtime: runtimeFor(configWith("agent.post_tool_use", "agent"), { events }) });

    await emit(events, "agent.post_tool_use", { agent: "planner", tool: "exec" });

    expect(seen).toHaveLength(0);
    hooks.stop();
    dispose();
  });

  it("a deployment hook fires whoever the occurrence belongs to", async () => {
    const events = new TypedEventBus();
    const { seen, dispose } = probe();
    const hooks = new ConfigHooks({
      runtime: runtimeFor(configWith("agent.post_tool_use", "deployment"), { events }),
    });

    await emit(events, "agent.post_tool_use", { agent: "planner", tool: "exec" });
    await emit(events, "agent.post_tool_use", { agent: "reviewer", tool: "exec" });

    expect(seen).toHaveLength(2);
    hooks.stop();
    dispose();
  });

  it("normalises the agent so `when` means one thing across the catalog", async () => {
    // `agent.completed` says `agentName`. A matcher written against `agent`
    // should still work, or `when` would mean something different per event.
    const events = new TypedEventBus();
    const { seen, dispose } = probe();
    const config = configWith("agent.completed", "deployment", { when: { agent: "reviewer" } });
    const hooks = new ConfigHooks({ runtime: runtimeFor(config, { events }) });

    await emit(events, "agent.completed", { agentName: "reviewer", taskId: "t1" });
    await emit(events, "agent.completed", { agentName: "planner", taskId: "t2" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.taskId).toBe("t1");
    hooks.stop();
    dispose();
  });

  it("does not overwrite an agent the payload already states", async () => {
    const events = new TypedEventBus();
    const { seen, dispose } = probe();
    const hooks = new ConfigHooks({
      runtime: runtimeFor(configWith("agent.post_tool_use", "deployment"), { events }),
    });

    await emit(events, "agent.post_tool_use", { agent: "reviewer", agentName: "somethingelse" });

    expect(seen[0]?.agent).toBe("reviewer");
    hooks.stop();
    dispose();
  });

  it("gives the deployment first refusal", async () => {
    // A refusal stops the chain, so order decides who wins. The operator's
    // rule should not be preemptable by an agent's own hook.
    const order: string[] = [];
    const dispose = registerEventHookHandler("probe", async (ctx) => {
      order.push(String(ctx.hook.options?.label ?? "?"));
      return { output: "ok" };
    });
    const events = new TypedEventBus();
    const config = {
      hooks: { on: { "agent.pre_tool_use": [{ type: "probe", options: { label: "deployment" } }] } },
      agents: {
        reviewer: { hooks: { on: { "agent.pre_tool_use": [{ type: "probe", options: { label: "agent" } }] } } },
      },
    } as unknown as AgentConfig;
    const hooks = new ConfigHooks({ runtime: runtimeFor(config, { events }) });

    await events.waterfall("agent.pre_tool_use", {
      sessionId: "s",
      projectId: null,
      agent: "reviewer",
      tool: "exec",
      args: {},
    });

    expect(order).toEqual(["deployment", "agent"]);
    hooks.stop();
    dispose();
  });
});

describe("what a hook's tool runs with", () => {
  const captured: ToolContext[] = [];
  const recorder = () =>
    tool("policy_check", async (_args, ctx) => {
      captured.push(ctx);
      return { success: true, output: "ok" };
    });

  it("inherits the agent's file boundary and command rules", async () => {
    // The bug: a hook invoked its tool with a context built from scratch, so a
    // hook calling `exec` ran outside the deployment's command rules and one
    // calling `write` outside the agent's boundary — the guard outranking what
    // it guarded.
    captured.length = 0;
    await runEventHooks({
      event: "agent.pre_tool_use",
      hooks: [{ tool: "policy_check" }],
      payload: { tool: "exec" },
      tools: [recorder()],
      toolContext: {
        agentName: "reviewer",
        workingDirectoryBoundary: "/work/reviewer",
        execRules: { allow: ["git status"] },
      },
      sessionId: "s",
      refusable: true,
    });

    expect(captured[0]?.workingDirectoryBoundary).toBe("/work/reviewer");
    expect(captured[0]?.execRules).toEqual({ allow: ["git status"] });
    expect(captured[0]?.agentName).toBe("reviewer");
  });

  it("resolves relative paths where the agent works, not where the server started", async () => {
    captured.length = 0;
    await runEventHooks({
      event: "agent.pre_tool_use",
      hooks: [{ tool: "policy_check" }],
      payload: {},
      tools: [recorder()],
      toolContext: { workingDirectoryBoundary: "/work/reviewer" },
      sessionId: "s",
      refusable: true,
    });

    expect(captured[0]?.workingDirectory).toBe("/work/reviewer");
  });

  it("grants nothing extra when no agent could be resolved", async () => {
    // Absent must read as "no additional privilege", never as "unrestricted".
    captured.length = 0;
    await runEventHooks({
      event: "agent.pre_tool_use",
      hooks: [{ tool: "policy_check" }],
      payload: {},
      tools: [recorder()],
      sessionId: "s",
      refusable: true,
    });

    expect(captured[0]?.workingDirectoryBoundary).toBeUndefined();
    expect(captured[0]?.execRules).toBeUndefined();
    expect(captured[0]?.workingDirectory).toBe(process.cwd());
  });
});

describe("validateConfig on where a hook is declared", () => {
  const warn = (config: unknown) => validateConfig(config as AgentConfig).join("\n");

  it("says a hook under an agent will never fire on an event that names no agent", () => {
    const text = warn(configWith("task.created", "agent"));
    expect(text).toContain("will never fire");
    expect(text).toContain("task.created");
    // The fix is a move, so the message has to name the destination.
    expect(text).toContain("hooks.on");
  });

  it("is quiet about the same event declared at the top level", () => {
    expect(warn(configWith("task.created", "deployment"))).not.toContain("will never fire");
  });

  it("is quiet about an agent-scoped event under an agent", () => {
    expect(warn(configWith("agent.pre_tool_use", "agent"))).not.toContain("will never fire");
  });

  it("still catches an unknown event name at the top level", () => {
    expect(warn(configWith("task.craeted", "deployment"))).toContain("is not a runtime event");
  });

  it("classifies every event in the catalog", () => {
    // A name that is neither agent-scoped nor declarable at the top level would
    // be unreachable from config entirely. There should be no such name.
    const unreachable = KNOWN_BROADCAST_EVENTS.filter(
      (e) => !isAgentScopedEvent(e) && warn(configWith(e, "deployment")).includes("will never fire"),
    );
    expect(unreachable).toEqual([]);
  });
});
