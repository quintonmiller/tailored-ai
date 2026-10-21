/**
 * `/api/memory/*` and `/api/facts*` — the Memory page's routes.
 *
 * What these pin down: archived notes and facts stay out of every list,
 * search and count unless `includeArchived=1` asks for them; a person can
 * archive and restore through the API; a person's delete is a real delete
 * that takes the note's search chunks with it; and the notes list with no
 * project means every project, not only global.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  archiveFact,
  archiveNote,
  createChunk,
  createNote,
  getNote,
  initDatabase,
  listNotes,
  type MemoryBackend,
  newSession,
  recordTokenUsage,
  registerMemoryBackendFactory,
  SESSION_SUMMARY_TAG,
  SqliteMemoryBackend,
  saveMessage,
  upsertFact,
} from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../index.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

function buildConfig(memory?: AgentConfig["memory"]): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 100,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 1,
    },
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    ...(memory ? { memory } : {}),
  };
}

let db: ReturnType<typeof initDatabase>;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;
let originalHome: string | undefined;

function start(cfg: AgentConfig) {
  const runtime = new AgentRuntime(
    {
      configPath: join(tmpDir, "config.yaml"),
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      createTools: () => [],
      createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
    },
    () => cfg,
    cfg,
  );
  app = createServer({ runtime }).app;
}

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "memory-routes-"));
  process.env.HOME = tmpDir;
  db = initDatabase(":memory:");
  start(buildConfig());
});

afterEach(() => {
  db.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & Record<string, unknown>[] };
}

type NoteJson = {
  id: string;
  content: string;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
};
type FactJson = { id: string; value: string; archived_at: string | null; archived_by: string | null };

describe("GET /api/memory/notes", () => {
  it("with no project lists every project's notes and the global ones", async () => {
    createNote(db, { content: "in alpha", project_id: "alpha" });
    createNote(db, { content: "in beta", project_id: "beta" });
    createNote(db, { content: "everywhere" });

    const all = await call("GET", "/api/memory/notes");
    expect(all.status).toBe(200);
    expect((all.json as unknown as NoteJson[]).map((n) => n.content).sort()).toEqual([
      "everywhere",
      "in alpha",
      "in beta",
    ]);

    const global = await call("GET", "/api/memory/notes?project=global");
    expect((global.json as unknown as NoteJson[]).map((n) => n.content)).toEqual(["everywhere"]);

    const alpha = await call("GET", "/api/memory/notes?project=alpha");
    expect((alpha.json as unknown as NoteJson[]).map((n) => n.content).sort()).toEqual(["everywhere", "in alpha"]);
  });

  it("leaves archived notes out unless includeArchived=1, which marks them", async () => {
    createNote(db, { content: "live" });
    const gone = createNote(db, { content: "gone" });
    archiveNote(db, gone.id, { by: "assistant", reason: "wrong" });

    const live = await call("GET", "/api/memory/notes");
    expect((live.json as unknown as NoteJson[]).map((n) => n.content)).toEqual(["live"]);

    const all = await call("GET", "/api/memory/notes?includeArchived=1");
    const rows = all.json as unknown as NoteJson[];
    expect(rows).toHaveLength(2);
    expect(rows.find((n) => n.content === "gone")).toMatchObject({ archived_by: "assistant", archive_reason: "wrong" });
    expect(rows.find((n) => n.content === "live")?.archived_at).toBeNull();
  });
});

describe("archiving notes through the API", () => {
  it("archives with a reason as the owner, and unarchive restores", async () => {
    const n = createNote(db, { content: "the old address" });

    const archived = await call("POST", `/api/memory/notes/${n.id}/archive`, { reason: "moved" });
    expect(archived.status).toBe(200);
    expect(archived.json).toMatchObject({ id: n.id, archived_by: "owner", archive_reason: "moved" });
    expect(typeof archived.json.archived_at).toBe("string");

    // Fetching one by id still works and says it's archived.
    const one = await call("GET", `/api/memory/notes/${n.id}`);
    expect(one.status).toBe(200);
    expect(one.json.archive_reason).toBe("moved");

    const restored = await call("POST", `/api/memory/notes/${n.id}/unarchive`);
    expect(restored.status).toBe(200);
    expect(restored.json).toMatchObject({ archived_at: null, archived_by: null, archive_reason: null });
    expect(getNote(db, n.id)?.archived_at).toBeNull();
  });

  it("archives without a body, and 404s an unknown note", async () => {
    const n = createNote(db, { content: "x" });
    const archived = await call("POST", `/api/memory/notes/${n.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.json.archive_reason).toBeNull();
    expect((await call("POST", "/api/memory/notes/note_nope/archive", {})).status).toBe(404);
    expect((await call("POST", "/api/memory/notes/note_nope/unarchive")).status).toBe(404);
  });

  it("a person's delete is for good and takes the note's chunks with it", async () => {
    const n = createNote(db, { content: "promoted", project_id: "p" });
    createChunk(db, { source: `note:${n.id}`, content: "promoted", project_id: "p" });
    const res = await call("DELETE", `/api/memory/notes/${n.id}`);
    expect(res.status).toBe(200);
    expect(getNote(db, n.id)).toBeNull();
    const left = db.prepare("SELECT COUNT(*) AS c FROM memory_chunks").get() as { c: number };
    expect(left.c).toBe(0);
  });

  it("answers 501 when the memory backend can't archive, leaving the note live", async () => {
    // A backend written before archiving existed: everything but the new verbs.
    registerMemoryBackendFactory("no-archive-test", (runtime) => {
      const inner = new SqliteMemoryBackend(runtime.db);
      const backend: MemoryBackend = {
        id: "no-archive-test",
        write: (c, h) => inner.write(c, h),
        query: (q) => inner.query(q),
        get: (id) => inner.get(id),
        list: (q) => inner.list(q),
      };
      return backend;
    });
    start(buildConfig({ backend: { provider: "no-archive-test" } } as AgentConfig["memory"]));
    const n = createNote(db, { content: "x" });
    const res = await call("POST", `/api/memory/notes/${n.id}/archive`, { reason: "r" });
    expect(res.status).toBe(501);
    expect(getNote(db, n.id)?.archived_at).toBeNull();
    expect((await call("POST", `/api/memory/notes/${n.id}/unarchive`)).status).toBe(501);
  });
});

describe("GET /api/memory/recall, /stats and POST /sweep", () => {
  it("recall leaves archived notes out unless asked", async () => {
    createNote(db, { content: "the lighthouse opens at nine" });
    const gone = createNote(db, { content: "the lighthouse is shut" });
    archiveNote(db, gone.id);

    const hits = (await call("GET", "/api/memory/recall?q=lighthouse")).json.hits as { source: string }[];
    expect(hits.map((h) => h.source)).not.toContain(gone.id);
    expect(hits).toHaveLength(1);

    const all = (await call("GET", "/api/memory/recall?q=lighthouse&includeArchived=1")).json.hits as {
      source: string;
      archivedAt?: string;
    }[];
    expect(all.find((h) => h.source === gone.id)?.archivedAt).toBeTruthy();
  });

  it("stats count live records and the archived ones separately", async () => {
    createNote(db, { content: "a" });
    archiveNote(db, createNote(db, { content: "b" }).id);
    upsertFact(db, { category: "c", key: "k1", value: "v" });
    archiveFact(db, upsertFact(db, { category: "c", key: "k2", value: "v" }).id);
    const live = createNote(db, { content: "promoted", project_id: "p" });
    const hidden = createNote(db, { content: "hidden", project_id: "p" });
    createChunk(db, { source: `note:${live.id}`, content: "promoted", project_id: "p" });
    createChunk(db, { source: `note:${hidden.id}`, content: "hidden", project_id: "p" });
    archiveNote(db, hidden.id);

    const { json } = await call("GET", "/api/memory/stats");
    expect(json.counts).toMatchObject({ notes: 2, facts: 1, chunks: 1, archivedNotes: 2, archivedFacts: 1 });
  });

  it("the sweep archives expired notes and reports how many", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const n = createNote(db, { content: "stale", ttl_at: past, importance: 0.1 });
    const { status, json } = await call("POST", "/api/memory/sweep");
    expect(status).toBe(200);
    expect(json).toMatchObject({ archivedExpired: 1, remainingNotes: 0 });
    expect(json).not.toHaveProperty("deletedExpired");
    expect(getNote(db, n.id)).toMatchObject({ archived_by: "sweep", archive_reason: "expired" });

    // It shows under "Show archived", though its TTL has passed.
    const listed = (await call("GET", "/api/memory/notes?includeArchived=1")).json as unknown as NoteJson[];
    expect(listed.map((x) => x.id)).toEqual([n.id]);
    expect((await call("GET", "/api/memory/notes")).json).toEqual([]);
  });
});

describe("/api/facts", () => {
  it("lists leave archived facts out unless includeArchived=1", async () => {
    upsertFact(db, { category: "person", entity: "alice", key: "city", value: "Lisbon" });
    archiveFact(db, upsertFact(db, { category: "person", entity: "alice", key: "phone", value: "123" }).id);

    const live = (await call("GET", "/api/facts")).json.facts as FactJson[];
    expect(live.map((f) => f.value)).toEqual(["Lisbon"]);
    const searched = (await call("GET", "/api/facts?search=123")).json.facts as FactJson[];
    expect(searched).toHaveLength(0);
    const all = (await call("GET", "/api/facts?includeArchived=1")).json.facts as FactJson[];
    expect(all).toHaveLength(2);
    expect(all.find((f) => f.value === "123")?.archived_at).toBeTruthy();
  });

  it("archives and restores by id; fetching by key returns an archived fact, marked", async () => {
    const f = upsertFact(db, { category: "person", entity: "alice", key: "city", value: "Lisbon" });
    const archived = await call("POST", `/api/facts/${f.id}/archive`, { reason: "moved away" });
    expect(archived.status).toBe(200);
    expect(archived.json).toMatchObject({ id: f.id, archived_by: "owner" });

    const byKey = await call("GET", "/api/facts/person/alice/city");
    expect(byKey.status).toBe(200);
    expect(byKey.json.archived_at).toBeTruthy();

    const restored = await call("POST", `/api/facts/${f.id}/unarchive`);
    expect(restored.json.archived_at).toBeNull();
    expect(((await call("GET", "/api/facts")).json.facts as FactJson[]).map((x) => x.id)).toEqual([f.id]);

    expect((await call("POST", "/api/facts/fact_nope/archive")).status).toBe(404);
    expect((await call("POST", "/api/facts/fact_nope/unarchive")).status).toBe(404);
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("writes the parting summary as the session's agent's note", async () => {
    const session = newSession(db, "fake", "fake");
    for (let i = 0; i < 6; i++) {
      saveMessage(db, session.id, { role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` });
    }
    recordTokenUsage(db, { sessionId: session.id, agent: "planner", promptTokens: 1, completionTokens: 1 });

    const res = await call("DELETE", `/api/sessions/${session.id}`);
    expect(res.status).toBe(200);
    const id = res.json.summaryNoteId as string;
    expect(getNote(db, id)?.agent).toBe("planner");
    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG })).toHaveLength(1);
  });

  it("leaves the summary unowned when no named agent ran the session", async () => {
    const session = newSession(db, "fake", "fake");
    for (let i = 0; i < 6; i++) {
      saveMessage(db, session.id, { role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` });
    }
    const res = await call("DELETE", `/api/sessions/${session.id}`);
    expect(getNote(db, res.json.summaryNoteId as string)?.agent).toBeNull();
  });
});
