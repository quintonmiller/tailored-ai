import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText, indexKbDir, indexNote } from "../agent/memory-index.js";
import {
  countChunks,
  createChunk,
  deleteChunksBySource,
  listChunksBySource,
  semanticSearch,
} from "../db/chunk-queries.js";
import { createNote } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import { blobToVector, cosine, type EmbeddingProvider, vectorToBlob } from "../providers/embedding.js";
import { RecallTool } from "../tools/recall.js";
import { recallQueryAsync } from "../tools/recall-query.js";

let db: Database.Database;
let backend: SqliteMemoryBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
  backend = new SqliteMemoryBackend(db);
});

afterEach(() => {
  db.close();
});

/**
 * Deterministic toy embedder. Maps text to a 3-d "bag-of-keywords" vector so
 * we can reason about which queries should match which content without
 * running a real model.
 */
function toyEmbedder(): EmbeddingProvider {
  const keywords = ["cat", "dog", "weather"];
  function vec(text: string): Float32Array {
    const lower = text.toLowerCase();
    const v = new Float32Array(keywords.length);
    keywords.forEach((k, i) => {
      v[i] = (lower.match(new RegExp(k, "g")) ?? []).length;
    });
    return v;
  }
  return {
    id: "toy",
    name: "toy",
    defaultModel: "toy-3d",
    defaultDim: 3,
    embed: async (inputs) => ({
      vectors: inputs.map(vec),
      model: "toy-3d",
      dim: 3,
    }),
  };
}

describe("vectorToBlob / blobToVector", () => {
  it("round-trips a Float32Array losslessly", () => {
    const v = new Float32Array([1, -2.5, 0, 3.25, 4096]);
    const blob = vectorToBlob(v);
    const back = blobToVector(blob);
    expect(Array.from(back)).toEqual(Array.from(v));
  });
});

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosine(a, a)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosine(a, b)).toBe(0);
  });

  it("returns 0 for zero / mismatched-length inputs", () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
    expect(cosine(new Float32Array([1]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe("chunkText", () => {
  it("returns the original text in one chunk when under max", () => {
    expect(chunkText("hello world", { maxChunkChars: 100 })).toEqual(["hello world"]);
  });

  it("returns empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("slides with overlap when over budget", () => {
    const text = "a".repeat(2000);
    const chunks = chunkText(text, { maxChunkChars: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk is at most maxChunkChars
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    // Coverage: concatenating with the step accounts for the full text.
    expect(chunks[0].length).toBe(1000);
  });

  it("clamps overlap to half of max", () => {
    const text = "x".repeat(100);
    const chunks = chunkText(text, { maxChunkChars: 10, overlap: 100 });
    // Overlap should be clamped to 5; step is 5. So we expect ~20 chunks.
    expect(chunks.length).toBeGreaterThan(10);
  });
});

describe("chunk-queries CRUD + semantic search", () => {
  it("createChunk + listChunksBySource + delete are idempotent", () => {
    const a = createChunk(db, {
      source: "note:abc",
      content: "first",
      project_id: "p",
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      embed_model: "m1",
    });
    const b = createChunk(db, {
      source: "note:abc",
      content: "second",
      project_id: "p",
      embedding: new Float32Array([0.4, 0.5, 0.6]),
    });
    const list = listChunksBySource(db, "note:abc");
    expect(list.length).toBe(2);
    expect(list.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(list[0].embedding).not.toBeNull();
    expect(list[0].metadata).toEqual({});

    expect(deleteChunksBySource(db, "note:abc")).toBe(2);
    expect(listChunksBySource(db, "note:abc")).toEqual([]);
  });

  it("countChunks scopes by project_id", () => {
    createChunk(db, { source: "a", content: "x", project_id: "p" });
    createChunk(db, { source: "b", content: "y", project_id: "p" });
    createChunk(db, { source: "c", content: "z", project_id: null });
    expect(countChunks(db)).toBe(3);
    expect(countChunks(db, "p")).toBe(2);
    expect(countChunks(db, null)).toBe(1);
  });

  it("semanticSearch ranks by cosine and respects projectId + minScore", () => {
    // dim=3, semantic dimension order: cat, dog, weather
    createChunk(db, {
      source: "n:cat",
      content: "all about cats",
      project_id: "p",
      embedding: new Float32Array([1, 0, 0]),
    });
    createChunk(db, {
      source: "n:dog",
      content: "all about dogs",
      project_id: "p",
      embedding: new Float32Array([0, 1, 0]),
    });
    createChunk(db, {
      source: "n:cat-other-proj",
      content: "cats in other project",
      project_id: "q",
      embedding: new Float32Array([1, 0, 0]),
    });

    // Query that's 100% "cat"
    const hits = semanticSearch(db, new Float32Array([1, 0, 0]), {
      projectId: "p",
      limit: 5,
    });
    expect(hits.length).toBe(2);
    expect(hits[0].chunk.source).toBe("n:cat");
    expect(hits[0].score).toBeCloseTo(1);

    // minScore filters out the orthogonal one
    const strict = semanticSearch(db, new Float32Array([1, 0, 0]), {
      projectId: "p",
      minScore: 0.5,
    });
    expect(strict.length).toBe(1);
    expect(strict[0].chunk.source).toBe("n:cat");
  });
});

describe("indexNote", () => {
  it("chunks, embeds, and stores per-note", async () => {
    const embedder = toyEmbedder();
    const note = createNote(db, {
      content: "the cat sat on the mat and barked at the dog",
      project_id: "p",
    });
    const res = await indexNote(db, embedder, note);
    expect(res.chunkCount).toBeGreaterThan(0);
    const stored = listChunksBySource(db, `note:${note.id}`);
    expect(stored.length).toBe(res.chunkCount);
    expect(stored[0].embed_model).toBe("toy-3d");
    expect(stored[0].project_id).toBe("p");
    expect(stored[0].metadata).toMatchObject({ noteId: note.id });
  });

  it("re-running replaces prior chunks (idempotent)", async () => {
    const embedder = toyEmbedder();
    const note = createNote(db, { content: "small cat note", project_id: "p" });
    await indexNote(db, embedder, note);
    await indexNote(db, embedder, note);
    expect(listChunksBySource(db, `note:${note.id}`).length).toBe(1);
  });

  it("returns 0 chunks for empty content", async () => {
    const note = createNote(db, { content: "   ", project_id: "p" });
    const res = await indexNote(db, toyEmbedder(), note);
    expect(res.chunkCount).toBe(0);
  });
});

describe("indexKbDir", () => {
  let kbDir: string;
  beforeEach(() => {
    kbDir = mkdtempSync(join(tmpdir(), "memidx-"));
  });
  afterEach(() => {
    rmSync(kbDir, { recursive: true, force: true });
  });

  it("indexes only .md files and skips silently otherwise", async () => {
    writeFileSync(join(kbDir, "notes.md"), "cat-related notes here");
    writeFileSync(join(kbDir, "skipped.txt"), "ignored");
    const res = await indexKbDir(db, toyEmbedder(), kbDir, { projectId: "p" });
    expect(res.length).toBe(1);
    expect(res[0].source).toBe("kb:notes.md");
    const stored = listChunksBySource(db, "kb:notes.md");
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0].project_id).toBe("p");
    expect(stored[0].metadata).toMatchObject({ file: "notes.md" });
  });

  it("returns [] when the dir doesn't exist", async () => {
    const res = await indexKbDir(db, toyEmbedder(), join(kbDir, "nope"));
    expect(res).toEqual([]);
  });
});

describe("recallQueryAsync merges keyword + semantic", () => {
  it("returns keyword-only when embedder is absent", async () => {
    createNote(db, { content: "the cat sat", project_id: "p" });
    const hits = await recallQueryAsync(backend, { query: "cat", projectId: "p" });
    expect(hits.length).toBe(1);
    expect(hits[0].source).toMatch(/^note_/);
  });

  it("adds semantic hits when an embedder is supplied", async () => {
    const embedder = toyEmbedder();
    // A note whose content contains "feline" — keyword "cat" won't match it.
    const n = createNote(db, { content: "feline friends are great", project_id: "p" });
    // But we manually index it with a vector that aligns with "cat" dim.
    createChunk(db, {
      source: `note:${n.id}`,
      content: n.content,
      project_id: "p",
      embedding: new Float32Array([1, 0, 0]), // cat-axis
      embed_model: "toy-3d",
    });

    const hits = await recallQueryAsync(backend, {
      query: "cat",
      projectId: "p",
      embedder,
      semanticMinScore: 0.1,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain("feline");
  });

  it("respects tier=short by skipping semantic", async () => {
    createChunk(db, {
      source: "kb:foo.md",
      content: "doc text",
      project_id: "p",
      embedding: new Float32Array([1, 0, 0]),
    });
    const hits = await recallQueryAsync(backend, {
      query: "cat",
      projectId: "p",
      tier: "short",
      embedder: toyEmbedder(),
    });
    // No notes seeded — only chunks. Since tier=short skips semantic, we get [].
    expect(hits).toEqual([]);
  });

  it("falls back gracefully when the embedder throws", async () => {
    createNote(db, { content: "keyword cat", project_id: "p" });
    const erroring: EmbeddingProvider = {
      id: "boom",
      name: "boom",
      defaultModel: "x",
      defaultDim: 3,
      embed: async () => {
        throw new Error("network down");
      },
    };
    const hits = await recallQueryAsync(backend, {
      query: "cat",
      projectId: "p",
      embedder: erroring,
    });
    // Keyword hit still comes through.
    expect(hits.length).toBe(1);
  });

  it("dedupes by source when keyword + semantic hit the same note", async () => {
    const embedder = toyEmbedder();
    const n = createNote(db, { content: "cat note", project_id: "p" });
    createChunk(db, {
      source: `note:${n.id}`,
      content: n.content,
      project_id: "p",
      embedding: new Float32Array([1, 0, 0]),
      embed_model: "toy-3d",
    });
    const hits = await recallQueryAsync(backend, {
      query: "cat",
      projectId: "p",
      embedder,
      semanticMinScore: 0.1,
    });
    // One source survives — not two entries for the same note.
    expect(hits.filter((h) => h.source.includes(n.id)).length).toBe(1);
  });
});

describe("RecallTool query action with embedder", () => {
  it("uses semantic when an embedder is wired in", async () => {
    const embedder = toyEmbedder();
    const tool = new RecallTool(db, { getEmbedder: () => embedder });
    const n = createNote(db, { content: "feline observations", project_id: "p" });
    createChunk(db, {
      source: `note:${n.id}`,
      content: n.content,
      project_id: "p",
      embedding: new Float32Array([1, 0, 0]),
      embed_model: "toy-3d",
    });
    const res = await tool.execute(
      { action: "query", query: "cat", project_id: "p" },
      {
        sessionId: "s",
        workingDirectory: process.cwd(),
        env: {},
        agentName: "tester",
      },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain("feline");
  });

  it("works without an embedder (keyword only)", async () => {
    const tool = new RecallTool(db);
    createNote(db, { content: "literal cat", project_id: "p" });
    const res = await tool.execute(
      { action: "query", query: "cat", project_id: "p" },
      {
        sessionId: "s",
        workingDirectory: process.cwd(),
        env: {},
      },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain("literal cat");
  });
});
