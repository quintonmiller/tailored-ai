import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteNote, recordNoteHit, runMemorySweep } from "../agent/memory-promotion.js";
import { countChunks, createChunk, listChunksBySource } from "../db/chunk-queries.js";
import {
  archiveNote,
  createNote,
  extendNoteTtl,
  getNote,
  incrementNoteRef,
  keepNote,
  listNotes,
  unarchiveNote,
} from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { RecallTool } from "../tools/recall.js";
import { recallQuery } from "../tools/recall-query.js";

let db: Database.Database;
let backend: SqliteMemoryBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
  backend = new SqliteMemoryBackend(db);
});

afterEach(() => {
  db.close();
});

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s",
    workingDirectory: process.cwd(),
    env: {},
    agentName: "tester",
    ...overrides,
  } as Parameters<RecallTool["execute"]>[1];
}

function toyEmbedder(): EmbeddingProvider {
  return {
    id: "toy",
    name: "toy",
    defaultModel: "toy",
    defaultDim: 3,
    embed: async (inputs) => ({
      vectors: inputs.map(() => new Float32Array([1, 0, 0])),
      model: "toy",
      dim: 3,
    }),
  };
}

describe("ref_count column", () => {
  it("defaults to 0 on new notes", () => {
    const n = createNote(db, { content: "x", project_id: "p" });
    expect(n.ref_count).toBe(0);
  });

  it("incrementNoteRef bumps and returns the new count", () => {
    const n = createNote(db, { content: "x", project_id: "p" });
    expect(incrementNoteRef(db, n.id)).toBe(1);
    expect(incrementNoteRef(db, n.id)).toBe(2);
    expect(getNote(db, n.id)!.ref_count).toBe(2);
  });

  it("incrementNoteRef returns null when the note is missing", () => {
    expect(incrementNoteRef(db, "note_nope")).toBeNull();
  });
});

describe("extendNoteTtl", () => {
  it("pushes TTL forward by N days", () => {
    const n = createNote(db, {
      content: "x",
      ttl_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const before = getNote(db, n.id)!.ttl_at!;
    const extended = extendNoteTtl(db, n.id, 7);
    expect(extended).not.toBeNull();
    expect(new Date(extended!).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("returns null for notes without a TTL", () => {
    const n = createNote(db, { content: "x", ttl_at: null });
    expect(extendNoteTtl(db, n.id, 7)).toBeNull();
  });

  it("returns null for missing notes", () => {
    expect(extendNoteTtl(db, "note_nope", 7)).toBeNull();
  });
});

describe("promoteNote", () => {
  it("indexes a note into memory_chunks (first call)", async () => {
    const n = createNote(db, { content: "important content", project_id: "p" });
    const res = await promoteNote(db, toyEmbedder(), n.id);
    expect(res).not.toBeNull();
    expect(res!.alreadyPromoted).toBe(false);
    expect(res!.chunkCount).toBeGreaterThan(0);
    expect(listChunksBySource(db, `note:${n.id}`).length).toBe(res!.chunkCount);
  });

  it("returns alreadyPromoted=true on second call (idempotent)", async () => {
    const n = createNote(db, { content: "important content", project_id: "p" });
    await promoteNote(db, toyEmbedder(), n.id);
    const second = await promoteNote(db, toyEmbedder(), n.id);
    expect(second!.alreadyPromoted).toBe(true);
    expect(countChunks(db)).toBe(1);
  });

  it("force re-indexes, replacing existing chunks", async () => {
    const n = createNote(db, { content: "important content", project_id: "p" });
    await promoteNote(db, toyEmbedder(), n.id);
    const reindexed = await promoteNote(db, toyEmbedder(), n.id, { force: true });
    expect(reindexed!.alreadyPromoted).toBe(false);
    expect(countChunks(db)).toBe(1);
  });

  it("returns null for a missing note", async () => {
    expect(await promoteNote(db, toyEmbedder(), "note_nope")).toBeNull();
  });

  it("refuses an archived note, indexing nothing", async () => {
    const n = createNote(db, { content: "important content", project_id: "p" });
    archiveNote(db, n.id);
    const res = await promoteNote(db, toyEmbedder(), n.id);
    expect(res).toMatchObject({ archived: true, chunkCount: 0 });
    expect(listChunksBySource(db, `note:${n.id}`)).toHaveLength(0);
  });
});

describe("recordNoteHit", () => {
  it("increments ref_count and returns the new value", () => {
    const n = createNote(db, { content: "x", project_id: "p" });
    expect(recordNoteHit(db, n.id)).toBe(1);
    expect(recordNoteHit(db, n.id)).toBe(2);
  });

  it("does not auto-promote below threshold even with an embedder", async () => {
    const n = createNote(db, { content: "x", project_id: "p" });
    recordNoteHit(db, n.id, { embedder: toyEmbedder(), threshold: 5 });
    // sync — but the auto-promote is fire-and-forget; let the microtask flush
    await new Promise((r) => setTimeout(r, 10));
    expect(countChunks(db)).toBe(0);
  });

  it("auto-promotes once ref_count >= threshold", async () => {
    const n = createNote(db, { content: "x", project_id: "p" });
    let promoted: { noteId: string; chunkCount: number } | null = null;
    // Use the onPromote callback for deterministic waiting in tests.
    let resolve!: () => void;
    const wait = new Promise<void>((r) => (resolve = r));
    recordNoteHit(db, n.id, {
      embedder: toyEmbedder(),
      threshold: 1,
      onPromote: (r) => {
        promoted = r;
        resolve();
      },
    });
    await wait;
    expect(promoted).not.toBeNull();
    expect(countChunks(db)).toBeGreaterThan(0);
  });

  it("skips promotion when chunks already exist", async () => {
    const n = createNote(db, { content: "x", project_id: "p" });
    createChunk(db, {
      source: `note:${n.id}`,
      content: n.content,
      project_id: "p",
      embedding: new Float32Array([0, 0, 1]),
    });
    let onPromoteFired = false;
    recordNoteHit(db, n.id, {
      embedder: toyEmbedder(),
      threshold: 1,
      onPromote: () => {
        onPromoteFired = true;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(onPromoteFired).toBe(false);
    // Still only the seeded chunk.
    expect(countChunks(db)).toBe(1);
  });

  it("returns null for missing notes without throwing", () => {
    expect(recordNoteHit(db, "note_nope")).toBeNull();
  });

  it("never counts or auto-promotes an archived note", async () => {
    const n = createNote(db, { content: "x", project_id: "p" });
    archiveNote(db, n.id);
    let onPromoteFired = false;
    expect(
      recordNoteHit(db, n.id, {
        embedder: toyEmbedder(),
        threshold: 1,
        onPromote: () => {
          onPromoteFired = true;
        },
      }),
    ).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(onPromoteFired).toBe(false);
    expect(getNote(db, n.id)?.ref_count).toBe(0);
    expect(listChunksBySource(db, `note:${n.id}`)).toHaveLength(0);
  });
});

describe("recallQuery trackRefs", () => {
  it("does not increment ref_count when trackRefs is omitted", async () => {
    const n = createNote(db, { content: "cat", project_id: "p" });
    await recallQuery(backend, { query: "cat", projectId: "p" }, db);
    expect(getNote(db, n.id)!.ref_count).toBe(0);
  });

  it("increments ref_count for note hits when trackRefs is true", async () => {
    const n = createNote(db, { content: "cat", project_id: "p" });
    await recallQuery(backend, { query: "cat", projectId: "p", trackRefs: true }, db);
    expect(getNote(db, n.id)!.ref_count).toBe(1);
  });

  it("ignores fact hits — only notes carry a ref_count", async () => {
    createNote(db, { content: "alice info", project_id: "p" });
    // Re-running shouldn't error; we're just checking nothing crashes when
    // trackHits encounters a fact source label.
    await expect(recallQuery(backend, { query: "alice", projectId: "p", trackRefs: true }, db)).resolves.not.toThrow();
  });
});

describe("runMemorySweep", () => {
  it("extends TTL on referenced notes nearing expiry", () => {
    // Note expiring in 12 hours with high ref_count → should be extended.
    const n = createNote(db, {
      content: "popular",
      project_id: "p",
      ttl_at: new Date(Date.now() + 12 * 3600_000).toISOString(),
    });
    incrementNoteRef(db, n.id);
    incrementNoteRef(db, n.id);
    incrementNoteRef(db, n.id);
    incrementNoteRef(db, n.id);

    const beforeTtl = getNote(db, n.id)!.ttl_at!;
    const report = runMemorySweep(db);
    expect(report.extendedTtl).toBe(1);
    const afterTtl = getNote(db, n.id)!.ttl_at!;
    expect(new Date(afterTtl).getTime()).toBeGreaterThan(new Date(beforeTtl).getTime());
  });

  it("does not extend notes whose TTL is far in the future", () => {
    const n = createNote(db, {
      content: "popular",
      project_id: "p",
      ttl_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    incrementNoteRef(db, n.id);
    incrementNoteRef(db, n.id);
    incrementNoteRef(db, n.id);
    incrementNoteRef(db, n.id);
    const report = runMemorySweep(db);
    expect(report.extendedTtl).toBe(0);
  });

  it("does not extend low-ref notes even when nearing expiry", () => {
    createNote(db, {
      content: "lonely",
      project_id: "p",
      ttl_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const report = runMemorySweep(db);
    expect(report.extendedTtl).toBe(0);
  });

  it("archives expired low-importance notes instead of deleting them", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const garbage = createNote(db, { content: "garbage", project_id: "p", ttl_at: past, importance: 0.2 });
    createNote(db, { content: "keep", project_id: "p", ttl_at: past, importance: 0.9 });
    const report = runMemorySweep(db);
    expect(report.archivedExpired).toBe(1);
    expect(report.remainingNotes).toBe(1);
    expect(listNotes(db, {}).length).toBe(1);
    // Still there, hidden, and stamped so a person can see why.
    expect(listNotes(db, { includeArchived: true }).length).toBe(2);
    expect(getNote(db, garbage.id)).toMatchObject({ archived_by: "sweep", archive_reason: "expired" });
  });

  it("never touches a kept note, however expired and unimportant", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const kept = createNote(db, { content: "the door code", project_id: "p", ttl_at: past, importance: 0.1 });
    keepNote(db, kept.id, "needed every visit");
    // Kept under the old name: `archive` set the flag and left the TTL.
    const old = createNote(db, { content: "the bin day", project_id: "p", ttl_at: past, importance: 0.1 });
    db.prepare("UPDATE notes SET archival = 1 WHERE id = ?").run(old.id);

    const report = runMemorySweep(db);
    expect(report.archivedExpired).toBe(0);
    expect(getNote(db, kept.id)).toMatchObject({ kept: true, archived_at: null });
    expect(getNote(db, old.id)).toMatchObject({ kept: true, archived_at: null });
  });

  // Keeping a note has to keep it readable too. The sweep skipping it was no
  // use while every reader dropped it the moment its TTL passed.
  it("a kept note never expires, so every reader still has it after its TTL", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const kept = createNote(db, {
      content: "the gate code is 4471",
      ttl_at: new Date(Date.now() + 1000).toISOString(),
    });
    keepNote(db, kept.id, "needed every visit");
    expect(getNote(db, kept.id)?.ttl_at).toBeNull();
    // A note kept under the old name still has its TTL; it reads as unexpired.
    const old = createNote(db, { content: "the gate is stiff", ttl_at: past });
    db.prepare("UPDATE notes SET archival = 1 WHERE id = ?").run(old.id);

    const ids = [kept.id, old.id].sort();
    expect(
      listNotes(db, { excludeExpired: true })
        .map((n) => n.id)
        .sort(),
    ).toEqual(ids);
    expect((await backend.list({})).map((f) => f.id?.slice("note:".length)).sort()).toEqual(ids);
    const q = await new RecallTool(db).execute({ action: "query", query: "gate", limit: 10 }, makeCtx());
    expect(q.output).toContain(kept.id);
    expect(q.output).toContain(old.id);
  });

  // The sweep archives notes because they expired. Restoring one with its old
  // TTL left it hidden from every reader and out of the archive view, and the
  // next sweep archived it again.
  it("a note the sweep archived, once restored, is back for good", async () => {
    const swept = createNote(db, {
      content: "compare ferry times",
      ttl_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(runMemorySweep(db).archivedExpired).toBe(1);
    expect(await backend.unarchive(`note:${swept.id}`)).toBe(true);

    expect(getNote(db, swept.id)).toMatchObject({ archived_at: null, ttl_at: null });
    expect((await backend.list({})).map((f) => f.id)).toContain(`note:${swept.id}`);
    const q = await new RecallTool(db).execute({ action: "query", query: "ferry" }, makeCtx());
    expect(q.output).toContain(swept.id);
    expect(runMemorySweep(db).archivedExpired).toBe(0);
  });

  it("restoring keeps a TTL that hasn't passed", () => {
    const ttl = new Date(Date.now() + 86_400_000).toISOString();
    const n = createNote(db, { content: "x", ttl_at: ttl });
    archiveNote(db, n.id);
    expect(unarchiveNote(db, n.id)?.ttl_at).toBe(ttl);
  });

  it("leaves an archived note's stamp alone on the next sweep", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const n = createNote(db, { content: "old", project_id: "p", ttl_at: past });
    archiveNote(db, n.id, { by: "assistant", reason: "wrong" });
    expect(runMemorySweep(db).archivedExpired).toBe(0);
    expect(getNote(db, n.id)).toMatchObject({ archived_by: "assistant", archive_reason: "wrong" });
  });

  it("extends-then-archives so referenced-but-stale notes survive", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const refed = createNote(db, {
      content: "popular but expired",
      project_id: "p",
      ttl_at: past,
    });
    incrementNoteRef(db, refed.id);
    incrementNoteRef(db, refed.id);
    incrementNoteRef(db, refed.id);
    incrementNoteRef(db, refed.id);

    const report = runMemorySweep(db);
    expect(report.extendedTtl).toBe(1);
    // The extend ran first, so the sweep finds nothing expired.
    expect(report.archivedExpired).toBe(0);
    expect(getNote(db, refed.id)?.archived_at).toBeNull();
  });

  it("reports remainingNotes + totalChunks counts", () => {
    createNote(db, { content: "a", project_id: "p" });
    createNote(db, { content: "b", project_id: "p" });
    createChunk(db, { source: "x", content: "c", project_id: "p" });
    const report = runMemorySweep(db);
    expect(report.remainingNotes).toBe(2);
    expect(report.totalChunks).toBe(1);
  });

  it("counts only live notes, and only chunks that can still surface", () => {
    const a = createNote(db, { content: "a", project_id: "p" });
    createNote(db, { content: "b", project_id: "p" });
    createChunk(db, { source: `note:${a.id}`, content: "a", project_id: "p" });
    createChunk(db, { source: "kb:guide.md", content: "kb", project_id: "p" });
    archiveNote(db, a.id);
    const report = runMemorySweep(db);
    expect(report.remainingNotes).toBe(1);
    expect(report.totalChunks).toBe(1);
  });
});

describe("RecallTool promote action", () => {
  it("requires id", async () => {
    const tool = new RecallTool(db, { getEmbedder: () => toyEmbedder() });
    const res = await tool.execute({ action: "promote" }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/id is required/);
  });

  it("requires an embedder to be configured", async () => {
    const tool = new RecallTool(db);
    const n = createNote(db, { content: "x", project_id: "p" });
    const res = await tool.execute({ action: "promote", id: n.id }, makeCtx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/embeddings is not enabled/);
  });

  it("promotes a note and reports chunk count", async () => {
    const tool = new RecallTool(db, { getEmbedder: () => toyEmbedder() });
    const n = createNote(db, { content: "promote me", project_id: "p" });
    const res = await tool.execute({ action: "promote", id: n.id }, makeCtx());
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/promoted note_[a-f0-9]{8} → \d+ chunks/);
  });

  it("returns alreadyPromoted message on second call", async () => {
    const tool = new RecallTool(db, { getEmbedder: () => toyEmbedder() });
    const n = createNote(db, { content: "promote me", project_id: "p" });
    await tool.execute({ action: "promote", id: n.id }, makeCtx());
    const second = await tool.execute({ action: "promote", id: n.id }, makeCtx());
    expect(second.output).toMatch(/already promoted/);
  });

  it("force re-indexes", async () => {
    const tool = new RecallTool(db, { getEmbedder: () => toyEmbedder() });
    const n = createNote(db, { content: "promote me", project_id: "p" });
    await tool.execute({ action: "promote", id: n.id }, makeCtx());
    const reidx = await tool.execute({ action: "promote", id: n.id, force: true }, makeCtx());
    expect(reidx.output).toMatch(/promoted note_/);
  });

  it("takes the note:<id> form query shows for a promoted note", async () => {
    const tool = new RecallTool(db, { getEmbedder: () => toyEmbedder() });
    const n = createNote(db, { content: "promote me", project_id: "p" });
    const res = await tool.execute({ action: "promote", id: `note:${n.id}` }, makeCtx());
    expect(res.output).toMatch(/promoted note:note_[a-f0-9]{8} → \d+ chunks/);
    expect(listChunksBySource(db, `note:${n.id}`).length).toBeGreaterThan(0);
  });

  it("returns no-note marker for unknown id", async () => {
    const tool = new RecallTool(db, { getEmbedder: () => toyEmbedder() });
    const res = await tool.execute({ action: "promote", id: "note_nope" }, makeCtx());
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/no note/);
  });
});

describe("RecallTool query auto-tracks refs", () => {
  it("query increments ref_count on note hits", async () => {
    const tool = new RecallTool(db);
    const n = createNote(db, { content: "find me", project_id: "p" });
    await tool.execute({ action: "query", query: "find me", project_id: "p" }, makeCtx());
    expect(getNote(db, n.id)!.ref_count).toBe(1);
  });

  it("query auto-promotes when ref_count crosses threshold", async () => {
    const tool = new RecallTool(db, { getEmbedder: () => toyEmbedder() });
    const n = createNote(db, { content: "find me", project_id: "p" });
    // Default threshold is 3 — hit three times.
    for (let i = 0; i < 3; i++) {
      await tool.execute({ action: "query", query: "find me", project_id: "p" }, makeCtx());
    }
    // Auto-promote is fire-and-forget; give it a moment.
    await new Promise((r) => setTimeout(r, 20));
    expect(getNote(db, n.id)!.ref_count).toBe(3);
    expect(listChunksBySource(db, `note:${n.id}`).length).toBeGreaterThan(0);
  });
});
