/**
 * The built-in state providers: storage only, so these tests talk to them
 * directly, without the service's validation or access rules in the way. Both
 * run the same contract — a type moved from one to the other must read the same.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { stateProviderRegistry } from "../state/index.js";
import { MemoryStateProvider } from "../state/memory-provider.js";
import { SqliteStateProvider } from "../state/sqlite-provider.js";
import { type Actor, StateConflictError, StateError, type StateProvider, type StateWrite } from "../state/types.js";

const agent: Actor = { kind: "agent", name: "planner" };
const person: Actor = { kind: "user", name: "owner" };

let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));

function write(id: string, data: Record<string, unknown>, scope = "global"): StateWrite {
  return { type: "plan", id, scope, data, actor: agent, source: { tool: "state" } };
}

describe("SqliteStateProvider", () => {
  it("creates its own tables, so core's schema carries none of them", () => {
    const db = new Database(":memory:");
    new SqliteStateProvider(db, now);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'state_%' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["state_changes", "state_records"]);
  });
});

describe("MemoryStateProvider", () => {
  it("is registered beside sqlite, so a type can name it", () => {
    expect(stateProviderRegistry.has("memory")).toBe(true);
  });

  it("keeps only a record's latest changes", async () => {
    const provider = new MemoryStateProvider(now, { history: 2 });
    for (const n of [1, 2, 3]) await provider.put(write("trip", { n }));
    const history = await provider.history({ type: "plan", id: "trip" });
    expect(history.map((c) => c.version)).toEqual([3, 2]);
  });

  it("hands out copies, so a caller changing what it read changes nothing stored", async () => {
    const provider = new MemoryStateProvider(now);
    const data = { list: ["a"] };
    const { record } = await provider.put(write("trip", data));
    data.list.push("b");
    record.data.list = [];
    expect((await provider.get({ type: "plan", id: "trip" }))?.data).toEqual({ list: ["a"] });
  });
});

/** Both keep history and can delete, which the optional parts of the contract leave open. */
type Store = StateProvider & Required<Pick<StateProvider, "delete" | "history" | "purge">>;

describe.each([
  ["sqlite", (): Store => new SqliteStateProvider(new Database(":memory:"), now)],
  ["memory", (): Store => new MemoryStateProvider(now)],
])("%s provider", (_name, make) => {
  let provider: Store;

  beforeEach(() => {
    clock = 0;
    provider = make();
  });

  it("stores a record with its provenance and reads it back", async () => {
    const { record, previous } = await provider.put(write("trip", { name: "Trip" }));
    expect(previous).toBeUndefined();
    expect(record).toMatchObject({
      type: "plan",
      id: "trip",
      scope: "global",
      data: { name: "Trip" },
      version: 1,
      updatedBy: agent,
      source: { tool: "state" },
    });
    expect(await provider.get({ type: "plan", id: "trip" })).toEqual(record);
  });

  it("counts versions up and reports what a write replaced", async () => {
    await provider.put(write("trip", { name: "Trip" }));
    const { record, previous } = await provider.put(write("trip", { name: "Trip", status: "active" }));
    expect(record.version).toBe(2);
    expect(previous?.data).toEqual({ name: "Trip" });
    expect(record.createdAt).toBe(previous?.createdAt);
  });

  it("refuses a conditional write at the wrong version, and a create over an existing record", async () => {
    await provider.put(write("trip", { name: "Trip" }));
    await expect(provider.put(write("trip", { name: "x" }), 3)).rejects.toThrow(StateConflictError);
    await expect(provider.put(write("trip", { name: "x" }), 0)).rejects.toThrow("already exists");
    await expect(provider.put(write("trip", { name: "y" }), 1)).resolves.toMatchObject({ record: { version: 2 } });
  });

  it("deletes as a tombstone: gone from reads, kept in history", async () => {
    await provider.put(write("trip", { name: "Trip" }));
    const removed = await provider.delete({ type: "plan", id: "trip" }, person);
    expect(removed?.data).toEqual({ name: "Trip" });
    expect(await provider.get({ type: "plan", id: "trip" })).toBeNull();
    expect(await provider.query({ type: "plan" })).toEqual([]);
    expect(await provider.delete({ type: "plan", id: "trip" }, person)).toBeNull();

    const history = await provider.history({ type: "plan", id: "trip" });
    expect(history.map((c) => [c.op, c.version, c.actor.kind])).toEqual([
      ["delete", 2, "user"],
      ["create", 1, "agent"],
    ]);
  });

  it("never reuses a version number when a deleted record is created again", async () => {
    await provider.put(write("trip", { name: "Trip" }));
    await provider.delete({ type: "plan", id: "trip" }, person);
    const { record, previous } = await provider.put(write("trip", { name: "Again" }), 0);
    expect(previous).toBeUndefined();
    expect(record.version).toBe(3);
  });

  it("purges a record and its history outright", async () => {
    await provider.put(write("trip", { name: "Trip" }));
    expect(await provider.purge({ type: "plan", id: "trip" })).toBe(true);
    expect(await provider.history({ type: "plan", id: "trip" })).toEqual([]);
    expect(await provider.purge({ type: "plan", id: "trip" })).toBe(false);
  });

  describe("query", () => {
    beforeEach(async () => {
      await provider.put(write("a", { name: "A", status: "active", priority: 3, done: false }));
      await provider.put(write("b", { name: "B", status: "done", priority: 1, done: true }, "room:local:eng"));
      await provider.put(write("c", { name: "C", status: "active", priority: 5, owner: { name: "sam" } }));
    });

    it("filters by scope", async () => {
      const ids = (await provider.query({ type: "plan", scopes: ["room:local:eng"] })).map((r) => r.id);
      expect(ids).toEqual(["b"]);
      expect(await provider.query({ type: "plan", scopes: [] })).toEqual([]);
    });

    it("filters by equality, including booleans and nested fields", async () => {
      const by = async (where: Record<string, unknown>) =>
        (await provider.query({ type: "plan", where: where as never, orderBy: { field: "id", direction: "asc" } })).map(
          (r) => r.id,
        );
      expect(await by({ status: "active" })).toEqual(["a", "c"]);
      expect(await by({ done: true })).toEqual(["b"]);
      expect(await by({ "owner.name": "sam" })).toEqual(["c"]);
      expect(await by({ owner: null })).toEqual(["a", "b"]);
    });

    it("supports in, ne and ranges", async () => {
      const by = async (where: Record<string, unknown>) =>
        (await provider.query({ type: "plan", where: where as never, orderBy: { field: "id", direction: "asc" } })).map(
          (r) => r.id,
        );
      expect(await by({ status: { in: ["done", "draft"] } })).toEqual(["b"]);
      expect(await by({ status: { ne: "done" } })).toEqual(["a", "c"]);
      expect(await by({ priority: { gte: 3, lt: 5 } })).toEqual(["a"]);
      expect(await by({ status: { in: [] } })).toEqual([]);
      // Missing is null, and null is not equal to a value.
      expect(await by({ "owner.name": { ne: "sam" } })).toEqual(["a", "b"]);
    });

    it("reads booleans as 1 and 0, as SQLite's JSON does", async () => {
      const ids = (await provider.query({ type: "plan", where: { done: 1 } })).map((r) => r.id);
      expect(ids).toEqual(["b"]);
    });

    it("breaks a tie by id, whatever order the records were written in", async () => {
      await provider.put(write("z", { name: "Z", priority: 9 }));
      await provider.put(write("y", { name: "Y", priority: 9 }));
      const ids = (await provider.query({ type: "plan", orderBy: { field: "priority" }, limit: 2 })).map((r) => r.id);
      expect(ids).toEqual(["y", "z"]);
    });

    it("orders by a data field and pages", async () => {
      const page = async (offset: number) =>
        (
          await provider.query({ type: "plan", orderBy: { field: "priority", direction: "desc" }, limit: 2, offset })
        ).map((r) => r.id);
      expect(await page(0)).toEqual(["c", "a"]);
      expect(await page(2)).toEqual(["b"]);
    });

    it("rejects a field path that is not a plain name, before it reaches SQL", async () => {
      await expect(provider.query({ type: "plan", where: { "x') OR 1=1 --": 1 } })).rejects.toThrow(StateError);
      await expect(provider.query({ type: "plan", orderBy: { field: "a;b" } })).rejects.toThrow(StateError);
    });

    it("names the conditions it understands when given one it does not", async () => {
      await expect(provider.query({ type: "plan", where: { status: { like: "a%" } as never } })).rejects.toThrow(
        "Use a value, or one of: in, ne, gt, gte, lt, lte.",
      );
    });
  });
});
