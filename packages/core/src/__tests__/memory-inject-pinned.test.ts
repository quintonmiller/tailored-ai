import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryBlockWithMeta } from "../agent/memory-inject.js";
import { createNote, listPinnedNotes, updateNote } from "../db/note-queries.js";
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

describe("pinned memory tier (DUX9)", () => {
  it("listPinnedNotes matches tagged + high-importance notes", () => {
    const tagged = createNote(db, {
      content: "always use typescript",
      project_id: "p",
      tags: ["preference", "pinned"],
      importance: 0.85,
    });
    const heavy = createNote(db, {
      content: "skip the explanations",
      project_id: "p",
      tags: ["preference"],
      importance: 0.97,
    });
    createNote(db, {
      content: "casual chat",
      project_id: "p",
      tags: ["chat"],
      importance: 0.4,
    });
    const pinned = listPinnedNotes(db, { project_id: "p" });
    const ids = pinned.map((n) => n.id);
    expect(ids).toContain(tagged.id);
    expect(ids).toContain(heavy.id);
    expect(pinned).toHaveLength(2);
  });

  it("pulls pinned notes from the project AND globally-scoped notes", () => {
    const projectPin = createNote(db, {
      content: "project pref",
      project_id: "p",
      tags: ["pinned"],
    });
    const globalPin = createNote(db, {
      content: "global pref",
      project_id: null,
      tags: ["pinned"],
    });
    const otherProjectPin = createNote(db, {
      content: "other project",
      project_id: "q",
      tags: ["pinned"],
    });
    const ids = listPinnedNotes(db, { project_id: "p" }).map((n) => n.id);
    expect(ids).toContain(projectPin.id);
    expect(ids).toContain(globalPin.id);
    expect(ids).not.toContain(otherProjectPin.id);
  });

  it("always-injects pinned even when the user message doesn't match the content", async () => {
    createNote(db, {
      content: "use british english",
      project_id: "p",
      tags: ["preference", "pinned"],
    });
    const meta = await buildMemoryBlockWithMeta(backend, {
      userMessage: "explain how the cron scheduler works",
      projectId: "p",
    });
    expect(meta.block).toContain("[Pinned preferences]");
    expect(meta.block).toContain("use british english");
    expect(meta.pinned).toHaveLength(1);
  });

  it("dedupes a note that appears in both pinned and relevance tiers", async () => {
    // Build a note that matches the user query AND is pinned.
    const both = createNote(db, {
      content: "always use docker for the python projects",
      project_id: "p",
      tags: ["preference", "pinned"],
    });
    const meta = await buildMemoryBlockWithMeta(backend, {
      userMessage: "docker python",
      projectId: "p",
    });
    expect(meta.pinned.find((p) => p.noteId === both.id)).toBeTruthy();
    // The relevance tier should NOT include the same note again.
    expect(meta.included.find((h) => h.source === both.id)).toBeUndefined();
  });

  it("respects pinnedLimit", async () => {
    for (let i = 0; i < 8; i++) {
      createNote(db, {
        content: `pinned rule ${i}`,
        project_id: "p",
        tags: ["pinned"],
      });
    }
    const meta = await buildMemoryBlockWithMeta(backend, {
      userMessage: "anything",
      projectId: "p",
      pinnedLimit: 3,
    });
    expect(meta.pinned).toHaveLength(3);
  });

  it("returns empty when no pinned and no relevance hits", async () => {
    const meta = await buildMemoryBlockWithMeta(backend, {
      userMessage: "nothing to find",
      projectId: "p",
    });
    expect(meta.block).toBe("");
    expect(meta.pinned).toHaveLength(0);
    expect(meta.included).toHaveLength(0);
  });

  it("updateNote can toggle pinned tag + bump importance", () => {
    const n = createNote(db, {
      content: "draft prefs",
      project_id: "p",
      tags: ["preference"],
      importance: 0.5,
    });
    const pinned = updateNote(db, n.id, {
      tags: ["preference", "pinned"],
      importance: 0.95,
    });
    expect(pinned?.tags).toContain("pinned");
    expect(pinned?.importance).toBe(0.95);
  });
});
