import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  sweepExpiredNotes,
} from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { RecallTool } from "../tools/recall.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess_test",
    workingDirectory: process.cwd(),
    env: {},
    agentName: "tester",
    ...overrides,
  } as Parameters<RecallTool["execute"]>[1];
}

describe("note-queries", () => {
  it("createNote round-trips with defaults", () => {
    const n = createNote(db, { content: "hello world" });
    expect(n.id).toMatch(/^note_[a-f0-9]{8}$/);
    expect(n.content).toBe("hello world");
    expect(n.tags).toEqual([]);
    expect(n.project_id).toBeNull();
    expect(n.session_id).toBeNull();
    expect(n.ttl_at).toBeNull();
  });

  it("createNote stores tags as JSON and round-trips them", () => {
    const n = createNote(db, { content: "x", tags: ["alpha", "beta"] });
    const fetched = getNote(db, n.id)!;
    expect(fetched.tags).toEqual(["alpha", "beta"]);
  });

  it("listNotes filters by project_id (null vs string)", () => {
    createNote(db, { content: "g1", project_id: null });
    createNote(db, { content: "p1", project_id: "proj_a" });
    createNote(db, { content: "p2", project_id: "proj_a" });
    createNote(db, { content: "b1", project_id: "proj_b" });

    expect(listNotes(db, { project_id: null }).map((n) => n.content)).toEqual(["g1"]);
    const projA = listNotes(db, { project_id: "proj_a" }).map((n) => n.content).sort();
    expect(projA).toEqual(["p1", "p2"]);
  });

  it("listNotes filters by tag using json_each", () => {
    createNote(db, { content: "a", tags: ["watcher"] });
    createNote(db, { content: "b", tags: ["watcher", "important"] });
    createNote(db, { content: "c", tags: ["other"] });

    const watcher = listNotes(db, { tag: "watcher" }).map((n) => n.content).sort();
    expect(watcher).toEqual(["a", "b"]);
  });

  it("listNotes search matches content substring", () => {
    createNote(db, { content: "the cat sat" });
    createNote(db, { content: "the dog ran" });
    const hits = listNotes(db, { search: "cat" });
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe("the cat sat");
  });

  it("listNotes excludeExpired drops past-TTL notes", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    createNote(db, { content: "old", ttl_at: past });
    createNote(db, { content: "fresh", ttl_at: future });
    createNote(db, { content: "forever", ttl_at: null });

    const withExpired = listNotes(db, {}).map((n) => n.content).sort();
    expect(withExpired).toEqual(["forever", "fresh", "old"]);

    const live = listNotes(db, { excludeExpired: true }).map((n) => n.content).sort();
    expect(live).toEqual(["forever", "fresh"]);
  });

  it("deleteNote removes by id", () => {
    const n = createNote(db, { content: "doomed" });
    expect(deleteNote(db, n.id)).toBe(true);
    expect(getNote(db, n.id)).toBeNull();
    expect(deleteNote(db, n.id)).toBe(false);
  });

  it("sweepExpiredNotes deletes past TTL but preserves high-importance", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createNote(db, { content: "low-imp expired", ttl_at: past, importance: 0.3 });
    createNote(db, { content: "high-imp expired", ttl_at: past, importance: 0.9 });
    createNote(db, { content: "no-imp expired", ttl_at: past });
    createNote(db, { content: "fresh", ttl_at: new Date(Date.now() + 1_000_000).toISOString() });

    const swept = sweepExpiredNotes(db);
    expect(swept).toBe(2); // low-imp + no-imp

    const remaining = listNotes(db, {}).map((n) => n.content).sort();
    expect(remaining).toEqual(["fresh", "high-imp expired"]);
  });

  it("sweepExpiredNotes keepImportance threshold is configurable", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createNote(db, { content: "medium", ttl_at: past, importance: 0.6 });
    sweepExpiredNotes(db, 0.5); // higher floor — keep 0.6
    expect(listNotes(db, {}).length).toBe(1);
  });
});

describe("RecallTool", () => {
  it("action=note saves a note with session_id, agent, and project", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute(
      { action: "note", content: "watcher saw something", project_id: "proj_a", tags: ["watcher"] },
      makeCtx(),
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/^saved note_[a-f0-9]{8}$/);

    const noteId = res.output.slice("saved ".length);
    const note = getNote(db, noteId)!;
    expect(note.content).toBe("watcher saw something");
    expect(note.project_id).toBe("proj_a");
    expect(note.session_id).toBe("sess_test");
    expect(note.agent).toBe("tester");
    expect(note.tags).toEqual(["watcher"]);
    expect(note.ttl_at).not.toBeNull(); // default TTL applied
  });

  it('action=note with project_id="global" stores null project_id', async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute(
      { action: "note", content: "global thought", project_id: "global" },
      makeCtx(),
    );
    const id = res.output.slice("saved ".length);
    expect(getNote(db, id)!.project_id).toBeNull();
  });

  it("action=note with ttl_days=0 stores no TTL", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute(
      { action: "note", content: "permanent", ttl_days: 0 },
      makeCtx(),
    );
    const id = res.output.slice("saved ".length);
    expect(getNote(db, id)!.ttl_at).toBeNull();
  });

  it("action=note rejects empty content", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "note", content: "   " }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/content is required/);
  });

  it("action=forget deletes by id", async () => {
    const tool = new RecallTool(db);
    const created = await tool.execute(
      { action: "note", content: "delete me" },
      makeCtx(),
    );
    const id = created.output.slice("saved ".length);

    const forget = await tool.execute({ action: "forget", id }, makeCtx());
    expect(forget.success).toBe(true);
    expect(forget.output).toBe(`forgot ${id}`);
    expect(getNote(db, id)).toBeNull();
  });

  it("action=forget on missing id is a no-op success", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "forget", id: "note_doesnotex" }, makeCtx());
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/no note/);
  });

  it("action=forget requires id", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "forget" }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/id is required/);
  });

  it("action=list returns recent notes scoped to project, ordered newest first", async () => {
    const tool = new RecallTool(db);
    await tool.execute({ action: "note", content: "first", project_id: "proj_a" }, makeCtx());
    await new Promise((r) => setTimeout(r, 10));
    await tool.execute({ action: "note", content: "second", project_id: "proj_a" }, makeCtx());
    await tool.execute({ action: "note", content: "other-proj", project_id: "proj_b" }, makeCtx());

    const list = await tool.execute({ action: "list", project_id: "proj_a" }, makeCtx());
    expect(list.success).toBe(true);
    // newest first
    const firstSecond = list.output.indexOf("second");
    const firstFirst = list.output.indexOf("first");
    expect(firstSecond).toBeGreaterThan(-1);
    expect(firstFirst).toBeGreaterThan(-1);
    expect(firstSecond).toBeLessThan(firstFirst);
    // doesn't leak the other project's note
    expect(list.output).not.toContain("other-proj");
  });

  it("action=list with no notes returns the empty marker", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "list" }, makeCtx());
    expect(res.success).toBe(true);
    expect(res.output).toBe("(no notes)");
  });

  it("action=list excludes expired notes", async () => {
    // Directly seed an expired note (the tool always applies the default TTL).
    createNote(db, {
      content: "stale",
      project_id: "proj_a",
      ttl_at: new Date(Date.now() - 1000).toISOString(),
    });
    const tool = new RecallTool(db);
    await tool.execute({ action: "note", content: "fresh", project_id: "proj_a" }, makeCtx());

    const res = await tool.execute({ action: "list", project_id: "proj_a" }, makeCtx());
    expect(res.output).toContain("fresh");
    expect(res.output).not.toContain("stale");
  });

  it("action=list filters by tag", async () => {
    const tool = new RecallTool(db);
    await tool.execute(
      { action: "note", content: "tagged", tags: ["watcher"], project_id: "proj_a" },
      makeCtx(),
    );
    await tool.execute(
      { action: "note", content: "untagged", project_id: "proj_a" },
      makeCtx(),
    );
    const res = await tool.execute(
      { action: "list", project_id: "proj_a", tag: "watcher" },
      makeCtx(),
    );
    expect(res.output).toContain("tagged");
    expect(res.output).not.toContain("untagged");
  });

  it("unknown action errors", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "promote" }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown action/);
  });
});
