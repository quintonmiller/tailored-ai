import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { findFact, listFacts, upsertFact } from "../db/fact-queries.js";
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
    await tool.execute({ action: "set", category: "person", entity: "alice", key: "birthday", value: "1988-03-12" }, makeCtx());
    await tool.execute({ action: "set", category: "person", entity: "bob", key: "birthday", value: "1990-05-20" }, makeCtx());
    await tool.execute({ action: "set", category: "subscription", entity: "netflix", key: "monthly_cost", value: "22.99" }, makeCtx());

    const personFacts = await tool.execute({ action: "list", category: "person" }, makeCtx());
    expect(personFacts.output.split("\n")).toHaveLength(2);

    const aliceFacts = await tool.execute({ action: "list", category: "person", entity: "alice" }, makeCtx());
    expect(aliceFacts.output.split("\n")).toHaveLength(1);
    expect(aliceFacts.output).toContain("alice");
  });

  it("search matches across category/entity/key/value", async () => {
    const tool = new FactsTool(db);
    await tool.execute({ action: "set", category: "subscription", entity: "netflix", key: "monthly_cost", value: "22.99" }, makeCtx());
    await tool.execute({ action: "set", category: "subscription", entity: "spotify", key: "monthly_cost", value: "10.99" }, makeCtx());
    const res = await tool.execute({ action: "search", query: "netflix" }, makeCtx());
    expect(res.output).toContain("netflix");
    expect(res.output).not.toContain("spotify");
  });

  it("forget removes the fact", async () => {
    const tool = new FactsTool(db);
    await tool.execute({ action: "set", category: "device", entity: "thermostat", key: "model", value: "nest-2" }, makeCtx());
    const before = await tool.execute({ action: "get", category: "device", entity: "thermostat", key: "model" }, makeCtx());
    expect(before.output).toContain("nest-2");

    const f = await tool.execute({ action: "forget", category: "device", entity: "thermostat", key: "model" }, makeCtx());
    expect(f.output).toContain("forgot");

    const after = await tool.execute({ action: "get", category: "device", entity: "thermostat", key: "model" }, makeCtx());
    expect(after.output).toContain("(no fact");
  });

  it("missing required args produces a clear error", async () => {
    const tool = new FactsTool(db);
    const res = await tool.execute({ action: "set", category: "person", key: "birthday" }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toContain("value is required");
  });

  it("stores agent name as default source when caller doesn't set one", async () => {
    const tool = new FactsTool(db);
    await tool.execute({ action: "set", category: "person", entity: "alice", key: "city", value: "NYC" }, makeCtx({ agentName: "researcher" }));
    const facts = listFacts(db, { category: "person", entity: "alice" });
    expect(facts[0].source).toBe("agent:researcher");
  });
});
