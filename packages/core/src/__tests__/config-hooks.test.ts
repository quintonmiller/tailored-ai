/**
 * Config-declared hooks bound to runtime events.
 *
 * `beforeRun` and `afterRun` reach two fixed points in a turn; `hooks.on`
 * reaches the rest of the bus. The property that makes this different from
 * adopting a second event catalog is that the names are TAI's own and checked
 * against the live registry — a typo is a `validateConfig` warning, not a hook
 * that parses, validates and never fires. That last shape is the one this repo
 * keeps producing; #561 was a whole trigger kind of it.
 */
import { describe, expect, it, vi } from "vitest";
import { matchesWhen, resolveEventHooks, runEventHooks } from "../agent/event-hooks.js";
import { type AgentConfig, validateConfig } from "../config.js";
import { TypedEventBus } from "../events.js";
import { ConfigHooks } from "../plugins/config-hooks.js";
import type { AgentRuntime } from "../runtime.js";
import type { Tool, ToolResult } from "../tools/interface.js";

function tool(name: string, run: () => Promise<ToolResult>): Tool {
  return { name, description: "", parameters: { type: "object", properties: {} }, execute: run };
}

const says = (output: string) => tool("policy_check", async () => ({ success: true, output }));
const breaks = () =>
  tool("policy_check", async () => {
    throw new Error("upstream down");
  });

describe("matchesWhen", () => {
  it("matches a field exactly", () => {
    expect(matchesWhen({ tool: "exec" }, { tool: "exec" })).toBe(true);
    expect(matchesWhen({ tool: "exec" }, { tool: "read" })).toBe(false);
  });

  it("does not match a neighbouring name", () => {
    // Exactness is the point: an unanchored pattern quietly matching a
    // neighbouring tool is the wrong kind of surprise in a security control.
    expect(matchesWhen({ tool: "exec_sandboxed" }, { tool: "exec" })).toBe(false);
  });

  it("takes a regex between slashes", () => {
    expect(matchesWhen({ tool: "web_fetch" }, { tool: "/^web_/" })).toBe(true);
    expect(matchesWhen({ tool: "exec" }, { tool: "/^web_/" })).toBe(false);
  });

  it("treats a malformed regex as matching nothing", () => {
    // The permissive reading of a broken pattern would silently widen a gate.
    expect(matchesWhen({ tool: "exec" }, { tool: "/([/" })).toBe(false);
  });

  it("does not treat an absent field as a wildcard", () => {
    expect(matchesWhen({ tool: "exec" }, { agent: "nova" })).toBe(false);
  });

  it("requires every declared field", () => {
    expect(matchesWhen({ tool: "exec", agent: "nova" }, { tool: "exec", agent: "nova" })).toBe(true);
    expect(matchesWhen({ tool: "exec", agent: "atlas" }, { tool: "exec", agent: "nova" })).toBe(false);
  });

  it("matches everything when nothing is declared", () => {
    expect(matchesWhen({ tool: "exec" }, undefined)).toBe(true);
  });
});

describe("runEventHooks", () => {
  const base = { payload: { tool: "exec" }, sessionId: "s", refusable: true };

  it("runs the tool and allows by default", async () => {
    expect(await runEventHooks({ ...base, hooks: [{ tool: "policy_check" }], tools: [says("fine")] })).toEqual({});
  });

  it("refuses when denyIf matches, using the tool's own words", async () => {
    const out = await runEventHooks({
      ...base,
      hooks: [{ tool: "policy_check", denyIf: "BLOCK" }],
      tools: [says("BLOCK: /etc is off limits")],
    });
    expect(out.deny).toBe("BLOCK: /etc is off limits");
  });

  it("ignores denyIf on an event that cannot be refused", async () => {
    const out = await runEventHooks({
      ...base,
      refusable: false,
      hooks: [{ tool: "policy_check", denyIf: "BLOCK" }],
      tools: [says("BLOCK")],
    });
    expect(out.deny).toBeUndefined();
  });

  it("skips a hook whose when does not match", async () => {
    const ran = vi.fn(async () => ({ success: true, output: "BLOCK" }) as ToolResult);
    const out = await runEventHooks({
      ...base,
      hooks: [{ tool: "policy_check", when: { tool: "read" }, denyIf: "BLOCK" }],
      tools: [tool("policy_check", ran)],
    });
    expect(ran).not.toHaveBeenCalled();
    expect(out.deny).toBeUndefined();
  });

  it("refuses when a policy hook cannot run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A check that could not run has not passed. Reading its failure as
    // approval is the exact gap #545 describes.
    const out = await runEventHooks({ ...base, hooks: [{ tool: "policy_check" }], tools: [breaks()] });
    expect(out.deny).toContain("could not run");
    expect(out.deny).toContain("upstream down");
    vi.restoreAllMocks();
  });

  it("lets a hook opt out of failing closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await runEventHooks({
      ...base,
      hooks: [{ tool: "policy_check", onError: "continue" }],
      tools: [breaks()],
    });
    expect(out.deny).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("treats a tool that reports failure as a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = tool("policy_check", async () => ({ success: false, output: "", error: "no creds" }));
    const out = await runEventHooks({ ...base, hooks: [{ tool: "policy_check" }], tools: [failing] });
    expect(out.deny).toContain("no creds");
    vi.restoreAllMocks();
  });

  it("skips a missing tool without refusing", async () => {
    // A disabled plugin or a renamed tool is a configuration problem, and it
    // should not take an unrelated operation down.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await runEventHooks({ ...base, hooks: [{ tool: "gone" }], tools: [] });
    expect(out.deny).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("stops at the first refusal", async () => {
    const second = vi.fn(async () => ({ success: true, output: "ok" }) as ToolResult);
    const out = await runEventHooks({
      ...base,
      hooks: [
        { tool: "policy_check", denyIf: "BLOCK" },
        { tool: "second", denyIf: "BLOCK" },
      ],
      tools: [says("BLOCK"), tool("second", second)],
    });
    expect(out.deny).toBe("BLOCK");
    expect(second).not.toHaveBeenCalled();
  });
});

function configWith(on: Record<string, unknown>, agent = "nova"): AgentConfig {
  return {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: {},
    agent: { defaultProvider: "openai_compatible", extraInstructions: "" },
    agents: { [agent]: { hooks: { on } } },
    channels: {},
    tools: {},
    custom_tools: {},
    commands: {},
    cron: { enabled: false, jobs: [] },
    webhooks: { enabled: false, routes: [] },
    context: { directory: "./c", kbDirectory: "./k" },
  } as unknown as AgentConfig;
}

describe("resolveEventHooks", () => {
  it("flattens every agent's declarations by event", () => {
    const config = configWith({ "agent.pre_tool_use": { tool: "policy_check" } });
    expect(resolveEventHooks(config)).toEqual([
      { agent: "nova", event: "agent.pre_tool_use", hooks: [{ tool: "policy_check" }] },
    ]);
  });

  it("accepts one hook or a list, as the fixed slots always have", () => {
    const config = configWith({ "agent.pre_tool_use": [{ tool: "a" }, { tool: "b" }] });
    expect(resolveEventHooks(config)[0].hooks).toHaveLength(2);
  });
});

function fakeRuntime(config: AgentConfig, tools: Tool[], events: TypedEventBus): AgentRuntime {
  return { events, getConfig: () => config, getTools: () => tools } as unknown as AgentRuntime;
}

describe("ConfigHooks on the bus", () => {
  it("refuses a tool call when the agent's hook says so", async () => {
    const events = new TypedEventBus();
    const config = configWith({ "agent.pre_tool_use": { tool: "policy_check", denyIf: "BLOCK" } });
    const hooks = new ConfigHooks({ runtime: fakeRuntime(config, [says("BLOCK: not that path")], events) });

    const out = await events.waterfall("agent.pre_tool_use", {
      sessionId: "s",
      projectId: null,
      agent: "nova",
      tool: "exec",
      args: {},
    });

    expect(out.deny).toBe("BLOCK: not that path");
    hooks.stop();
  });

  it("only fires for the agent that declared it", async () => {
    const events = new TypedEventBus();
    const config = configWith({ "agent.pre_tool_use": { tool: "policy_check", denyIf: "BLOCK" } });
    const hooks = new ConfigHooks({ runtime: fakeRuntime(config, [says("BLOCK")], events) });

    const out = await events.waterfall("agent.pre_tool_use", {
      sessionId: "s",
      projectId: null,
      agent: "atlas",
      tool: "exec",
      args: {},
    });

    expect(out.deny).toBeUndefined();
    hooks.stop();
  });

  it("stops listening when disposed", async () => {
    const events = new TypedEventBus();
    const config = configWith({ "agent.pre_tool_use": { tool: "policy_check", denyIf: "BLOCK" } });
    const hooks = new ConfigHooks({ runtime: fakeRuntime(config, [says("BLOCK")], events) });
    hooks.stop();

    const out = await events.waterfall("agent.pre_tool_use", {
      sessionId: "s",
      projectId: null,
      agent: "nova",
      tool: "exec",
      args: {},
    });

    expect(out.deny).toBeUndefined();
  });

  it("subscribes to a broadcast event too", async () => {
    const events = new TypedEventBus();
    const ran = vi.fn(async () => ({ success: true, output: "" }) as ToolResult);
    const config = configWith({ "agent.post_tool_use": { tool: "audit" } });
    const hooks = new ConfigHooks({ runtime: fakeRuntime(config, [tool("audit", ran)], events) });

    events.emit("agent.post_tool_use", {
      sessionId: "s",
      projectId: null,
      agent: "nova",
      tool: "exec",
      args: {},
      output: "",
      success: true,
      durationMs: 1,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(ran).toHaveBeenCalled();
    hooks.stop();
  });

  it("does not subscribe to a name that is not an event", () => {
    const events = new TypedEventBus();
    const config = configWith({ "agent.pre_tool_uses": { tool: "policy_check" } });
    // Constructing must not throw; `validateConfig` is where the user is told.
    expect(() => new ConfigHooks({ runtime: fakeRuntime(config, [], events) }).stop()).not.toThrow();
  });
});

describe("validateConfig — hooks.on", () => {
  it("says so when the event name is not real", () => {
    const warnings = validateConfig(configWith({ "agent.pre_tool_uses": { tool: "policy_check" } }));
    expect(warnings.some((w) => w.includes("will never fire"))).toBe(true);
  });

  it("guesses the name that was meant", () => {
    const warnings = validateConfig(configWith({ "loop.pre_tool_use": { tool: "policy_check" } }));
    expect(warnings.some((w) => w.includes('Did you mean "agent.pre_tool_use"'))).toBe(true);
  });

  it("says when denyIf is on an event nothing can refuse", () => {
    const warnings = validateConfig(configWith({ "agent.post_tool_use": { tool: "audit", denyIf: "BLOCK" } }));
    expect(warnings.some((w) => w.includes("cannot be refused"))).toBe(true);
  });

  it("is quiet about a correct declaration", () => {
    const warnings = validateConfig(configWith({ "agent.pre_tool_use": { tool: "policy_check", denyIf: "BLOCK" } }));
    expect(warnings.filter((w) => w.includes("hooks.on"))).toEqual([]);
  });
});
