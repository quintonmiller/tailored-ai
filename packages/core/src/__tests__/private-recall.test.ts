/**
 * Private recall: an agent reads its own notes plus the ones nobody owns, by
 * every path it has — the recall tool's `query` and `list`, the keyword,
 * pinned and semantic tiers, and prompt injection. An unnamed session keeps
 * the view of everything. Session summaries belong to the session's agent.
 *
 * Injection was scoped this way already; the recall tool and semantic search
 * were not, so an agent could still read another agent's notes by asking, or
 * by the note having been promoted into the search index.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryBlockWithMeta } from "../agent/memory-inject.js";
import { newSession } from "../agent/session.js";
import { SESSION_SUMMARY_TAG, summarizeSession, sweepIdleSessions } from "../agent/summarize-session.js";
import { recordTokenUsage } from "../db/autopilot-queries.js";
import { createChunk } from "../db/chunk-queries.js";
import { createNote, getNote, listNotes } from "../db/note-queries.js";
import { saveMessage, sessionAgent } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import { composeRecentSummary } from "../plugins/session-summarizer.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import type { AIProvider } from "../providers/interface.js";
import { RecallTool } from "../tools/recall.js";

let db: Database.Database;
let backend: SqliteMemoryBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
  backend = new SqliteMemoryBackend(db);
});

afterEach(() => {
  db.close();
});

/** Every text embeds to the same vector, so any chunk in scope is a perfect semantic match. */
function sameVectorEmbedder(): EmbeddingProvider {
  return {
    id: "toy",
    name: "toy",
    defaultModel: "toy",
    defaultDim: 3,
    embed: async (inputs) => ({ vectors: inputs.map(() => new Float32Array([1, 0, 0])), model: "toy", dim: 3 }),
  };
}

function ctx(agentName: string | undefined, projectId: string | null = null) {
  return {
    sessionId: "sess",
    workingDirectory: process.cwd(),
    env: {},
    agentName,
    projectId,
  } as Parameters<RecallTool["execute"]>[1];
}

/** A note plus the chunk promotion would make from it. */
function promoted(content: string, agent: string | null) {
  const note = createNote(db, { content, agent });
  createChunk(db, {
    source: `note:${note.id}`,
    content,
    embedding: new Float32Array([1, 0, 0]),
    metadata: { noteId: note.id },
  });
  return note;
}

describe("the recall tool reads only the caller's own notes and unowned ones", () => {
  it("query", async () => {
    const mine = createNote(db, { content: "the boiler pressure is 1.5 bar", agent: "planner" });
    const theirs = createNote(db, { content: "the boiler service is in May", agent: "writer" });
    const shared = createNote(db, { content: "the boiler is in the cellar", agent: null });
    const tool = new RecallTool(db);

    const res = await tool.execute({ action: "query", query: "boiler", limit: 10 }, ctx("planner"));
    expect(res.output).toContain(mine.id);
    expect(res.output).toContain(shared.id);
    // The bug: `planner` used to read this and report it as something it knew.
    expect(res.output).not.toContain(theirs.id);
  });

  it("list", async () => {
    const mine = createNote(db, { content: "mine", agent: "planner" });
    const theirs = createNote(db, { content: "theirs", agent: "writer" });
    const shared = createNote(db, { content: "shared", agent: null });
    const tool = new RecallTool(db);

    const res = await tool.execute({ action: "list" }, ctx("planner"));
    expect(res.output).toContain(mine.id);
    expect(res.output).toContain(shared.id);
    expect(res.output).not.toContain(theirs.id);
  });

  it("an unnamed session still sees every agent's notes, by query and list", async () => {
    const a = createNote(db, { content: "the boiler pressure is 1.5 bar", agent: "planner" });
    const b = createNote(db, { content: "the boiler service is in May", agent: "writer" });
    const tool = new RecallTool(db);

    const q = await tool.execute({ action: "query", query: "boiler", limit: 10 }, ctx(undefined));
    expect(q.output).toContain(a.id);
    expect(q.output).toContain(b.id);
    const l = await tool.execute({ action: "list" }, ctx(undefined));
    expect(l.output).toContain(a.id);
    expect(l.output).toContain(b.id);
  });

  it("semantic search: another agent's promoted note stays theirs", async () => {
    const theirs = promoted("the vault combination is four eight fifteen", "writer");
    const shared = promoted("the spare key is under the mat", null);
    const tool = new RecallTool(db, { getEmbedder: () => sameVectorEmbedder() });

    // "zebra" matches no note by keyword, so only the semantic tier can answer.
    const res = await tool.execute({ action: "query", query: "zebra", limit: 10 }, ctx("planner"));
    expect(res.output).toContain(`note:${shared.id}`);
    expect(res.output).not.toContain(`note:${theirs.id}`);

    const unnamed = await tool.execute({ action: "query", query: "zebra", limit: 10 }, ctx(undefined));
    expect(unnamed.output).toContain(`note:${theirs.id}`);
  });

  it("KB chunks stay shared", async () => {
    createChunk(db, { source: "kb:house.md", content: "house manual", embedding: new Float32Array([1, 0, 0]) });
    const tool = new RecallTool(db, { getEmbedder: () => sameVectorEmbedder() });
    const res = await tool.execute({ action: "query", query: "zebra" }, ctx("planner"));
    expect(res.output).toContain("kb:house.md");
  });
});

describe("the backend's tiers follow the agent token", () => {
  it("keyword, pinned and semantic tiers leave another agent's notes out", async () => {
    createNote(db, { content: "ferry leaves at noon", agent: "writer" });
    createNote(db, { content: "always use metric", agent: "writer", tags: ["pinned"] });
    const theirs = promoted("unrelated words entirely", "writer");
    const vector = new Float32Array([1, 0, 0]);

    const hits = await backend.query({
      freeText: "ferry",
      vector,
      includePrelude: true,
      scope: "global agent:planner",
      limit: 10,
    });
    expect(hits).toHaveLength(0);

    const theirsHits = await backend.query({
      freeText: "ferry",
      vector,
      includePrelude: true,
      scope: "global agent:writer",
      limit: 10,
    });
    const texts = theirsHits.map((h) => h.text);
    expect(texts).toContain("ferry leaves at noon");
    expect(texts).toContain("always use metric");
    expect(theirsHits.some((h) => h.metadata?.source === `note:${theirs.id}`)).toBe(true);
  });
});

describe("injection, semantic tier included", () => {
  it("doesn't inject another agent's promoted note", async () => {
    promoted("the vault combination is four eight fifteen", "writer");
    const meta = await buildMemoryBlockWithMeta(backend, {
      userMessage: "zebra",
      projectId: null,
      agent: "planner",
      embedder: sameVectorEmbedder(),
    });
    expect(meta.block).not.toContain("vault combination");

    const own = await buildMemoryBlockWithMeta(backend, {
      userMessage: "zebra",
      projectId: null,
      agent: "writer",
      embedder: sameVectorEmbedder(),
    });
    expect(own.block).toContain("vault combination");
  });
});

describe("recall's project defaults to the active project", () => {
  it("query and list read the session's project without being told, plus global", async () => {
    const inProject = createNote(db, { content: "kitchen tiles are grey", project_id: "house" });
    const global = createNote(db, { content: "kitchen scale is digital", project_id: null });
    const elsewhere = createNote(db, { content: "kitchen in the office", project_id: "office" });
    const tool = new RecallTool(db);

    const q = await tool.execute({ action: "query", query: "kitchen", limit: 10 }, ctx("planner", "house"));
    expect(q.output).toContain(inProject.id);
    expect(q.output).toContain(global.id);
    expect(q.output).not.toContain(elsewhere.id);

    const l = await tool.execute({ action: "list" }, ctx("planner", "house"));
    expect(l.output).toContain(inProject.id);
    expect(l.output).not.toContain(elsewhere.id);

    // project_id "global" still means global only.
    const g = await tool.execute({ action: "list", project_id: "global" }, ctx("planner", "house"));
    expect(g.output).toContain(global.id);
    expect(g.output).not.toContain(inProject.id);
  });

  it("a note written in a project session lands in that project", async () => {
    const tool = new RecallTool(db);
    const res = await tool.execute({ action: "note", content: "measure the hallway" }, ctx("planner", "house"));
    const id = res.output.slice("saved ".length);
    expect(getNote(db, id)).toMatchObject({ project_id: "house", agent: "planner" });
  });
});

describe("session summaries belong to the session's agent", () => {
  function stubProvider(summary: string): AIProvider {
    return {
      id: "stub",
      name: "stub",
      supportsTools: true,
      chat: async () => ({ content: summary, usage: { input: 0, output: 0 }, finishReason: "stop" }),
    };
  }

  function seed(sessionId: string, agents: (string | undefined)[]) {
    for (let i = 0; i < 6; i++) {
      saveMessage(db, sessionId, { role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` });
    }
    for (const agent of agents) recordTokenUsage(db, { sessionId, agent, promptTokens: 1, completionTokens: 1 });
  }

  it("sessionAgent is the one named agent that ran it, else null", () => {
    const one = newSession(db, "m", "p");
    seed(one.id, ["planner", "planner", undefined]);
    expect(sessionAgent(db, one.id)).toBe("planner");

    const two = newSession(db, "m", "p");
    seed(two.id, ["planner", "writer"]);
    expect(sessionAgent(db, two.id)).toBeNull();

    const none = newSession(db, "m", "p");
    seed(none.id, [undefined]);
    expect(sessionAgent(db, none.id)).toBeNull();
  });

  it("the idle sweep gives each summary to its session's agent, so other agents can't recall it", async () => {
    const planned = newSession(db, "m", "p");
    seed(planned.id, ["planner"]);
    const anonymous = newSession(db, "m", "p");
    seed(anonymous.id, [undefined]);

    const result = await sweepIdleSessions(db, stubProvider("we chose the blue tiles"), "m", {
      idleMinutes: -1,
      agentFor: (id) => sessionAgent(db, id),
    });
    expect(result.summarized).toHaveLength(2);

    const owners = listNotes(db, { tag: SESSION_SUMMARY_TAG })
      .map((n) => n.agent)
      .sort();
    expect(owners).toEqual(["planner", null].sort());

    const tool = new RecallTool(db);
    const writer = await tool.execute({ action: "query", query: "blue tiles", limit: 10 }, ctx("writer"));
    const plannedNote = listNotes(db, { tag: SESSION_SUMMARY_TAG, agent: "planner" })[0];
    expect(writer.output).not.toContain(plannedNote.id);
  });

  it("summarizeSession leaves the summary unowned unless told", async () => {
    const s = newSession(db, "m", "p");
    seed(s.id, ["planner"]);
    const res = await summarizeSession(db, s.id, stubProvider("summary"), "m");
    expect(getNote(db, res!.noteId)?.agent).toBeNull();
  });

  it("the default agent's recent_summary leaves another named agent's summaries out", () => {
    createNote(db, { content: "default chat", tags: [SESSION_SUMMARY_TAG], agent: "default" });
    createNote(db, { content: "anonymous chat", tags: [SESSION_SUMMARY_TAG], agent: null });
    createNote(db, { content: "planner's session", tags: [SESSION_SUMMARY_TAG], agent: "planner" });
    const out = composeRecentSummary(db, null, { count: 5, maxBytes: 600 });
    expect(out).toContain("default chat");
    expect(out).toContain("anonymous chat");
    expect(out).not.toContain("planner's session");
  });
});
