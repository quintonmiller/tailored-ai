import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFact } from "../db/fact-queries.js";
import { getNote } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";

let db: Database.Database;
let backend: SqliteMemoryBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
  backend = new SqliteMemoryBackend(db);
});

afterEach(() => {
  db.close();
});

describe("SqliteMemoryBackend — write routing", () => {
  it("defaults to the notes table when kind is omitted", async () => {
    const { id } = await backend.write({ text: "Recall that I prefer dark mode" });
    expect(id).toMatch(/^note:/);
    const note = getNote(db, id.slice("note:".length));
    expect(note?.content).toBe("Recall that I prefer dark mode");
  });

  it("routes kind=fact to the facts table with structured payload", async () => {
    const { id } = await backend.write(
      { text: "weekly", structured: { category: "preference", entity: "user", key: "tea_schedule" } },
      { kind: "fact", scope: "project:abc" },
    );
    expect(id).toMatch(/^fact:/);
    const fact = findFact(db, "preference", "user", "tea_schedule", "abc");
    expect(fact?.value).toBe("weekly");
    expect(fact?.project_id).toBe("abc");
  });

  it("routes kind=chunk to memory_chunks with an embedding when provided", async () => {
    const vector = Float32Array.from([0.1, 0.2, 0.3]);
    const { id } = await backend.write({ text: "chunk body" }, { kind: "chunk", sourceUri: "doc:1", vector });
    expect(id).toMatch(/^chunk:/);
    const fragment = await backend.get(id);
    expect(fragment?.text).toBe("chunk body");
    expect(fragment?.metadata?.source).toBe("doc:1");
  });

  it("routes kind=prelude to core_memory and requires hint.scope agent", async () => {
    const { id } = await backend.write(
      { text: "I am a helpful agent.", structured: { section: "persona" } },
      { kind: "prelude", scope: "agent:helper" },
    );
    expect(id).toBe("prelude:helper/persona");

    await expect(backend.write({ text: "x", structured: { section: "persona" } }, { kind: "prelude" })).rejects.toThrow(
      /hint.scope.*agent/,
    );
  });

  it("rejects unknown core_memory sections", async () => {
    await expect(
      backend.write(
        { text: "x", structured: { section: "made_up_section" } },
        { kind: "prelude", scope: "agent:helper" },
      ),
    ).rejects.toThrow(/Unknown core_memory section/);
  });

  it("supersedes drops the prior record before writing the replacement", async () => {
    const first = await backend.write({ text: "old preference" }, { tags: ["pref"] });
    const second = await backend.write({ text: "new preference" }, { supersedes: first.id, tags: ["pref"] });
    expect(await backend.get(first.id)).toBeNull();
    expect((await backend.get(second.id))?.text).toBe("new preference");
  });

  it("supersedes tolerates unknown prior ids without throwing", async () => {
    const { id } = await backend.write({ text: "new" }, { supersedes: "note:ghost" });
    expect(id).toMatch(/^note:/);
  });
});

describe("SqliteMemoryBackend — query routing", () => {
  it("returns exact-match facts via wantStructured", async () => {
    await backend.write(
      { text: "10pm", structured: { category: "schedule", entity: "user", key: "bedtime" } },
      { kind: "fact" },
    );
    const hits = await backend.query({
      wantStructured: { category: "schedule", entity: "user", key: "bedtime" },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("10pm");
    expect(hits[0].metadata?.kind).toBe("fact");
  });

  it("keyword recall returns matching notes scoped to project + globals", async () => {
    await backend.write({ text: "global note about coffee" }, {});
    await backend.write({ text: "project note about coffee shop" }, { scope: "project:p1" });
    await backend.write({ text: "unrelated tea note" }, { scope: "project:p1" });
    const hits = await backend.query({ freeText: "coffee", scope: "project:p1", limit: 5 });
    const texts = hits.map((h) => h.text);
    expect(texts).toContain("global note about coffee");
    expect(texts).toContain("project note about coffee shop");
    expect(texts).not.toContain("unrelated tea note");
  });

  it("semantic search runs when a query vector is provided", async () => {
    const v = Float32Array.from([1, 0, 0]);
    await backend.write({ text: "chunk near v" }, { kind: "chunk", vector: v, sourceUri: "doc:1" });
    const hits = await backend.query({ vector: v, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].metadata?.kind).toBe("chunk");
    expect(typeof hits[0].metadata?.score).toBe("number");
  });

  it("respects limit across mixed sources", async () => {
    for (let i = 0; i < 5; i++) await backend.write({ text: `note ${i} apple` }, {});
    const hits = await backend.query({ freeText: "apple", limit: 2 });
    expect(hits).toHaveLength(2);
  });
});

describe("SqliteMemoryBackend — delete and get routing", () => {
  it("delete + get use the id prefix to route to the right table", async () => {
    const note = await backend.write({ text: "n" });
    const fact = await backend.write(
      { text: "v", structured: { category: "c", entity: "e", key: "k" } },
      { kind: "fact" },
    );
    expect(await backend.get(note.id)).not.toBeNull();
    expect(await backend.get(fact.id)).not.toBeNull();
    expect(await backend.delete(note.id)).toBe(true);
    expect(await backend.delete(fact.id)).toBe(true);
    expect(await backend.get(note.id)).toBeNull();
    expect(await backend.get(fact.id)).toBeNull();
  });

  it("returns false for unknown ids and malformed ids", async () => {
    expect(await backend.delete("note:does-not-exist")).toBe(false);
    expect(await backend.delete("no-prefix")).toBe(false);
    expect(await backend.get("ghost:1")).toBeNull();
  });
});

describe("SqliteMemoryBackend — prelude", () => {
  it("renders core_memory for an agent scope", async () => {
    await backend.write(
      { text: "Friendly tone, concise.", structured: { section: "persona" } },
      { kind: "prelude", scope: "agent:tester" },
    );
    const text = await backend.prelude({ scope: "agent:tester" });
    expect(text).toContain("persona");
    expect(text).toContain("Friendly tone");
  });

  it("returns empty when no agent is in scope", async () => {
    expect(await backend.prelude({})).toBe("");
    expect(await backend.prelude({ scope: "project:p1" })).toBe("");
  });
});

describe("SqliteMemoryBackend — list and count", () => {
  it("lists notes scoped to a project plus globals", async () => {
    await backend.write({ text: "global" }, {});
    await backend.write({ text: "p1 note" }, { scope: "project:p1" });
    await backend.write({ text: "p2 note" }, { scope: "project:p2" });
    const hits = await backend.list({ scope: "project:p1" });
    const texts = hits.map((h) => h.text).sort();
    expect(texts).toEqual(["global", "p1 note"]);
  });

  it("count returns table totals per kind", async () => {
    await backend.write({ text: "n1" }, {});
    await backend.write({ text: "n2" }, {});
    await backend.write({ text: "v", structured: { category: "c", key: "k" } }, { kind: "fact" });
    expect(await backend.count({ kind: "note" })).toBe(2);
    expect(await backend.count({ kind: "fact" })).toBe(1);
    expect(await backend.count({ kind: "chunk" })).toBe(0);
  });

  it("kind=prelude list returns one fragment per section for the scoped agent", async () => {
    await backend.write(
      { text: "Direct.", structured: { section: "persona" } },
      { kind: "prelude", scope: "agent:tester" },
    );
    await backend.write(
      { text: "Investigating bug X.", structured: { section: "active_threads" } },
      { kind: "prelude", scope: "agent:tester" },
    );
    const hits = await backend.list({ kind: "prelude", scope: "agent:tester" });
    const sections = hits.map((h) => h.metadata?.section).sort();
    expect(sections).toEqual(["active_threads", "persona"]);
  });
});
