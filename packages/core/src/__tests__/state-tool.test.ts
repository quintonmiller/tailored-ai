/**
 * The `state` tool: what an agent actually sees.
 *
 * Mostly output and failure wording, because that is the interface a model
 * works through. Also the tool's presence: it should not cost every agent its
 * schema in the prompt until something can be stored.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { WAKE_ROOMS_KEY } from "../rooms/watcher.js";
import { registerStateType } from "../state/registry.js";
import { type StateConfig, StateService } from "../state/service.js";
import "../tools/builtin.js";
import type { ToolContext } from "../tools/interface.js";
import { StateTool } from "../tools/state.js";
import { toolFactoryRegistry } from "../tools/tool-factories.js";

const config: { state: StateConfig } = {
  state: {
    backend: "sqlite",
    types: [
      {
        name: "plan",
        description: "A plan someone is working through.",
        scope: "room",
        title: "name",
        schema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, status: { type: "string", enum: ["draft", "active", "done"] } },
        },
      },
      { name: "ledger", access: { read: ["*"], write: ["someone-else"] } },
    ],
  },
};

function context(agentName = "planner", rooms = "local:eng"): ToolContext {
  return {
    sessionId: "s1",
    workingDirectory: "/tmp",
    env: {},
    agentName,
    workingMemory: new Map(rooms ? [[WAKE_ROOMS_KEY, rooms]] : []),
  };
}

describe("state tool", () => {
  let service: StateService;
  let tool: StateTool;
  const run = (args: Record<string, unknown>, ctx = context()) => tool.execute(args, ctx);

  beforeEach(() => {
    service = new StateService({ getConfig: () => config, db: new Database(":memory:") });
    tool = new StateTool(() => service);
  });

  afterEach(async () => {
    await service.close();
  });

  it("lists types as fields a model can read, and says what this agent may do", async () => {
    const res = await run({ action: "types" });
    expect(res.success).toBe(true);
    expect(res.output).toBe(
      [
        "- ledger",
        "  fields: any fields",
        "  new records go in shared by everyone; you can only read",
        "- plan: A plan someone is working through.",
        "  fields: name (string, required), status (draft | active | done)",
        "  new records go in the room you are in; you can read and write",
      ].join("\n"),
    );
  });

  it("creates, reads, queries, patches and deletes", async () => {
    const created = await run({ action: "put", type: "plan", data: { name: "Trip", status: "draft" } });
    expect(created.output).toMatch(/^Saved plan\/trip-[0-9a-f]{4} \(version 1, scope room:local:eng\)\.$/);
    const id = created.output.match(/plan\/(\S+) /)?.[1] as string;

    const got = await run({ action: "get", type: "plan", id });
    expect(got.output).toContain(`plan/${id} (version 1, scope room:local:eng, updated `);
    expect(got.output).toContain('{"name":"Trip","status":"draft"}');

    const patched = await run({ action: "patch", type: "plan", id, data: { status: "active" } });
    expect(patched.output).toBe(`Updated plan/${id} (version 2).`);

    const listed = await run({ action: "query", type: "plan", where: { status: "active" } });
    expect(listed.output).toBe(
      `1 plan record(s):\n- ${id} "Trip" (version 2, room:local:eng): {"name":"Trip","status":"active"}`,
    );

    expect((await run({ action: "delete", type: "plan", id })).output).toBe(`Deleted plan/${id}. Its history is kept.`);
    expect((await run({ action: "query", type: "plan" })).output).toBe("No plan records match.");
  });

  it("accepts data and conditions sent as JSON strings, as small models often do", async () => {
    const res = await run({ action: "put", type: "plan", id: "trip", data: '{"name": "Trip"}' });
    expect(res.success).toBe(true);
    const listed = await run({ action: "query", type: "plan", where: '{"name": "Trip"}' });
    expect(listed.output).toContain("1 plan record(s)");
  });

  it("hands back invalid data as a correction, not a schema dump", async () => {
    const res = await run({ action: "put", type: "plan", id: "trip", data: { status: "finished" } });
    expect(res.success).toBe(false);
    expect(res.error).toBe(
      'plan/trip was not saved:\n- `name` is required\n- `status` must be one of: draft, active, done (got "finished")',
    );
  });

  it("tells the agent how to recover from a version conflict", async () => {
    await run({ action: "put", type: "plan", id: "trip", data: { name: "Trip" } });
    const res = await run({ action: "patch", type: "plan", id: "trip", data: { status: "done" }, expectedVersion: 5 });
    expect(res.error).toBe(
      'plan/trip is at version 1, but the write expected version 5. Read it again with action "get", then make your change against what is there now.',
    );
  });

  it("says what is missing rather than failing obscurely", async () => {
    expect((await run({ action: "get", type: "plan" })).error).toBe("get needs the record's `id`.");
    expect((await run({ action: "query" })).error).toBe(
      'Say which type with `type`. Use action "types" to see what exists.',
    );
    expect((await run({ action: "fly" })).error).toBe(
      'Unknown action "fly". Use one of: types, get, query, put, patch, delete.',
    );
    expect((await run({ action: "get", type: "plans", id: "x" })).error).toBe(
      'There is no state type called "plans". Types you can use: ledger, plan.',
    );
    expect((await run({ action: "put", type: "ledger", data: { total: 1 } })).error).toBe(
      "You can read ledger records but not change them.",
    );
  });

  it("takes the caller's identity from the context, so it cannot write as another agent", async () => {
    await run({ action: "put", type: "plan", id: "trip", data: { name: "Trip" } });
    const stranger = await run({ action: "get", type: "plan", id: "trip" }, context("reviewer", ""));
    expect(stranger.error).toBe('There is no plan record with id "trip".');
  });
});

describe("state tool factory", () => {
  const factory = toolFactoryRegistry.get("state");
  const baseConfig = (state: StateConfig | undefined, enabled = true) =>
    ({ tools: { state: { enabled } }, ...(state ? { state } : {}) }) as unknown as AgentConfig;
  const service = new StateService({ getConfig: () => config, db: new Database(":memory:") });
  const ctx = { getStateService: () => service };
  const disposers: (() => void)[] = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("is registered", () => {
    expect(factory).toBeDefined();
  });

  it("is not offered while there is no type to store anything in", () => {
    expect(factory?.(baseConfig({ backend: "sqlite" }), ctx)).toEqual([]);
  });

  it("is offered once config declares a type, or a plugin does", () => {
    expect(factory?.(baseConfig(config.state), ctx).map((t) => t.name)).toEqual(["state"]);
    disposers.push(registerStateType({ name: "bookmark" }));
    expect(factory?.(baseConfig({ backend: "sqlite" }), ctx).map((t) => t.name)).toEqual(["state"]);
  });

  it("is withheld when turned off", () => {
    expect(factory?.(baseConfig(config.state, false), ctx)).toEqual([]);
  });
});
