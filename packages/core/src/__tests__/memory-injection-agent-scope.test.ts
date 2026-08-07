/**
 * Whose memories an agent recalls.
 *
 * Auto-injected memory was scoped by project and global only. `parseScope`
 * already understood an `agent:<name>` token and the notes table already had an
 * `agent` column with a filter behind it — the injection path simply never sent
 * one. So any agent with `injectMemory` read every other agent's notes and
 * narrated them as its own recollection, which presents as a persona bug and is
 * very hard to trace back to scoping.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryBlockWithMeta } from "../agent/memory-inject.js";
import { createNote } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { memoryScope } from "../memory/scope.js";
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

async function recallFor(agent: string | undefined, query: string): Promise<string> {
  const meta = await buildMemoryBlockWithMeta(backend, { userMessage: query, projectId: null, agent });
  return meta.block;
}

describe("memoryScope", () => {
  it("keeps the old shape when nobody is named", () => {
    expect(memoryScope(null)).toBe("global");
    expect(memoryScope("proj")).toBe("project:proj");
  });

  it("adds the agent token the backend already knew how to parse", () => {
    expect(memoryScope(null, "coder")).toBe("global agent:coder");
    expect(memoryScope("proj", "coder")).toBe("project:proj agent:coder");
  });
});

describe("injected notes are scoped to the agent", () => {
  it("recalls its own note", async () => {
    createNote(db, { content: "the retry policy is bounded backoff", agent: "coder" });
    expect(await recallFor("coder", "what is the retry policy")).toContain("bounded backoff");
  });

  it("does not recall another agent's note", async () => {
    createNote(db, { content: "the retry policy is bounded backoff", agent: "planner" });
    // The bug: `coder` used to read this and report it as something it knew.
    expect(await recallFor("coder", "what is the retry policy")).not.toContain("bounded backoff");
  });

  it("still recalls notes nobody claimed", async () => {
    // Notes predating authorship, or written by an unnamed session, have a
    // null agent. Hiding those from everyone would be a worse failure than
    // the one being fixed.
    createNote(db, { content: "the retry policy is bounded backoff", agent: null });
    expect(await recallFor("coder", "what is the retry policy")).toContain("bounded backoff");
  });

  it("keeps the cross-agent view for an unnamed session", async () => {
    createNote(db, { content: "the retry policy is bounded backoff", agent: "planner" });
    // No agent name means no `agent:` token, so the scope is what it always
    // was. A session that cannot say whose it is should not silently see less.
    expect(await recallFor(undefined, "what is the retry policy")).toContain("bounded backoff");
  });

  it("separates two agents writing about the same subject", async () => {
    createNote(db, { content: "deploy checklist: run migrations first", agent: "coder" });
    createNote(db, { content: "deploy checklist: notify the customer first", agent: "support" });

    const coder = await recallFor("coder", "deploy checklist");
    const support = await recallFor("support", "deploy checklist");

    expect(coder).toContain("run migrations first");
    expect(coder).not.toContain("notify the customer");
    expect(support).toContain("notify the customer first");
    expect(support).not.toContain("run migrations first");
  });
});

describe("pinned preferences are scoped too", () => {
  it("does not pin another agent's preference into this agent's prompt", async () => {
    createNote(db, { content: "always answer in French", agent: "translator", importance: 0.99 });

    const block = await recallFor("coder", "anything");

    // A pinned note injects regardless of relevance, so an unscoped one lands
    // in every agent's prompt on every turn — the most expensive version of
    // this bug.
    expect(block).not.toContain("always answer in French");
  });

  it("still pins its own", async () => {
    createNote(db, { content: "always answer in French", agent: "translator", importance: 0.99 });
    expect(await recallFor("translator", "anything")).toContain("always answer in French");
  });
});
