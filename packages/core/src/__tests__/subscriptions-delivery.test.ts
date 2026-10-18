/**
 * The default delivery: what a due subscription turns into.
 *
 * A session wake is the path with no room ceiling to lean on, so its own
 * hourly ceiling is the thing worth pinning down; without it a busy event
 * stream would wake an agent as fast as events arrive.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";

const runAgentLoopMock = vi.fn();
vi.mock("../agent/loop.js", async () => {
  const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
  return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args) };
});

import type { RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import { createSubscriptionDelivery } from "../subscriptions/delivery.js";
import type { EventWakeContext } from "../subscriptions/types.js";

let db: Database.Database;
let paused: boolean;

function makeRuntime(maxWakesPerHour = 2): AgentRuntime {
  const config = {
    agents: { planner: { description: "plans" } },
    providers: { local: { defaultModel: "m" } },
    agent: { defaultProvider: "local", temperature: 0.3, maxToolRounds: 8 },
    rooms: { maxWakesPerHour },
  };
  return {
    db,
    getConfig: () => config,
    isAgentsPaused: () => paused,
    getResolvableTools: () => [],
    buildResolveOptions: () => ({}),
    contextDir: "/tmp/ctx",
    buildLoopOptions: ({ session, agentName }: { session: { id: string }; agentName?: string }) => ({
      session,
      toolContextExtras: { agentName },
    }),
  } as unknown as AgentRuntime;
}

const ctx: EventWakeContext = {
  deliver: "immediate",
  events: [{ event: "state.changed", summary: "plan/trip deleted by a person", at: new Date().toISOString() }],
};

beforeEach(() => {
  db = initDatabase(":memory:");
  paused = false;
  runAgentLoopMock.mockResolvedValue("");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  runAgentLoopMock.mockReset();
});

describe("createSubscriptionDelivery", () => {
  it("runs a session wake in the agent's own subscriptions session, saying nobody is reading it", async () => {
    const delivery = createSubscriptionDelivery({ runtime: makeRuntime(), getRoomWatcher: () => undefined });
    expect(await delivery.toSession("planner", ctx)).toBe("ran");

    const [prompt, options] = runAgentLoopMock.mock.calls[0] as [string, { session: { id: string } }];
    const row = db.prepare("SELECT key FROM sessions WHERE id = ?").get(options.session.id) as { key: string };
    expect(row.key).toBe("subscriptions:planner");
    expect(prompt).toContain("plan/trip deleted by a person");
    expect(prompt).toContain("Nobody is reading this session.");
  });

  it("holds session wakes past the hourly ceiling, and lets them through an hour later", async () => {
    let t = 0;
    const delivery = createSubscriptionDelivery({
      runtime: makeRuntime(2),
      getRoomWatcher: () => undefined,
      now: () => t,
    });
    expect(await delivery.toSession("planner", ctx)).toBe("ran");
    expect(await delivery.toSession("planner", ctx)).toBe("ran");
    expect(await delivery.toSession("planner", ctx)).toBe("at-ceiling");
    t += 3_600_001;
    expect(await delivery.toSession("planner", ctx)).toBe("ran");
    expect(runAgentLoopMock).toHaveBeenCalledTimes(3);
  });

  it("holds a session wake while agents are paused", async () => {
    paused = true;
    const delivery = createSubscriptionDelivery({ runtime: makeRuntime(), getRoomWatcher: () => undefined });
    expect(await delivery.toSession("planner", ctx)).toBe("at-ceiling");
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("hands a room delivery to the watcher, and holds it while rooms are not running", async () => {
    let watcher: RoomWatcher | undefined;
    const delivery = createSubscriptionDelivery({ runtime: makeRuntime(), getRoomWatcher: () => watcher });
    expect(await delivery.toRoom("planner", "eng", ctx)).toBe("at-ceiling");

    const runEventWake = vi.fn().mockResolvedValue("ran");
    watcher = { runEventWake } as unknown as RoomWatcher;
    expect(await delivery.toRoom("planner", "eng", ctx)).toBe("ran");
    expect(runEventWake).toHaveBeenCalledWith("planner", "eng", ctx);
  });
});
