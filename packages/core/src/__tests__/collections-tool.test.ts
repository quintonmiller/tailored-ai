import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCollections, normalizeCollectionType } from "../db/collection-queries.js";
import { initDatabase } from "../db/schema.js";
import { CollectionsTool } from "../tools/collections.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function makeCtx() {
  return {
    sessionId: "test",
    workingDirectory: process.cwd(),
    env: {},
    agentName: "tester",
  } as Parameters<CollectionsTool["execute"]>[1];
}

describe("normalizeCollectionType", () => {
  it("snake_cases free-text labels into stable buckets", () => {
    expect(normalizeCollectionType("Board Game")).toBe("board_game");
    expect(normalizeCollectionType("  Tiki Mug  ")).toBe("tiki_mug");
    expect(normalizeCollectionType("book")).toBe("book");
  });
});

describe("CollectionsTool", () => {
  it("adds an item of an arbitrary (non-legacy) type and lists it back", async () => {
    const tool = new CollectionsTool(db);

    const add = await tool.execute({ action: "add", type: "Book", name: "Dune", rating: 5 }, makeCtx());
    expect(add.success).toBe(true);
    expect(add.output).toMatch(/Added book "Dune"/);

    const list = await tool.execute({ action: "list", type: "book" }, makeCtx());
    expect(list.success).toBe(true);
    expect(list.output).toMatch(/Dune/);

    // The legacy CHECK constraint would have rejected "book" — verify it's stored.
    const { items } = listCollections(db, { type: "book" });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Dune");
  });

  it("reports per-type counts via stats.byType", async () => {
    const tool = new CollectionsTool(db);
    await tool.execute({ action: "add", type: "restaurant", name: "Canlis" }, makeCtx());
    await tool.execute({ action: "add", type: "restaurant", name: "Spinasse" }, makeCtx());
    await tool.execute({ action: "add", type: "book", name: "Dune" }, makeCtx());

    const stats = await tool.execute({ action: "stats" }, makeCtx());
    expect(stats.success).toBe(true);
    expect(stats.output).toMatch(/restaurant: 2/);
    expect(stats.output).toMatch(/book: 1/);
  });

  it("requires type and name for add", async () => {
    const tool = new CollectionsTool(db);
    const noType = await tool.execute({ action: "add", name: "x" }, makeCtx());
    expect(noType.success).toBe(false);
    const noName = await tool.execute({ action: "add", type: "book" }, makeCtx());
    expect(noName.success).toBe(false);
  });

  it("removes an item by id", async () => {
    const tool = new CollectionsTool(db);
    const add = await tool.execute({ action: "add", type: "book", name: "Dune" }, makeCtx());
    const id = /\((col_[^)]+)\)/.exec(add.output)?.[1];
    expect(id).toBeTruthy();
    const rm = await tool.execute({ action: "remove", id }, makeCtx());
    expect(rm.success).toBe(true);
    expect(listCollections(db, {}).items).toHaveLength(0);
  });
});
