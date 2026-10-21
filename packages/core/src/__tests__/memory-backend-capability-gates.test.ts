/**
 * Phase 3 acceptance: tools route every action through MemoryBackend and
 * gate gracefully on optional capabilities. Plugin backends that omit
 * `list` / `delete` get a clear error from the tool instead of crashing.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import type { MemoryBackend } from "../memory/interface.js";
import { CoreMemoryTool } from "../tools/core-memory.js";
import { FactsTool } from "../tools/facts.js";
import type { ToolContext } from "../tools/interface.js";
import { RecallTool } from "../tools/recall.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "sess",
    workingDirectory: "/tmp",
    env: {},
    agentName: "tester",
    projectId: null,
    db,
    ...overrides,
  };
}

/** Minimal backend that only implements the required verbs. */
function makeMinimalBackend(): MemoryBackend {
  return {
    id: "minimal",
    write: async () => ({ id: "minimal:1" }),
    query: async () => [],
  };
}

describe("Phase 3: tool capability gating", () => {
  it("FactsTool.list returns a 'not supported' error when backend.list is missing", async () => {
    const backend = makeMinimalBackend();
    const tool = new FactsTool(db, { getMemoryBackend: async () => backend });
    const res = await tool.execute({ action: "list" }, ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/list is not supported/);
  });

  it("FactsTool.forget returns a 'can't forget' error when backend has neither archive nor delete", async () => {
    const backend = makeMinimalBackend();
    const tool = new FactsTool(db, { getMemoryBackend: async () => backend });
    const res = await tool.execute({ action: "forget", category: "person", entity: "alice", key: "city" }, ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/can't forget facts/);
  });

  it("RecallTool.list returns a 'not supported' error when backend.list is missing", async () => {
    const backend = makeMinimalBackend();
    const tool = new RecallTool(db, { getMemoryBackend: async () => backend });
    const res = await tool.execute({ action: "list" }, ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/list is not supported/);
  });

  it("RecallTool.forget returns a 'can't forget' error when backend has neither archive nor delete", async () => {
    const backend = makeMinimalBackend();
    const tool = new RecallTool(db, { getMemoryBackend: async () => backend });
    const res = await tool.execute({ action: "forget", id: "note_anything" }, ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/can't forget notes/);
  });

  // A backend written before archiving existed has `delete` and no `archive`.
  // `forget` keeps working for it (prompts rely on that) and says it deleted;
  // `archive` refuses rather than claim a hide that didn't happen.
  describe("a backend with delete but no archive", () => {
    function deleteOnlyBackend(deleted: string[]): MemoryBackend {
      return {
        ...makeMinimalBackend(),
        query: async (q) =>
          q.wantStructured ? [{ id: "fact:f1", text: "Lisbon", metadata: { kind: "fact", ...q.wantStructured } }] : [],
        delete: async (id) => {
          deleted.push(id);
          return true;
        },
      };
    }

    it("RecallTool.forget falls back to delete and says it was for good", async () => {
      const deleted: string[] = [];
      const tool = new RecallTool(db, { getMemoryBackend: async () => deleteOnlyBackend(deleted) });
      const res = await tool.execute({ action: "forget", id: "note_anything" }, ctx());
      expect(res.success).toBe(true);
      expect(res.output).toMatch(/deleted note_anything for good/);
      expect(deleted).toEqual(["note:note_anything"]);
    });

    it("RecallTool.archive and unarchive refuse", async () => {
      const deleted: string[] = [];
      const tool = new RecallTool(db, { getMemoryBackend: async () => deleteOnlyBackend(deleted) });
      const archived = await tool.execute({ action: "archive", id: "note_anything" }, ctx());
      expect(archived.success).toBe(false);
      expect(archived.error).toMatch(/can't archive/);
      const restored = await tool.execute({ action: "unarchive", id: "note_anything" }, ctx());
      expect(restored.success).toBe(false);
      expect(restored.error).toMatch(/can't unarchive/);
      expect(deleted).toEqual([]);
    });

    it("FactsTool.forget falls back to delete and says it was for good", async () => {
      const deleted: string[] = [];
      const tool = new FactsTool(db, { getMemoryBackend: async () => deleteOnlyBackend(deleted) });
      const res = await tool.execute({ action: "forget", category: "person", entity: "alice", key: "city" }, ctx());
      expect(res.success).toBe(true);
      expect(res.output).toMatch(/deleted person:alice\/city for good/);
      expect(deleted).toEqual(["fact:f1"]);
    });
  });

  it("CoreMemoryTool.clear returns a 'not supported' error when backend.delete is missing", async () => {
    const backend = makeMinimalBackend();
    const tool = new CoreMemoryTool(db, { getMemoryBackend: async () => backend });
    const res = await tool.execute({ action: "clear", section: "persona" }, ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/delete is not supported/);
  });

  it("FactsTool.set routes through backend.write and works on a minimal backend", async () => {
    const writes: { content: unknown; hint: unknown }[] = [];
    const backend: MemoryBackend = {
      id: "minimal",
      write: async (content, hint) => {
        writes.push({ content, hint });
        return { id: `minimal:${writes.length}` };
      },
      query: async () => [],
    };
    const tool = new FactsTool(db, { getMemoryBackend: async () => backend });
    const res = await tool.execute(
      { action: "set", category: "person", entity: "alice", key: "city", value: "Portland" },
      ctx(),
    );
    expect(res.success).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].hint).toMatchObject({ kind: "fact" });
  });

  it("CoreMemoryTool.set routes through backend.write with kind: prelude", async () => {
    const writes: { content: unknown; hint: unknown }[] = [];
    const backend: MemoryBackend = {
      id: "minimal",
      write: async (content, hint) => {
        writes.push({ content, hint });
        return { id: `minimal:${writes.length}` };
      },
      query: async () => [],
    };
    const tool = new CoreMemoryTool(db, { getMemoryBackend: async () => backend });
    const res = await tool.execute(
      { action: "set", section: "persona", content: "Direct, concise." },
      ctx({ agentName: "tester" }),
    );
    expect(res.success).toBe(true);
    expect(writes[0].hint).toMatchObject({ kind: "prelude" });
  });
});
