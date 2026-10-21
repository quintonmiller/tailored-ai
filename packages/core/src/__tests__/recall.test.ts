import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countChunks, createChunk, listChunksBySource, semanticSearch } from "../db/chunk-queries.js";
import {
  archiveNote,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  sweepExpiredNotes,
  unarchiveNote,
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
    const projA = listNotes(db, { project_id: "proj_a" })
      .map((n) => n.content)
      .sort();
    expect(projA).toEqual(["p1", "p2"]);
  });

  it("listNotes filters by tag using json_each", () => {
    createNote(db, { content: "a", tags: ["watcher"] });
    createNote(db, { content: "b", tags: ["watcher", "important"] });
    createNote(db, { content: "c", tags: ["other"] });

    const watcher = listNotes(db, { tag: "watcher" })
      .map((n) => n.content)
      .sort();
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

    const withExpired = listNotes(db, {})
      .map((n) => n.content)
      .sort();
    expect(withExpired).toEqual(["forever", "fresh", "old"]);

    const live = listNotes(db, { excludeExpired: true })
      .map((n) => n.content)
      .sort();
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

    const remaining = listNotes(db, {})
      .map((n) => n.content)
      .sort();
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
    const res = await tool.execute({ action: "note", content: "global thought", project_id: "global" }, makeCtx());
    const id = res.output.slice("saved ".length);
    expect(getNote(db, id)!.project_id).toBeNull();
  });

  it("action=note with ttl_days=0 stores no TTL", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "note", content: "permanent", ttl_days: 0 }, makeCtx());
    const id = res.output.slice("saved ".length);
    expect(getNote(db, id)!.ttl_at).toBeNull();
  });

  it("action=note rejects empty content", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "note", content: "   " }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/content is required/);
  });

  it("action=forget archives by id, says how to restore it, and unarchive does", async () => {
    const tool = new RecallTool(db);
    const created = await tool.execute({ action: "note", content: "delete me" }, makeCtx());
    const id = created.output.slice("saved ".length);

    const forget = await tool.execute({ action: "forget", id }, makeCtx());
    expect(forget.success).toBe(true);
    expect(forget.output).toContain(`archived ${id} (forgotten)`);
    expect(forget.output).toContain("unarchive");
    // Still there, hidden, stamped with who and why.
    expect(getNote(db, id)).toMatchObject({ archived_by: "tester", archive_reason: "forgotten" });
    expect(listNotes(db, {})).toHaveLength(0);

    const restored = await tool.execute({ action: "unarchive", id }, makeCtx());
    expect(restored.output).toBe(`restored ${id}`);
    expect(getNote(db, id)?.archived_at).toBeNull();
    expect(listNotes(db, {})).toHaveLength(1);
  });

  it("action=archive takes an optional reason; query and list leave archived notes out unless asked", async () => {
    const tool = new RecallTool(db);
    const keepRes = await tool.execute({ action: "note", content: "the tide table for the harbour" }, makeCtx());
    const goneRes = await tool.execute({ action: "note", content: "the harbour cafe closed" }, makeCtx());
    const keepId = keepRes.output.slice("saved ".length);
    const goneId = goneRes.output.slice("saved ".length);

    const archived = await tool.execute({ action: "archive", id: goneId, reason: "superseded" }, makeCtx());
    expect(archived.output).toContain(`archived ${goneId} (superseded)`);
    const bare = await tool.execute({ action: "archive", id: keepId }, makeCtx());
    expect(bare.success).toBe(true);
    await tool.execute({ action: "unarchive", id: keepId }, makeCtx());

    const q = await tool.execute({ action: "query", query: "harbour" }, makeCtx());
    expect(q.output).toContain(keepId);
    expect(q.output).not.toContain(goneId);
    const qAll = await tool.execute({ action: "query", query: "harbour", includeArchived: true }, makeCtx());
    expect(qAll.output).toContain(goneId);
    expect(qAll.output).toMatch(new RegExp(`${goneId} \\(archived \\d{4}-\\d{2}-\\d{2}\\)`));

    const list = await tool.execute({ action: "list" }, makeCtx());
    expect(list.output).toContain(keepId);
    expect(list.output).not.toContain(goneId);
    const listAll = await tool.execute({ action: "list", includeArchived: true }, makeCtx());
    expect(listAll.output).toContain(goneId);
    expect(listAll.output).toContain(": superseded");
  });

  it("an archived note's chunks stop surfacing; restoring brings them back; a delete takes them with it", () => {
    const n = createNote(db, { content: "promoted", project_id: "p" });
    const vec = new Float32Array([1, 0]);
    createChunk(db, { source: `note:${n.id}`, content: "promoted", project_id: "p", embedding: vec });
    createChunk(db, { source: "kb:guide.md", content: "kb text", project_id: "p", embedding: vec });
    const sources = (opts: { includeArchived?: boolean } = {}) =>
      semanticSearch(db, vec, { projectId: "p", limit: 10, ...opts }).map((h) => h.chunk.source);

    expect(sources().sort()).toEqual(["kb:guide.md", `note:${n.id}`]);
    archiveNote(db, n.id);
    expect(sources()).toEqual(["kb:guide.md"]);
    expect(sources({ includeArchived: true }).sort()).toEqual(["kb:guide.md", `note:${n.id}`]);
    expect(countChunks(db, "p")).toBe(1);
    unarchiveNote(db, n.id);
    expect(sources()).toHaveLength(2);

    deleteNote(db, n.id);
    expect(listChunksBySource(db, `note:${n.id}`)).toHaveLength(0);
    expect(sources()).toEqual(["kb:guide.md"]);
  });

  // The sweep archives notes because they expired, so an expiry filter on the
  // archive view would hide every note it ever archived.
  it("a note the sweep archived still shows when archived notes are asked for", async () => {
    const tool = new RecallTool(db);
    const swept = createNote(db, {
      content: "compare ferry times for the harbour trip",
      ttl_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(sweepExpiredNotes(db)).toBe(1);

    const list = await tool.execute({ action: "list", includeArchived: true }, makeCtx());
    expect(list.output).toContain(swept.id);
    expect(list.output).toContain(": expired");
    const q = await tool.execute({ action: "query", query: "ferry", includeArchived: true }, makeCtx());
    expect(q.output).toContain(swept.id);

    // An expired note the sweep hasn't reached yet stays out of the live view.
    createNote(db, { content: "expired, not yet swept", ttl_at: new Date(Date.now() - 1000).toISOString() });
    const live = await tool.execute({ action: "list" }, makeCtx());
    expect(live.output).toBe("(no notes)");
  });

  it("a chunk whose note is gone never surfaces, even with includeArchived", () => {
    const vec = new Float32Array([1, 0]);
    createChunk(db, { source: "note:note_gone", content: "orphan", project_id: "p", embedding: vec });
    expect(semanticSearch(db, vec, { projectId: "p", includeArchived: true })).toHaveLength(0);
    expect(countChunks(db, "p", { includeArchived: true })).toBe(0);
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
    // Three notes written back-to-back within the same SQLite-second tick.
    // The list query must still return them newest-insert first (#63: tiebreak
    // on rowid, not the random-hex id).
    await tool.execute({ action: "note", content: "first", project_id: "proj_a" }, makeCtx());
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

  it("action=list orders deterministically when many notes share a created_at second (#63)", async () => {
    const tool = new RecallTool(db);
    // Write 20 notes inside a single tick — without the rowid tiebreak the
    // listing came back in random order (id is `note_${randomHex}`).
    const expected: string[] = [];
    for (let i = 0; i < 20; i++) {
      const content = `note-${String(i).padStart(2, "0")}`;
      expected.push(content);
      await tool.execute({ action: "note", content, project_id: "proj_a" }, makeCtx());
    }
    expected.reverse(); // newest-first

    const list = await tool.execute({ action: "list", project_id: "proj_a", limit: 50 }, makeCtx());
    expect(list.success).toBe(true);
    const positions = expected.map((c) => list.output.indexOf(c));
    // Every content appears, and positions are strictly increasing (i.e.
    // listing matches the reversed insertion order).
    for (let i = 0; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(-1);
      if (i > 0) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
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
    await tool.execute({ action: "note", content: "tagged", tags: ["watcher"], project_id: "proj_a" }, makeCtx());
    await tool.execute({ action: "note", content: "untagged", project_id: "proj_a" }, makeCtx());
    const res = await tool.execute({ action: "list", project_id: "proj_a", tag: "watcher" }, makeCtx());
    expect(res.output).toContain("tagged");
    expect(res.output).not.toContain("untagged");
  });

  it("unknown action errors", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "bogus" }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown action/);
  });

  // `keep` is what `archive` used to mean: the durable marker. It must not hide
  // the note, and the sweep must honour it, which it never did under the old name.
  describe("action=keep", () => {
    it("marks the note kept, records the reason, and leaves it visible", async () => {
      const tool = new RecallTool(db);
      const created = createNote(db, { content: "user wants iMessage support" });
      const res = await tool.execute({ action: "keep", id: created.id, reason: "durable preference" }, makeCtx());
      expect(res.success).toBe(true);
      const after = getNote(db, created.id);
      expect(after?.kept).toBe(true);
      expect(after?.archived_at).toBeNull();
      expect(after?.tags).toContain("keep: durable preference");
      expect(listNotes(db, {}).map((n) => n.id)).toContain(created.id);
    });

    it("survives the sweep past its TTL at low importance", async () => {
      const tool = new RecallTool(db);
      const created = createNote(db, {
        content: "the gate code",
        importance: 0.1,
        ttl_at: new Date(Date.now() - 1000).toISOString(),
      });
      await tool.execute({ action: "keep", id: created.id, reason: "needed every visit" }, makeCtx());
      expect(sweepExpiredNotes(db)).toBe(0);
      expect(getNote(db, created.id)?.archived_at).toBeNull();
    });

    it("says so when the kept note is archived", async () => {
      const tool = new RecallTool(db);
      const created = createNote(db, { content: "x" });
      archiveNote(db, created.id);
      const res = await tool.execute({ action: "keep", id: created.id, reason: "y" }, makeCtx());
      expect(res.output).toContain("It is archived");
    });

    it("requires a reason", async () => {
      const tool = new RecallTool(db);
      const created = createNote(db, { content: "x" });
      const res = await tool.execute({ action: "keep", id: created.id }, makeCtx());
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/reason is required/);
    });

    it("requires an id", async () => {
      const tool = new RecallTool(db);
      const res = await tool.execute({ action: "keep", reason: "x" }, makeCtx());
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/id is required/);
    });

    it("errors on unknown id", async () => {
      const tool = new RecallTool(db);
      const res = await tool.execute({ action: "keep", id: "note_doesnt_exist", reason: "x" }, makeCtx());
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/no note with id/);
    });
  });

  // A note somebody kept under the old meaning has `archival = 1` and no
  // `archived_at`: it reads as kept, and nothing hides it.
  it("an old archival=1 row reads as kept and stays visible", () => {
    const n = createNote(db, { content: "kept the old way" });
    db.prepare("UPDATE notes SET archival = 1 WHERE id = ?").run(n.id);
    expect(getNote(db, n.id)).toMatchObject({ kept: true, archived_at: null });
    expect(listNotes(db, {}).map((x) => x.id)).toContain(n.id);
  });

  describe("action=archive", () => {
    it("requires an id", async () => {
      const tool = new RecallTool(db);
      const res = await tool.execute({ action: "archive", reason: "x" }, makeCtx());
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/id is required/);
    });

    it("is a no-op success on an unknown id", async () => {
      const tool = new RecallTool(db);
      const res = await tool.execute({ action: "archive", id: "note_doesnt_exist" }, makeCtx());
      expect(res.success).toBe(true);
      expect(res.output).toMatch(/no note with id/);
    });
  });

  describe("telemetry write filter", () => {
    const REJECTED = [
      "tick: idle at 22:30",
      "standing by for next instruction",
      "no new material today",
      "email check at 14:00, nothing material",
      "NO_NEW_MAIL",
      "TICK: IDLE", // case-insensitive
    ];

    for (const content of REJECTED) {
      it(`rejects telemetry-prefix: ${content.slice(0, 30)}...`, async () => {
        const tool = new RecallTool(db);
        const res = await tool.execute({ action: "note", content }, makeCtx());
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/telemetry|tick_log/);
      });
    }

    it("allows legitimate notes that mention these phrases mid-sentence", async () => {
      const tool = new RecallTool(db);
      const res = await tool.execute(
        { action: "note", content: "Investigated X; was standing by for a response but none arrived." },
        makeCtx(),
      );
      expect(res.success).toBe(true);
    });
  });
});
