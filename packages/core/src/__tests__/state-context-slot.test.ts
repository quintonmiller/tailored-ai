/**
 * Pinned state in the prompt: an agent's `state.context` queries, run every
 * turn as that agent and rendered behind the history.
 *
 * The property that matters most is that the slot shows exactly what the
 * agent could have read with the `state` tool — its own scope, the rooms the
 * turn is about, the project, global — and nothing else. A broken query is
 * left out and logged once, and never takes the rest of the prompt with it.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgent } from "../agent/agents.js";
import type { ContextSlotContext } from "../agent/context-slots.js";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams } from "../providers/interface.js";
import { WAKE_ROOMS_KEY } from "../rooms/keys.js";
import { AgentRuntime } from "../runtime.js";
import { resetStateSlotWarnings, stateContextSlot } from "../state/context-slot.js";
import { type StateCaller, type StateConfig, StateService } from "../state/service.js";
import type { StateContextQuery } from "../state/types.js";

const stateConfig: StateConfig = {
  backend: "sqlite",
  types: [
    {
      name: "plan",
      title: "name",
      schema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, status: { type: "string" } },
      },
    },
    { name: "note" },
    { name: "secret", access: { read: ["someone-else"] } },
  ],
};

const system: StateCaller = { actor: { kind: "system", name: "test" } };

let service: StateService;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  service = new StateService({ getConfig: () => ({ state: stateConfig }), db: new Database(":memory:") });
  resetStateSlotWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await service.close();
  vi.restoreAllMocks();
});

const ctx = (over: Partial<ContextSlotContext> = {}): ContextSlotContext => ({
  agent: "planner",
  projectId: null,
  sessionId: "s1",
  userMessage: "go",
  ...over,
});

const render = async (queries: StateContextQuery[], c = ctx()) =>
  String(await stateContextSlot(() => service, queries).render(c));

const put = (type: string, data: Record<string, unknown>, scope = "global", id?: string) =>
  service.put(system, { type, data, scope, ...(id ? { id } : {}) });

describe("state context slot", () => {
  it("renders the records a query matches, under a line naming the query", async () => {
    await put("plan", { name: "Trip", status: "active" }, "global", "trip");
    await put("plan", { name: "Move", status: "draft" }, "global", "move");

    expect(await render([{ type: "plan", where: { status: "active" } }])).toBe(
      'plan where {"status":"active"}:\n1 plan record(s):\n- trip "Trip" (version 1, global): {"name":"Trip","status":"active"}',
    );
  });

  it("says when nothing matches, so the agent need not go and check", async () => {
    expect(await render([{ type: "plan", where: { status: "active" } }])).toBe(
      'plan where {"status":"active"}:\nNo plan records match.',
    );
  });

  it("shows only what the agent could read: its own scope, the turn's rooms, the project, global", async () => {
    await put("note", { text: "mine" }, "agent:planner");
    await put("note", { text: "another agent's" }, "agent:other");
    await put("note", { text: "this room" }, "room:local:eng");
    await put("note", { text: "another room" }, "room:local:ops");
    await put("note", { text: "this project" }, "project:p1");
    await put("note", { text: "everyone's" }, "global");

    const text = await render([{ type: "note" }], ctx({ rooms: ["local:eng"], projectId: "p1" }));
    for (const seen of ["mine", "this room", "this project", "everyone's"]) expect(text).toContain(seen);
    for (const hidden of ["another agent's", "another room"]) expect(text).not.toContain(hidden);

    const outsideRoom = await render([{ type: "note" }]);
    expect(outsideRoom).not.toContain("this room");
  });

  it("caps each query and says there may be more", async () => {
    for (const name of ["a", "b", "c"]) await put("plan", { name }, "global", name);

    const text = await render([{ type: "plan", orderBy: "name", limit: 2 }]);
    expect(text).toBe(
      'plan by name:\n2 plan record(s):\n- a "a" (version 1, global): {"name":"a"}\n- b "b" (version 1, global): {"name":"b"}\nShowing the first 2; there may be more.',
    );
  });

  it("leaves out a query that fails, says so once in the log, and renders the rest", async () => {
    await put("plan", { name: "Trip" }, "global", "trip");
    const queries: StateContextQuery[] = [{ type: "nope" }, { type: "secret" }, { type: "plan" }];

    const first = await render(queries);
    await render(queries);

    expect(first).toBe('plan:\n1 plan record(s):\n- trip "Trip" (version 1, global): {"name":"Trip"}');
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged.filter((l) => l.includes("pinned nope query failed"))).toHaveLength(1);
    expect(logged.filter((l) => l.includes("pinned secret query failed"))).toHaveLength(1);
  });
});

describe("state.context config", () => {
  const base = {
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
    agent: { defaultProvider: "openai_compatible", maxToolRounds: 1, temperature: 0.3, extraInstructions: "" },
  };

  it("is inherited from agent.defaults, and replaced whole by an agent's own", () => {
    const inherited: StateContextQuery[] = [{ type: "plan" }];
    const own: StateContextQuery[] = [{ type: "note", limit: 3 }];
    const config = {
      ...base,
      agent: { ...base.agent, defaults: { state: { context: inherited } } },
      agents: { planner: {}, writer: { state: { context: own } } },
    } as unknown as AgentConfig;

    expect(resolveAgent("planner", config, []).stateContext).toEqual(inherited);
    expect(resolveAgent("writer", config, []).stateContext).toEqual(own);
    expect(resolveAgent(undefined, { ...base, agents: {} } as unknown as AgentConfig, []).stateContext).toBeUndefined();
  });

  it("puts an agent's pinned records in its turn's prompt, scoped to the rooms it was woken for", async () => {
    const db = initDatabase(":memory:");
    const config = {
      server: { port: 3000, host: "127.0.0.1" },
      database: { path: ":memory:" },
      ...base,
      agent: { ...base.agent, maxHistoryTokens: 5000 },
      agents: { planner: { state: { context: [{ type: "note" }] } } },
      channels: {},
      tools: {},
      custom_tools: {},
      cron: { enabled: false, jobs: [] },
      context: { directory: "./data/context", kbDirectory: "./data/kb" },
      prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
      permissions: { allow: [], deny: [], ask: [] },
      workflows: { directory: "./workflows" },
      projects: { enabled: false, directory: "./data/projects" },
      tasks: { backend: "native" as const },
      state: stateConfig,
    } as never;
    const seen: ChatParams[] = [];
    const provider: AIProvider = {
      name: "fake",
      chat: async (params: ChatParams) => {
        seen.push(params);
        return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
    } as never;
    const runtime = new AgentRuntime(
      {
        configPath: "/dev/null",
        db,
        contextDir: "/tmp",
        kbDir: "/tmp",
        createTools: () => [],
        createProvider: () => ({ provider, model: "x" }),
      },
      () => config,
      config,
    );
    const writer: StateCaller = { actor: { kind: "system", name: "test" } };
    await runtime
      .getStateService()
      .put(writer, { type: "note", data: { text: "room-eng-note" }, scope: "room:local:eng" });
    await runtime
      .getStateService()
      .put(writer, { type: "note", data: { text: "room-ops-note" }, scope: "room:local:ops" });

    const session = newSession(db, "x", "openai_compatible");
    const opts = runtime.buildLoopOptions({ session, agentName: "planner" });
    await runAgentLoop("go", {
      ...opts,
      toolContextExtras: { ...opts.toolContextExtras, workingMemory: new Map([[WAKE_ROOMS_KEY, "local:eng"]]) },
    });

    const prompt = JSON.stringify(seen[0].messages);
    expect(prompt).toContain("## Current state");
    expect(prompt).toContain("room-eng-note");
    expect(prompt).not.toContain("room-ops-note");
    db.close();
  });
});
