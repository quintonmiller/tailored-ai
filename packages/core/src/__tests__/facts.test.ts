import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveFact, findFact, getFact, listFacts, unarchiveFact, upsertFact } from "../db/fact-queries.js";
import { initDatabase } from "../db/schema.js";
import { FactsTool } from "../tools/facts.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "test",
    workingDirectory: process.cwd(),
    env: {},
    agentName: "tester",
    ...overrides,
  } as Parameters<FactsTool["execute"]>[1];
}

describe("FactsTool", () => {
  it("set then get round-trips a fact", async () => {
    const tool = new FactsTool(db);
    const setRes = await tool.execute(
      { action: "set", category: "person", entity: "alice", key: "birthday", value: "1988-03-12" },
      makeCtx(),
    );
    expect(setRes.success).toBe(true);
    expect(setRes.output).toContain("person:alice/birthday");
    expect(setRes.output).toContain("1988-03-12");

    const getRes = await tool.execute(
      { action: "get", category: "person", entity: "alice", key: "birthday" },
      makeCtx(),
    );
    expect(getRes.success).toBe(true);
    expect(getRes.output).toContain("1988-03-12");
  });

  it("set is idempotent — updating value preserves identity, refreshes updated_at", () => {
    const a = upsertFact(db, { category: "person", entity: "alice", key: "city", value: "NYC" });
    const b = upsertFact(db, { category: "person", entity: "alice", key: "city", value: "SF" });
    expect(a.id).toBe(b.id);
    expect(b.value).toBe("SF");
    const reread = findFact(db, "person", "alice", "city", null);
    expect(reread?.value).toBe("SF");
  });

  it("list filters by category and entity", async () => {
    const tool = new FactsTool(db);
    await tool.execute(
      { action: "set", category: "person", entity: "alice", key: "birthday", value: "1988-03-12" },
      makeCtx(),
    );
    await tool.execute(
      { action: "set", category: "person", entity: "bob", key: "birthday", value: "1990-05-20" },
      makeCtx(),
    );
    await tool.execute(
      { action: "set", category: "subscription", entity: "netflix", key: "monthly_cost", value: "22.99" },
      makeCtx(),
    );

    const personFacts = await tool.execute({ action: "list", category: "person" }, makeCtx());
    expect(personFacts.output.split("\n")).toHaveLength(2);

    const aliceFacts = await tool.execute({ action: "list", category: "person", entity: "alice" }, makeCtx());
    expect(aliceFacts.output.split("\n")).toHaveLength(1);
    expect(aliceFacts.output).toContain("alice");
  });

  it("search matches across category/entity/key/value", async () => {
    const tool = new FactsTool(db);
    await tool.execute(
      { action: "set", category: "subscription", entity: "netflix", key: "monthly_cost", value: "22.99" },
      makeCtx(),
    );
    await tool.execute(
      { action: "set", category: "subscription", entity: "spotify", key: "monthly_cost", value: "10.99" },
      makeCtx(),
    );
    const res = await tool.execute({ action: "search", query: "netflix" }, makeCtx());
    expect(res.output).toContain("netflix");
    expect(res.output).not.toContain("spotify");
  });

  it("forget archives the fact: gone from list and search, still fetchable and marked", async () => {
    const tool = new FactsTool(db);
    await tool.execute(
      { action: "set", category: "device", entity: "thermostat", key: "model", value: "nest-2" },
      makeCtx(),
    );
    const before = await tool.execute(
      { action: "get", category: "device", entity: "thermostat", key: "model" },
      makeCtx(),
    );
    expect(before.output).toContain("nest-2");

    const f = await tool.execute(
      { action: "forget", category: "device", entity: "thermostat", key: "model" },
      makeCtx(),
    );
    expect(f.output).toContain("forgot");
    expect(f.output).toContain("set it again to restore");

    // Fetching by its key still works and says it was forgotten.
    const after = await tool.execute(
      { action: "get", category: "device", entity: "thermostat", key: "model" },
      makeCtx(),
    );
    expect(after.output).toContain("nest-2");
    expect(after.output).toContain("forgotten");

    const list = await tool.execute({ action: "list", category: "device" }, makeCtx());
    expect(list.output).toContain("(no facts match)");
    const search = await tool.execute({ action: "search", query: "thermostat" }, makeCtx());
    expect(search.output).toContain("(no facts match");

    // includeArchived brings it back on both.
    const listAll = await tool.execute({ action: "list", category: "device", includeArchived: true }, makeCtx());
    expect(listAll.output).toContain("nest-2");
    const searchAll = await tool.execute({ action: "search", query: "thermostat", includeArchived: true }, makeCtx());
    expect(searchAll.output).toContain("nest-2");

    const row = findFact(db, "device", "thermostat", "model");
    expect(row).toMatchObject({ archived_by: "tester", archive_reason: "forgotten" });
    expect(row?.archived_at).not.toBeNull();

    const again = await tool.execute(
      { action: "forget", category: "device", entity: "thermostat", key: "model" },
      makeCtx(),
    );
    expect(again.output).toContain("already forgotten");
  });

  it("setting a forgotten fact's key restores it with the new value", async () => {
    const tool = new FactsTool(db);
    await tool.execute({ action: "set", category: "person", entity: "alice", key: "city", value: "Lisbon" }, makeCtx());
    await tool.execute({ action: "forget", category: "person", entity: "alice", key: "city" }, makeCtx());
    const res = await tool.execute(
      { action: "set", category: "person", entity: "alice", key: "city", value: "Porto" },
      makeCtx(),
    );
    expect(res.output).toContain("Porto");
    expect(res.output).toContain("restored from the archive");
    const row = findFact(db, "person", "alice", "city");
    expect(row).toMatchObject({ value: "Porto", archived_at: null, archived_by: null, archive_reason: null });
    expect(listFacts(db, { category: "person" })).toHaveLength(1);
  });

  it("archiveFact keeps the first stamp; unarchiveFact clears it", () => {
    const f = upsertFact(db, { category: "device", key: "model", value: "x" });
    archiveFact(db, f.id, { by: "assistant", reason: "wrong" });
    archiveFact(db, f.id, { by: "planner", reason: "later" });
    expect(getFact(db, f.id)).toMatchObject({ archived_by: "assistant", archive_reason: "wrong" });
    expect(listFacts(db, {})).toHaveLength(0);
    expect(listFacts(db, { includeArchived: true })).toHaveLength(1);
    expect(unarchiveFact(db, f.id)).toMatchObject({ archived_at: null, archived_by: null });
    expect(listFacts(db, {})).toHaveLength(1);
    expect(archiveFact(db, "fact_nope")).toBeNull();
  });

  it("missing required args produces a clear error", async () => {
    const tool = new FactsTool(db);
    const res = await tool.execute({ action: "set", category: "person", key: "birthday" }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toContain("value is required");
  });

  it("stores agent name as default source when caller doesn't set one", async () => {
    const tool = new FactsTool(db);
    await tool.execute(
      { action: "set", category: "person", entity: "alice", key: "city", value: "NYC" },
      makeCtx({ agentName: "researcher" }),
    );
    const facts = listFacts(db, { category: "person", entity: "alice" });
    expect(facts[0].source).toBe("agent:researcher");
  });
});
