/**
 * The state service: everything around storage.
 *
 * What matters most here is that the rules hold for every caller in the same
 * way — access, scopes, validation, versions — and that every write is
 * announced, because subscriptions and bound interfaces will be built on that
 * announcement and a write that slips past it is invisible to all of them.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import { registerStateProvider, registerStateType } from "../state/registry.js";
import { type StateCaller, type StateConfig, StateService } from "../state/service.js";
import { SqliteStateProvider } from "../state/sqlite-provider.js";
import { StateConflictError, StateError, type StateTypeDef } from "../state/types.js";

const planType: StateTypeDef = {
  name: "plan",
  description: "A plan someone is working through.",
  scope: "room",
  title: "name",
  schema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" }, status: { type: "string", enum: ["draft", "active", "done"] } },
  },
};

const noteType: StateTypeDef = { name: "note", scope: "agent" };
const ledgerType: StateTypeDef = { name: "ledger", access: { read: ["*", "user"], write: ["planner", "user"] } };
const secretType: StateTypeDef = { name: "secret", access: { read: ["planner"], write: ["planner"] } };

const planner: StateCaller = {
  actor: { kind: "agent", name: "planner" },
  source: { tool: "state" },
  rooms: ["local:eng"],
};
const reviewer: StateCaller = { actor: { kind: "agent", name: "reviewer" }, source: { tool: "state" } };
const person: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "web" } };

describe("StateService", () => {
  let db: Database.Database;
  let events: TypedEventBus;
  let changes: RuntimeEventPayload<"state.changed">[];
  let config: { state: StateConfig };
  let service: StateService;
  const disposers: (() => void)[] = [];

  beforeEach(() => {
    db = new Database(":memory:");
    events = new TypedEventBus();
    changes = [];
    events.on("state.changed", (c) => {
      changes.push(c);
    });
    config = { state: { backend: "sqlite", types: [planType, noteType, ledgerType, secretType] } };
    service = new StateService({ getConfig: () => config, db, events });
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await service.close();
  });

  describe("writing", () => {
    it("creates a record in the room it was written from, with a readable generated id", async () => {
      const record = await service.put(planner, { type: "plan", data: { name: "Trip to Lisbon" } });
      expect(record.scope).toBe("room:local:eng");
      expect(record.id).toMatch(/^trip-to-lisbon-[0-9a-f]{4}$/);
      expect(record.updatedBy).toEqual(planner.actor);
      expect(record.source).toEqual({ tool: "state" });
    });

    it("rejects invalid data with a correction an agent can act on", async () => {
      await expect(service.put(planner, { type: "plan", id: "trip", data: { status: "finished" } })).rejects.toThrow(
        'plan/trip was not saved:\n- `name` is required\n- `status` must be one of: draft, active, done (got "finished")',
      );
      expect(changes).toEqual([]);
    });

    it("asks for a scope when a room type is written outside a room, or from several", async () => {
      await expect(service.put(reviewer, { type: "plan", data: { name: "x" } })).rejects.toThrow(
        "this is not a room conversation",
      );
      const twoRooms = { ...planner, rooms: ["local:eng", "local:ops"] };
      await expect(service.put(twoRooms, { type: "plan", data: { name: "x" } })).rejects.toThrow("spans several");
      await expect(
        service.put(twoRooms, { type: "plan", scope: "room:local:ops", data: { name: "x" } }),
      ).resolves.toMatchObject({ scope: "room:local:ops" });
    });

    it("puts an agent-scoped record in the writer's own scope", async () => {
      const record = await service.put(reviewer, { type: "note", data: { text: "remember" } });
      expect(record.scope).toBe("agent:reviewer");
    });

    it("keeps a record's scope when it is replaced without naming one", async () => {
      await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
      const replaced = await service.put(planner, {
        type: "plan",
        id: "trip",
        data: { name: "Trip", status: "active" },
      });
      expect(replaced.scope).toBe("room:local:eng");
    });

    it("refuses a scope the writer cannot see", async () => {
      await expect(
        service.put(reviewer, { type: "note", scope: "agent:planner", data: { text: "x" } }),
      ).rejects.toThrow('You cannot use scope "agent:planner"');
    });

    it("patches named fields, and removes one set to null", async () => {
      await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip", status: "draft" } });
      const patched = await service.patch(planner, { type: "plan", id: "trip" }, { status: "active" });
      expect(patched.data).toEqual({ name: "Trip", status: "active" });
      const cleared = await service.patch(planner, { type: "plan", id: "trip" }, { status: null });
      expect(cleared.data).toEqual({ name: "Trip" });
      expect(cleared.version).toBe(3);
    });

    it("refuses a patch that would leave the record invalid", async () => {
      await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
      await expect(service.patch(planner, { type: "plan", id: "trip" }, { name: null })).rejects.toThrow(
        "`name` is required",
      );
    });

    it("passes a version mismatch back to the writer when it asked for a specific version", async () => {
      await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
      await service.patch(person, { type: "plan", id: "trip" }, { status: "active" });
      await expect(service.patch(planner, { type: "plan", id: "trip" }, { status: "done" }, 1)).rejects.toThrow(
        StateConflictError,
      );
    });

    it("deletes as a tombstone that history keeps", async () => {
      await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
      const removed = await service.delete(planner, { type: "plan", id: "trip" });
      expect(removed?.data).toEqual({ name: "Trip" });
      expect(await service.get(planner, { type: "plan", id: "trip" })).toBeNull();
      const history = await service.history(planner, { type: "plan", id: "trip" });
      expect(history.map((c) => c.op)).toEqual(["delete", "create"]);
    });

    it("deletes only while the record is at the version given, so nobody's change is lost", async () => {
      await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
      await service.patch(person, { type: "plan", id: "trip" }, { status: "active" });
      await expect(service.delete(planner, { type: "plan", id: "trip" }, 1)).rejects.toThrow(StateConflictError);
      expect(await service.get(planner, { type: "plan", id: "trip" })).toMatchObject({ version: 2 });
      expect(await service.delete(planner, { type: "plan", id: "trip" }, 2)).toMatchObject({ version: 2 });
      expect(await service.get(planner, { type: "plan", id: "trip" })).toBeNull();
    });

    it("lets only a person or the system erase a record outright", async () => {
      await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
      await expect(service.purge(planner, { type: "plan", id: "trip" })).rejects.toThrow("Delete it instead");
      expect(await service.purge(person, { type: "plan", id: "trip" })).toBe(true);
    });
  });

  describe("announcing changes", () => {
    it("emits state.changed for a create, an update and a delete, with before and after", async () => {
      await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
      await service.patch(person, { type: "plan", id: "trip" }, { status: "active" });
      await service.delete(person, { type: "plan", id: "trip" });

      expect(changes.map((c) => [c.op, c.version, c.actor.kind])).toEqual([
        ["create", 1, "agent"],
        ["update", 2, "user"],
        ["delete", 3, "user"],
      ]);
      expect(changes[1]).toMatchObject({
        type: "plan",
        id: "trip",
        scope: "room:local:eng",
        before: { name: "Trip" },
        after: { name: "Trip", status: "active" },
        source: { surface: "web" },
      });
      expect(changes[2].before).toEqual({ name: "Trip", status: "active" });
    });

    it("keeps the write when a subscriber throws", async () => {
      events.on("state.changed", () => {
        throw new Error("subscriber exploded");
      });
      const record = await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
      expect(await service.get(planner, { type: "plan", id: "trip" })).toEqual(record);
    });
  });

  describe("reading", () => {
    beforeEach(async () => {
      await service.put(planner, { type: "plan", id: "eng-plan", data: { name: "Eng" } });
      await service.put(planner, { type: "plan", id: "shared", scope: "global", data: { name: "Shared" } });
      await service.put(planner, { type: "note", id: "mine", data: { text: "private" } });
    });

    it("shows an agent its room, its own scope and global, and nothing else", async () => {
      const ids = async (caller: StateCaller, type: string) =>
        (await service.query(caller, { type, orderBy: { field: "id", direction: "asc" } })).map((r) => r.id);
      expect(await ids(planner, "plan")).toEqual(["eng-plan", "shared"]);
      expect(await ids(reviewer, "plan")).toEqual(["shared"]);
      expect(await ids(reviewer, "note")).toEqual([]);
      expect(await ids(person, "note")).toEqual(["mine"]);
    });

    it("reads a record in another agent's scope as absent, not as forbidden", async () => {
      expect(await service.get(reviewer, { type: "note", id: "mine" })).toBeNull();
      expect(await service.get(planner, { type: "note", id: "mine" })).not.toBeNull();
    });

    it("narrows to one scope on request, but only to a scope the caller can see", async () => {
      const shared = await service.query(planner, { type: "plan", scope: "global" });
      expect(shared.map((r) => r.id)).toEqual(["shared"]);
      await expect(service.query(reviewer, { type: "plan", scope: "room:local:eng" })).rejects.toThrow(StateError);
    });
  });

  describe("access", () => {
    it("lets everyone read a type but only the named agents and people write it", async () => {
      await service.put(person, { type: "ledger", id: "q1", data: { total: 3 } });
      await expect(service.get(reviewer, { type: "ledger", id: "q1" })).resolves.not.toBeNull();
      await expect(service.put(reviewer, { type: "ledger", id: "q1", data: { total: 4 } })).rejects.toThrow(
        "You can read ledger records but not change them.",
      );
      await expect(service.put(planner, { type: "ledger", id: "q1", data: { total: 4 } })).resolves.toMatchObject({
        version: 2,
      });
    });

    it("reports a type the caller cannot read exactly like one that does not exist", async () => {
      const err = await service.get(reviewer, { type: "secret", id: "x" }).catch((e: Error) => e.message);
      expect(err).toBe('There is no state type called "secret". Types you can use: ledger, note, plan.');
      expect(service.listTypes(reviewer).map((t) => t.def.name)).toEqual(["ledger", "note", "plan"]);
      expect(service.listTypes(planner).find((t) => t.def.name === "secret")?.canWrite).toBe(true);
    });
  });

  describe("types and providers", () => {
    it("takes types from plugins, and lets config override one by name", async () => {
      disposers.push(registerStateType({ name: "bookmark", description: "from a plugin" }));
      disposers.push(registerStateType({ name: "plan", description: "the plugin's plan" }));
      expect(service.getType("bookmark")?.description).toBe("from a plugin");
      expect(service.getType("plan")?.description).toBe("A plan someone is working through.");
    });

    it("picks up config changes on the next call, with no restart", async () => {
      config = { state: { ...config.state, types: [...(config.state.types ?? []), { name: "trip" }] } };
      expect(service.getType("trip")).toBeDefined();
    });

    it("routes a type with its own provider there, leaving the rest on the store-wide one", async () => {
      const elsewhere = new Database(":memory:");
      const built: string[] = [];
      disposers.push(
        registerStateProvider("elsewhere", ({ options }) => {
          built.push(String(options.label));
          return new SqliteStateProvider(elsewhere);
        }),
      );
      config.state.types = [
        ...(config.state.types ?? []),
        { name: "task", provider: "elsewhere", providerOptions: { label: "tasks" } },
      ];
      await service.put(person, { type: "task", id: "t1", data: { title: "x" } });
      await service.put(person, { type: "plan", id: "p1", scope: "global", data: { name: "p" } });

      const count = (d: Database.Database) =>
        (d.prepare("SELECT type FROM state_records ORDER BY type").all() as { type: string }[]).map((r) => r.type);
      expect(count(elsewhere)).toEqual(["task"]);
      expect(count(db)).toEqual(["plan"]);
      expect(built).toEqual(["tasks"]);
    });

    it("names the registered providers when the configured one is missing", async () => {
      config.state.backend = "postgres";
      await expect(
        service.put(person, { type: "plan", id: "p", scope: "global", data: { name: "p" } }),
      ).rejects.toThrow('No state provider is registered as "postgres". Registered: sqlite');
    });

    it("re-emits changes a provider reports from outside TAI", async () => {
      let push: ((c: RuntimeEventPayload<"state.changed">) => void) | undefined;
      disposers.push(
        registerStateProvider("watched", () => {
          const inner = new SqliteStateProvider(new Database(":memory:"));
          return Object.assign(Object.create(inner), {
            id: "watched",
            watch(emit: (c: RuntimeEventPayload<"state.changed">) => void) {
              push = emit;
              return () => {
                push = undefined;
              };
            },
          });
        }),
      );
      config.state.types = [...(config.state.types ?? []), { name: "issue", provider: "watched" }];
      await service.query(person, { type: "issue" });
      push?.({
        type: "issue",
        id: "42",
        scope: "global",
        op: "update",
        version: 7,
        actor: { kind: "system", name: "github" },
        at: "2026-01-01T00:00:00.000Z",
      });
      expect(changes.map((c) => `${c.type}/${c.id}`)).toEqual(["issue/42"]);
    });
  });
});
