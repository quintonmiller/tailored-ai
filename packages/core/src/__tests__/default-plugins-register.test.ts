/**
 * Default-plugin `register(ctx)` entry points — #142. Each of the four
 * builtin plugins (agent-notifier, scope-creep-flagger, stall-guard,
 * coder-project-guard) ships a `default` export that the config-driven
 * loader calls with a {@link PluginContext}. These tests cover the shared
 * contract: the plugin subscribes when a runtime is present, returns a
 * disposer that tears the subscription down, and early-returns (no-op,
 * no disposer) when `ctx.runtime` is absent.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, getProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";
import { createPluginContext, type Plugin } from "../plugin-context.js";
import agentNotifierPlugin from "../plugins/agent-notifier.js";
import coderProjectGuardPlugin from "../plugins/coder-project-guard.js";
import ownerNotifierPlugin from "../plugins/owner-notifier.js";
import scopeCreepPlugin from "../plugins/scope-creep-flagger.js";
import stallGuardPlugin from "../plugins/stall-guard.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;

function makeRuntime(events: TypedEventBus, configOver: Record<string, unknown> = {}): AgentRuntime {
  return {
    db,
    events,
    getConfig: () => ({
      agents: { coder: { description: "" }, reviewer: { description: "" } },
      taskWatcher: { delivery: { channel: "log" }, maxStallRetries: 1 },
      ...configOver,
    }),
    getOutbound: () => undefined,
    getOwnerId: () => undefined,
  } as unknown as AgentRuntime;
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const cases: Array<{ name: string; plugin: Plugin; event: string }> = [
  { name: "agent-notifier", plugin: agentNotifierPlugin, event: "agent.completed" },
  { name: "scope-creep-flagger", plugin: scopeCreepPlugin, event: "agent.completed" },
  { name: "stall-guard", plugin: stallGuardPlugin, event: "agent.stalled" },
  { name: "coder-project-guard", plugin: coderProjectGuardPlugin, event: "agent.dispatched" },
];

describe("default plugins — register(ctx) contract", () => {
  for (const { name, plugin, event } of cases) {
    describe(name, () => {
      it("subscribes to its event when ctx.runtime is present", async () => {
        const events = new TypedEventBus();
        const runtime = makeRuntime(events);
        const ctx = createPluginContext({ runtime, events });
        expect(events.listenerCount(event as never)).toBe(0);
        await plugin(ctx);
        expect(events.listenerCount(event as never)).toBe(1);
      });

      it("returns a disposer that removes the subscription", async () => {
        const events = new TypedEventBus();
        const runtime = makeRuntime(events);
        const ctx = createPluginContext({ runtime, events });
        const stop = await plugin(ctx);
        expect(typeof stop).toBe("function");
        await (stop as () => void)();
        expect(events.listenerCount(event as never)).toBe(0);
      });

      it("no-ops (no subscription, no disposer) when ctx.runtime is absent", async () => {
        const events = new TypedEventBus();
        const ctx = createPluginContext({ events }); // no runtime
        const stop = await plugin(ctx);
        expect(stop).toBeUndefined();
        expect(events.listenerCount(event as never)).toBe(0);
      });
    });
  }
});

describe("owner-notifier — register(ctx) contract", () => {
  const OWNER_EVENTS = ["task.needs_human", "digest.ready", "question.asked", "form.completed"] as const;

  it("subscribes to all owner-delivery events when ctx.runtime is present", async () => {
    const events = new TypedEventBus();
    const runtime = makeRuntime(events);
    const ctx = createPluginContext({ runtime, events });
    const stop = await ownerNotifierPlugin(ctx);
    for (const ev of OWNER_EVENTS) expect(events.listenerCount(ev)).toBe(1);
    expect(typeof stop).toBe("function");
    await (stop as () => void)();
    for (const ev of OWNER_EVENTS) expect(events.listenerCount(ev)).toBe(0);
  });

  it("no-ops when ctx.runtime is absent", async () => {
    const events = new TypedEventBus();
    const ctx = createPluginContext({ events }); // no runtime
    const stop = await ownerNotifierPlugin(ctx);
    expect(stop).toBeUndefined();
    for (const ev of OWNER_EVENTS) expect(events.listenerCount(ev)).toBe(0);
  });
});

describe("stall-guard — reads maxStallRetries from ctx.config", () => {
  it("uses the per-plugin config override instead of taskWatcher.maxStallRetries", async () => {
    const events = new TypedEventBus();
    // taskWatcher cap is 0 (never retry); the plugin config raises it to 2,
    // so a first stall takes the retry path and does NOT block the task.
    const runtime = makeRuntime(events, { taskWatcher: { maxStallRetries: 0 } });
    const ctx = createPluginContext({ runtime, events, config: { maxStallRetries: 2 } });
    const stop = await stallGuardPlugin(ctx);

    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    events.emit("agent.stalled", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      response: "[Agent stopped: x]",
      stallReason: "x",
      worktree: undefined,
    } as never);
    await Promise.resolve();
    await Promise.resolve();

    const after = getProjectTask(db, task.id);
    expect(after?.status).not.toBe("blocked"); // retry path, not blocked
    await (stop as () => void)();
  });
});
