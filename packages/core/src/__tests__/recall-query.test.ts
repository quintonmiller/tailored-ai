import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertFact } from "../db/fact-queries.js";
import { createNote } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import {
  coverage,
  formatHits,
  recallQuery,
  tokenize,
} from "../tools/recall-query.js";
import { RecallTool } from "../tools/recall.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("tokenize", () => {
  it("lowercases, splits on non-word, drops short tokens, dedupes", () => {
    expect(tokenize("The Cat-Sat on a MAT")).toEqual(["the", "cat", "sat", "on", "mat"]);
    expect(tokenize("HN HN ai-agents")).toEqual(["hn", "ai", "agents"]);
  });

  it("returns empty for an empty / whitespace / single-char query", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("a b c")).toEqual([]); // all <2 chars
  });
});

describe("coverage", () => {
  it("scores 0 with no terms and 1 with all terms present", () => {
    expect(coverage([], "anything")).toBe(0);
    expect(coverage(["foo", "bar"], "foo and bar in here")).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(coverage(["cat"], "The CAT sat")).toBe(1);
  });

  it("is fractional for partial matches", () => {
    expect(coverage(["foo", "bar", "baz"], "foo and bar only")).toBeCloseTo(2 / 3);
  });
});

describe("recallQuery", () => {
  it("returns hits sorted by score desc, tie-broken by recency", async () => {
    // Three notes, varying coverage of "cat dog"
    createNote(db, { content: "the cat and the dog", project_id: "p" }); // both terms
    createNote(db, { content: "just a cat here", project_id: "p" });     // 1/2
    createNote(db, { content: "the fox", project_id: "p" });             // 0
    upsertFact(db, { category: "pet", entity: "rex", key: "species", value: "dog", project_id: "p" });

    const hits = recallQuery(db, { query: "cat dog", projectId: "p", limit: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(3);
    // first hit is the full-coverage note (score = 1.0)
    expect(hits[0].tier).toBe("short");
    expect(hits[0].snippet).toContain("cat and the dog");
    expect(hits[0].score).toBe(1);
    // The fox-only note doesn't appear
    expect(hits.find((h) => h.snippet.includes("fox"))).toBeUndefined();
  });

  it("scopes results to the requested project", () => {
    createNote(db, { content: "alpha bravo", project_id: "p" });
    createNote(db, { content: "alpha bravo", project_id: "q" });

    const fromP = recallQuery(db, { query: "alpha bravo", projectId: "p" });
    expect(fromP.length).toBe(1);

    const global = recallQuery(db, { query: "alpha bravo", projectId: null });
    expect(global.length).toBe(0); // no global notes seeded
  });

  it("respects the tier filter", () => {
    createNote(db, { content: "alice birthday", project_id: "p" });
    upsertFact(db, { category: "person", entity: "alice", key: "birthday", value: "1988-03-12", project_id: "p" });

    const both = recallQuery(db, { query: "alice", projectId: "p" });
    expect(both.map((h) => h.tier).sort()).toEqual(["long", "short"]);

    const onlyShort = recallQuery(db, { query: "alice", projectId: "p", tier: "short" });
    expect(onlyShort.every((h) => h.tier === "short")).toBe(true);

    const onlyLong = recallQuery(db, { query: "alice", projectId: "p", tier: "long" });
    expect(onlyLong.every((h) => h.tier === "long")).toBe(true);
  });

  it("returns empty for empty query terms", () => {
    createNote(db, { content: "stuff", project_id: "p" });
    expect(recallQuery(db, { query: "", projectId: "p" })).toEqual([]);
    expect(recallQuery(db, { query: "  ", projectId: "p" })).toEqual([]);
  });

  it("skips expired notes", () => {
    createNote(db, {
      content: "old observation",
      project_id: "p",
      ttl_at: new Date(Date.now() - 1000).toISOString(),
    });
    createNote(db, { content: "fresh observation", project_id: "p" });

    const hits = recallQuery(db, { query: "observation", projectId: "p" });
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).toContain("fresh");
  });

  it("tag matches add a small bonus", () => {
    createNote(db, { content: "incidental mention of cats", tags: [], project_id: "p" });
    createNote(db, { content: "incidental mention of cats", tags: ["cats"], project_id: "p" });

    const hits = recallQuery(db, { query: "cats", projectId: "p", limit: 5 });
    expect(hits.length).toBe(2);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("key matches on facts add a small bonus over value-only matches", () => {
    upsertFact(db, { category: "person", entity: "alice", key: "city", value: "Portland", project_id: "p" });
    upsertFact(db, { category: "weather", entity: "today", key: "summary", value: "city skyline cloudy", project_id: "p" });

    const hits = recallQuery(db, { query: "city", projectId: "p", tier: "long" });
    expect(hits.length).toBe(2);
    // The one where "city" is the key should score higher.
    expect(hits[0].source).toContain("city");
  });

  it("limit caps the number of results", () => {
    for (let i = 0; i < 8; i++) {
      createNote(db, { content: `widget ${i}`, project_id: "p" });
    }
    const hits = recallQuery(db, { query: "widget", projectId: "p", limit: 3 });
    expect(hits.length).toBe(3);
  });
});

describe("formatHits", () => {
  it("renders an empty marker when no hits", () => {
    expect(formatHits([])).toBe("(no matches)");
  });

  it("renders score, tier, source, snippet, and count footer", () => {
    const out = formatHits([
      {
        tier: "short",
        source: "note_abc12345",
        score: 0.85,
        snippet: "watcher saw HN article",
        createdAt: "2026-05-13T00:00:00Z",
      },
    ]);
    expect(out).toContain("[0.85]");
    expect(out).toContain("short");
    expect(out).toContain("note_abc12345");
    expect(out).toContain("watcher saw HN article");
    expect(out).toContain("(1 result)");
  });
});

describe("RecallTool query action", () => {
  function makeCtx() {
    return {
      sessionId: "sess",
      workingDirectory: process.cwd(),
      env: {},
      agentName: "tester",
    } as Parameters<RecallTool["execute"]>[1];
  }

  it("query returns ranked hits across notes and facts", async () => {
    const tool = new RecallTool(db);
    await tool.execute(
      { action: "note", content: "watcher noticed local llm news", project_id: "p", tags: ["watcher"] },
      makeCtx(),
    );
    upsertFact(db, { category: "person", entity: "alice", key: "interest", value: "local-llm", project_id: "p" });

    const res = await tool.execute(
      { action: "query", query: "local llm", project_id: "p" },
      makeCtx(),
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain("watcher noticed");
    expect(res.output).toContain("person:alice/interest");
    expect(res.output).toMatch(/\(2 results\)/);
  });

  it("query requires a query string", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "query" }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/query is required/);
  });

  it("query rejects an invalid tier", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "query", query: "x", tier: "medium" }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/invalid tier/);
  });

  it("query with no matches returns the empty marker", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "query", query: "nonexistent" }, makeCtx());
    expect(res.success).toBe(true);
    expect(res.output).toBe("(no matches)");
  });

  it("query honors the tier=short filter", async () => {
    const tool = new RecallTool(db);
    await tool.execute(
      { action: "note", content: "alice loves jazz", project_id: "p" },
      makeCtx(),
    );
    upsertFact(db, { category: "person", entity: "alice", key: "genre", value: "jazz", project_id: "p" });

    const res = await tool.execute(
      { action: "query", query: "alice", project_id: "p", tier: "short" },
      makeCtx(),
    );
    expect(res.output).toContain("alice loves jazz");
    expect(res.output).not.toContain("person:alice/genre");
  });
});
