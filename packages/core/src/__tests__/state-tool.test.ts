/**
 * The `state` tool: what an agent actually sees.
 *
 * Mostly output and failure wording, because that is the interface a model
 * works through. Also the tool's presence: it should not cost every agent its
 * schema in the prompt until something can be stored.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { WAKE_ROOMS_KEY } from "../rooms/watcher.js";
import { registerStateProvider, registerStateType } from "../state/registry.js";
import { type StateConfig, StateService } from "../state/service.js";
import { SqliteStateProvider } from "../state/sqlite-provider.js";
import "../tools/builtin.js";
import { declaredEffectOf } from "../tools/effect.js";
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

  it("says which calls only read, so a policy that lets reads through can tell", () => {
    for (const action of ["types", "get", "query", "search", "GET"])
      expect(declaredEffectOf(tool, { action })).toBe("read");
    // Anything else may change a record, an action it doesn't know included.
    for (const action of ["put", "patch", "delete", "archive", "unarchive", "nonsense", undefined]) {
      expect(declaredEffectOf(tool, { action })).toBe("write");
    }
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

  it("archives a record out of queries, finds it again on request, and brings it back", async () => {
    await run({ action: "put", type: "plan", id: "trip", data: { name: "Trip" } });
    await run({ action: "put", type: "plan", id: "move", data: { name: "Move" } });

    const archived = await run({ action: "archive", type: "plan", id: "trip", reason: "the trip is over" });
    expect(archived.output).toBe('Archived plan/trip. Queries leave it out now; action "unarchive" brings it back.');
    expect((await run({ action: "query", type: "plan" })).output).toBe(
      '1 plan record(s):\n- move "Move" (version 1, room:local:eng): {"name":"Move"}',
    );
    const all = await run({ action: "query", type: "plan", includeArchived: true, orderBy: "id" });
    expect(all.output).toBe(
      [
        "2 plan record(s):",
        '- move "Move" (version 1, room:local:eng): {"name":"Move"}',
        '- trip "Trip" (version 2, room:local:eng, archived): {"name":"Trip"}',
      ].join("\n"),
    );
    const got = await run({ action: "get", type: "plan", id: "trip" });
    expect(got.output).toMatch(/\nArchived \S+ by planner: the trip is over\. Action "unarchive" brings it back\.\n/);

    expect((await run({ action: "unarchive", type: "plan", id: "trip" })).output).toBe(
      "plan/trip is back (version 3).",
    );
    expect((await run({ action: "query", type: "plan" })).output).toContain("2 plan record(s)");
    // Asked again, it says nothing changed, and nothing does.
    expect((await run({ action: "unarchive", type: "plan", id: "trip" })).output).toBe(
      "plan/trip isn't archived; nothing to do.",
    );
    expect((await run({ action: "get", type: "plan", id: "trip" })).output).toMatch(/\(version 3,/);
  });

  it("asks for an id to archive, and says when there is nothing to archive", async () => {
    expect((await run({ action: "archive", type: "plan" })).error).toBe("archive needs the record's `id`.");
    expect((await run({ action: "unarchive", type: "plan", id: "nope" })).error).toBe(
      'There is no plan record with id "nope" to unarchive.',
    );
  });

  it("tells an agent patching an archived record how to change it", async () => {
    await run({ action: "put", type: "plan", id: "trip", data: { name: "Trip" } });
    await run({ action: "archive", type: "plan", id: "trip" });
    expect((await run({ action: "patch", type: "plan", id: "trip", data: { status: "done" } })).error).toBe(
      "plan/trip is archived. Unarchive it before changing it.",
    );
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
      'Unknown action "fly". Use one of: types, get, query, put, patch, delete, archive, unarchive.',
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

describe("state tool search", () => {
  const searchConfig: { state: StateConfig } = {
    state: {
      backend: "sqlite",
      types: [
        { name: "doc", title: "title", search: { fields: ["title", "summary"] } },
        { name: "commitment", title: "goal", scope: "agent", search: { fields: ["goal"] } },
        { name: "plan", title: "name" },
      ],
    },
  };
  let service: StateService;
  let tool: StateTool;
  const run = (args: Record<string, unknown>, ctx = context()) => tool.execute(args, ctx);

  beforeEach(() => {
    service = new StateService({ getConfig: () => searchConfig, db: new Database(":memory:") });
    tool = new StateTool(() => service);
  });

  afterEach(async () => {
    await service.close();
  });

  it("lists matches closest first, one line each, saying how each matched", async () => {
    await run({
      action: "put",
      type: "doc",
      id: "hotels",
      data: { title: "Hotel shortlist", summary: "Lisbon, old town" },
    });
    await run({ action: "put", type: "doc", id: "prefs", data: { title: "Travel preferences", summary: "Hotels" } });
    await run({ action: "put", type: "plan", id: "trip", data: { name: "Hotel in Lisbon" } });

    const res = await run({ action: "search", text: "hotel in Lisbon" });
    expect(res.success).toBe(true);
    const lines = res.output.split("\n");
    expect(lines[0]).toBe('2 match(es) for "hotel in Lisbon", closest first:');
    expect(lines[1]).toMatch(
      /^- doc\/hotels "Hotel shortlist" \(words 1\.00, version 1, global, updated \S+ by planner\): \{"title":"Hotel shortlist","summary":"Lisbon, old town"\}$/,
    );
    expect(lines[2]).toMatch(/^- doc\/prefs "Travel preferences" \(words 0\.\d\d, /);
  });

  it("narrows to the types named, comma-separated or as a list", async () => {
    await run({ action: "put", type: "doc", id: "d", data: { title: "Hotel in Lisbon" } });
    await run({ action: "put", type: "commitment", id: "c", data: { goal: "Book a hotel in Lisbon" } });
    expect((await run({ action: "search", text: "hotel", type: "commitment" })).output).toContain("commitment/c");
    expect((await run({ action: "search", text: "hotel", type: "commitment" })).output).not.toContain("doc/d");
    expect((await run({ action: "search", text: "hotel", type: "doc, commitment" })).output).toContain("2 match(es)");
    expect((await run({ action: "search", text: "hotel", types: ["doc"] })).output).toContain("1 match(es)");
  });

  it("says what it searched when nothing matches, and what is missing or unsearchable", async () => {
    expect((await run({ action: "search", text: "hotel" })).output).toBe(
      'Nothing matches "hotel" (searched commitment, doc).',
    );
    expect((await run({ action: "search" })).error).toBe(
      'search needs `text`: what to look for, e.g. "hotel prices in Lisbon".',
    );
    expect((await run({ action: "search", text: "hotel", type: "plan" })).error).toBe(
      "plan records are not searchable. Searchable types: commitment, doc.",
    );
  });

  it("tells an agent when nothing it can read is searchable", async () => {
    const plain = new StateService({ getConfig: () => config, db: new Database(":memory:") });
    const plainTool = new StateTool(() => plain);
    expect((await plainTool.execute({ action: "search", text: "hotel" }, context())).error).toBe(
      'None of the types you can read are searchable. Use action "query" to filter records by field instead.',
    );
    await plain.close();
  });

  it("shows which fields a type is searchable by", async () => {
    expect((await run({ action: "types" })).output).toContain(
      "- doc\n  fields: any fields\n  searchable by: title, summary\n",
    );
  });

  it("offers search only while some type opts in, and picks up one that does later", async () => {
    const live: { state: StateConfig } = { state: { backend: "sqlite", types: [{ name: "plan" }] } };
    const later = new StateService({ getConfig: () => live, db: new Database(":memory:") });
    const laterTool = new StateTool(() => later);
    const actions = () => (laterTool.parameters.properties as { action: { enum: string[] } }).action.enum;
    const props = () => Object.keys(laterTool.parameters.properties as object);
    expect(actions()).not.toContain("search");
    expect(props()).not.toContain("text");
    expect((await laterTool.execute({ action: "fly" }, context())).error).not.toContain("search");

    live.state.types = [{ name: "plan" }, { name: "doc", search: { fields: ["title"] } }];
    expect(actions()).toContain("search");
    expect(props()).toContain("text");
    expect((await laterTool.execute({ action: "fly" }, context())).error).toBe(
      'Unknown action "fly". Use one of: types, search, get, query, put, patch, delete, archive, unarchive.',
    );
    await later.close();
  });

  it("lists types, and counts none as searchable, when `search.fields` is malformed", async () => {
    const odd: { state: StateConfig } = {
      state: { backend: "sqlite", types: [{ name: "brief", search: { fields: "title" as unknown as string[] } }] },
    };
    const oddService = new StateService({ getConfig: () => odd, db: new Database(":memory:") });
    const oddTool = new StateTool(() => oddService);
    const res = await oddTool.execute({ action: "types" }, context());
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("searchable by");
    expect((await oddTool.execute({ action: "search", text: "hotel" }, context())).error).toContain(
      "None of the types you can read are searchable.",
    );
    await oddService.close();
  });

  it("says which types it couldn't read in full, so a miss there isn't taken as none", async () => {
    const elsewhere = new Database(":memory:");
    const dispose = registerStateProvider("broken", () =>
      Object.assign(Object.create(new SqliteStateProvider(elsewhere)), {
        id: "broken",
        query: async () => {
          throw new Error("store down");
        },
      }),
    );
    const mixed: { state: StateConfig } = {
      state: {
        backend: "sqlite",
        types: [
          { name: "doc", search: { fields: ["title"] } },
          { name: "remote", provider: "broken", search: { fields: ["title"] } },
        ],
      },
    };
    const mixedService = new StateService({ getConfig: () => mixed, db: new Database(":memory:") });
    const mixedTool = new StateTool(() => mixedService);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await mixedTool.execute({ action: "search", text: "hotel" }, context());
      expect(res.output).toBe(
        'Nothing matches "hotel" (searched doc, remote).\nNot every remote record could be searched, so one missing here may still exist.',
      );
    } finally {
      warn.mockRestore();
      dispose();
      await mixedService.close();
    }
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
