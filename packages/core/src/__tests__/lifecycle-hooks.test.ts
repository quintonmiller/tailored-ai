/**
 * Lifecycle hooks: the phases, the capability tiers, and the script handler.
 *
 * The failure these guard against is specific and has happened repeatedly here:
 * a hook that parses, validates, binds, and never runs. `runEventHooks` treats
 * an unregistered handler kind as *absent, not failed* — it logs and continues —
 * so without a tier check a `tool` hook on `tai:init:start` would resolve to
 * nothing and report success. Every test below that looks pedantic is aimed at
 * that.
 */

import { describe, expect, it, vi } from "vitest";
import {
  eventHookHandlerTier,
  listEventHookHandlers,
  registerEventHookHandler,
  runEventHooks,
  runLifecycleHooks,
} from "../agent/event-hooks.js";
import {
  isLifecycleEvent,
  isRefusableLifecycleEvent,
  LIFECYCLE_EVENTS,
  lifecycleTier,
  tierSatisfies,
} from "../agent/lifecycle.js";
import { payloadEnv, registerScriptHookHandler } from "../agent/script-hook.js";
import type { AgentConfig } from "../config.js";
import { validateConfig } from "../config.js";

/**
 * A config complete enough for `validateConfig` to walk. Mirrors the fixture in
 * `config-hooks.test.ts` — the validator reads several blocks unconditionally,
 * so a config missing them throws before it reaches anything worth asserting.
 */
function baseConfig(): Record<string, unknown> {
  return {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: {},
    agent: { defaultProvider: "openai_compatible", extraInstructions: "" },
    agents: {},
    channels: {},
    tools: {},
    custom_tools: {},
    commands: {},
    cron: { enabled: false, jobs: [] },
    webhooks: { enabled: false, routes: [] },
    context: { directory: "./c", kbDirectory: "./k" },
  };
}

/** Deployment-level `hooks.on`, which is where a lifecycle hook belongs. */
function configWith(on: Record<string, unknown>, extra: Record<string, unknown> = {}): AgentConfig {
  return { ...baseConfig(), hooks: { on, ...extra } } as unknown as AgentConfig;
}

describe("lifecycle phases", () => {
  it("names four events", () => {
    expect([...LIFECYCLE_EVENTS]).toEqual(["tai:init:start", "tai:init:end", "tai:shutdown:start", "tai:shutdown:end"]);
  });

  it("is symmetric: the outer two have no runtime, the inner two do", () => {
    expect(lifecycleTier("tai:init:start")).toBe("process");
    expect(lifecycleTier("tai:shutdown:end")).toBe("process");
    expect(lifecycleTier("tai:init:end")).toBe("runtime");
    expect(lifecycleTier("tai:shutdown:start")).toBe("runtime");
  });

  it("lets only init:start refuse", () => {
    // A hook that could veto a stop would make an instance unstoppable, which
    // is a worse failure than whatever it was protecting.
    expect(isRefusableLifecycleEvent("tai:init:start")).toBe(true);
    for (const e of ["tai:init:end", "tai:shutdown:start", "tai:shutdown:end"] as const) {
      expect(isRefusableLifecycleEvent(e)).toBe(false);
    }
  });

  it("recognises its own names and nothing else", () => {
    expect(isLifecycleEvent("tai:init:start")).toBe(true);
    expect(isLifecycleEvent("agent.pre_tool_use")).toBe(false);
  });
});

describe("capability tiers", () => {
  it("a runtime phase satisfies everything; a process phase only process", () => {
    expect(tierSatisfies("runtime", "runtime")).toBe(true);
    expect(tierSatisfies("runtime", "process")).toBe(true);
    expect(tierSatisfies("process", "process")).toBe(true);
    expect(tierSatisfies("process", "runtime")).toBe(false);
  });

  it("defaults an undeclared handler to runtime", () => {
    // Conservative on purpose: a handler that has not thought about it is
    // excluded from the early phases rather than run there and failing
    // obscurely.
    const dispose = registerEventHookHandler("tier-test-undeclared", async () => ({}));
    expect(eventHookHandlerTier("tier-test-undeclared")).toBe("runtime");
    dispose();
    expect(eventHookHandlerTier("tier-test-undeclared")).toBeUndefined();
  });

  it("refuses a runtime handler at a process phase, and does not call it", async () => {
    const handler = vi.fn(async () => ({ output: "ran" }));
    const dispose = registerEventHookHandler("tier-test-runtime", handler, { requires: "runtime" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runEventHooks({
        event: "tai:init:start",
        hooks: [{ type: "tier-test-runtime" }],
        payload: {},
        tools: [],
        sessionId: "t",
        refusable: true,
        tier: "process",
      });
      expect(handler).not.toHaveBeenCalled();
      expect(err.mock.calls.flat().join(" ")).toContain("needs the runtime to exist");
    } finally {
      err.mockRestore();
      dispose();
    }
  });

  it("runs a process handler at both phases", async () => {
    const handler = vi.fn(async () => ({ output: "ran" }));
    const dispose = registerEventHookHandler("tier-test-process", handler, { requires: "process" });
    try {
      for (const tier of ["process", "runtime"] as const) {
        await runEventHooks({
          event: "tai:init:start",
          hooks: [{ type: "tier-test-process" }],
          payload: {},
          tools: [],
          sessionId: "t",
          refusable: false,
          tier,
        });
      }
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  });

  it("lists only the kinds usable in a phase, so an error names a real option", () => {
    const dispose = registerScriptHookHandler();
    try {
      expect(listEventHookHandlers("process")).toContain("script");
      // `tool` needs a registry, so it is not on offer before one exists.
      expect(listEventHookHandlers("process")).not.toContain("tool");
      expect(listEventHookHandlers("runtime")).toContain("tool");
    } finally {
      dispose();
    }
  });
});

describe("runLifecycleHooks", () => {
  it("reads the deployment's hooks, not an agent's", async () => {
    const handler = vi.fn(async () => ({}));
    const dispose = registerEventHookHandler("lifecycle-scope-test", handler, { requires: "process" });
    try {
      const config = {
        hooks: { on: { "tai:init:start": [{ type: "lifecycle-scope-test" }] } },
        agents: { someone: { hooks: { on: { "tai:init:start": [{ type: "lifecycle-scope-test" }] } } } },
      } as unknown as AgentConfig;
      await runLifecycleHooks({ event: "tai:init:start", config });
      // Once, from the top level. The agent-scoped copy has no agent to match
      // against at this phase and must not double-fire.
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("returns a refusal from init:start and carries the reason", async () => {
    const dispose = registerEventHookHandler("lifecycle-deny-test", async () => ({ deny: "no GPU" }), {
      requires: "process",
    });
    try {
      const verdict = await runLifecycleHooks({
        event: "tai:init:start",
        config: configWith({ "tai:init:start": [{ type: "lifecycle-deny-test" }] }),
      });
      expect(verdict.deny).toBe("no GPU");
    } finally {
      dispose();
    }
  });

  it("ignores a refusal at shutdown, because a stop must not be vetoable", async () => {
    const dispose = registerEventHookHandler("lifecycle-deny-test-2", async () => ({ deny: "please no" }), {
      requires: "process",
    });
    try {
      const verdict = await runLifecycleHooks({
        event: "tai:shutdown:end",
        config: configWith({ "tai:shutdown:end": [{ type: "lifecycle-deny-test-2" }] }),
      });
      expect(verdict.deny).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("does nothing when nothing is declared", async () => {
    const verdict = await runLifecycleHooks({ event: "tai:init:start", config: configWith({}) });
    expect(verdict).toEqual({});
  });
});

describe("the script handler", () => {
  it("is not registered until asked for", () => {
    // The gate: a registered `script` kind hands config the ability to run
    // arbitrary programs, so it must not appear merely because core imported.
    expect(eventHookHandlerTier("script")).toBeUndefined();
  });

  it("passes the payload as environment, and omits absent values", () => {
    const env = payloadEnv("tai:init:start", { agentName: "iris", count: 3, nothing: null, obj: { a: 1 } });
    expect(env.TAI_HOOK_EVENT).toBe("tai:init:start");
    expect(env.TAI_AGENT_NAME).toBe("iris");
    expect(env.TAI_COUNT).toBe("3");
    expect(env.TAI_OBJ).toBe('{"a":1}');
    // Not the string "null" — a value that reads as present is how a shell
    // script takes the wrong branch.
    expect("TAI_NOTHING" in env).toBe(false);
  });

  it("treats exit 0 as pass and a non-zero exit as a refusal", async () => {
    const dispose = registerScriptHookHandler();
    try {
      const ok = await runLifecycleHooks({
        event: "tai:init:start",
        config: configWith({
          "tai:init:start": [{ type: "script", options: { command: "sh", args: ["-c", "exit 0"] } }],
        }),
      });
      expect(ok.deny).toBeUndefined();

      const denied = await runLifecycleHooks({
        event: "tai:init:start",
        config: configWith({
          "tai:init:start": [{ type: "script", options: { command: "sh", args: ["-c", "echo nope >&2; exit 3"] } }],
        }),
      });
      expect(denied.deny).toContain("nope");
    } finally {
      dispose();
    }
  });

  it("does not fault the process when the program ignores its input", async () => {
    // #606: writing a payload to a child's stdin raises an unhandled EPIPE when
    // the child exits without reading. This handler passes the payload as
    // environment and never opens stdin, so a program that ignores it — the
    // most ordinary kind of hook — cannot take the runtime down.
    const dispose = registerScriptHookHandler();
    try {
      const verdict = await runLifecycleHooks({
        event: "tai:init:start",
        config: configWith({ "tai:init:start": [{ type: "script", options: { command: "true" } }] }),
      });
      expect(verdict.deny).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("reports a program that cannot be run as absent, never as a refusal", async () => {
    // A typo in a path must not block the thing the hook was meant to guard: a
    // hook that never executed never had a verdict to give.
    const dispose = registerScriptHookHandler();
    try {
      const verdict = await runLifecycleHooks({
        event: "tai:init:start",
        config: configWith({
          "tai:init:start": [{ type: "script", options: { command: "/nonexistent/definitely-not-here" } }],
        }),
      });
      expect(verdict.deny).toBeUndefined();
    } finally {
      dispose();
    }
  });
});

describe("validateConfig", () => {
  it("warns when a tool hook is declared at a phase with no runtime", () => {
    const warnings = validateConfig(configWith({ "tai:init:start": [{ tool: "notify_owner" }] }));
    expect(warnings.join("\n")).toContain("fires before the runtime exists");
  });

  it("accepts a script hook at that same phase", () => {
    const warnings = validateConfig(
      configWith({ "tai:init:start": [{ type: "script", options: { command: "/bin/true" } }] }),
    );
    expect(warnings.join("\n")).not.toContain("fires before the runtime exists");
  });

  it("accepts a tool hook at a phase that has a runtime", () => {
    const warnings = validateConfig(configWith({ "tai:shutdown:start": [{ tool: "notify_owner" }] }));
    expect(warnings.join("\n")).not.toContain("fires before the runtime exists");
  });

  it("warns when a lifecycle hook is declared under an agent", () => {
    const config = {
      ...baseConfig(),
      agents: { someone: { hooks: { on: { "tai:init:start": [{ type: "script", options: { command: "x" } }] } } } },
    } as unknown as AgentConfig;
    expect(validateConfig(config).join("\n")).toContain("belongs to the deployment, not to an agent");
  });

  it("does not report a lifecycle event as an unknown event", () => {
    const warnings = validateConfig(
      configWith({ "tai:shutdown:end": [{ type: "script", options: { command: "x" } }] }),
    );
    expect(warnings.join("\n")).not.toContain("is not a runtime event");
  });
});
