import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteNote, recordNoteHit, runMemorySweep } from "../agent/memory-promotion.js";
import { countChunks, createChunk, listChunksBySource } from "../db/chunk-queries.js";
import { createNote, extendNoteTtl, getNote, incrementNoteRef, listNotes } from "../db/note-queries.js";
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
    await expect(
      recallQuery(backend, { query: "alice", projectId: "p", trackRefs: true }, db),
    ).resolves.not.toThrow();
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

  it("deletes expired low-importance notes (delegates to sweepExpiredNotes)", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    createNote(db, { content: "garbage", project_id: "p", ttl_at: past, importance: 0.2 });
    createNote(db, { content: "keep", project_id: "p", ttl_at: past, importance: 0.9 });
    const report = runMemorySweep(db);
    expect(report.deletedExpired).toBe(1);
    expect(listNotes(db, {}).length).toBe(1);
  });

  it("extends-then-deletes so referenced-but-stale notes survive", () => {
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
    // The extend ran first, so the delete sweep finds nothing expired.
    expect(report.deletedExpired).toBe(0);
    expect(getNote(db, refed.id)).not.toBeNull();
  });

  it("reports remainingNotes + totalChunks counts", () => {
    createNote(db, { content: "a", project_id: "p" });
    createNote(db, { content: "b", project_id: "p" });
    createChunk(db, { source: "x", content: "c", project_id: "p" });
    const report = runMemorySweep(db);
    expect(report.remainingNotes).toBe(2);
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
