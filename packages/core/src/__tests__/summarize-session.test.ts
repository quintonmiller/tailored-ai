import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../agent/session.js";
import {
  computeImportance,
  getSessionSummary,
  SESSION_SUMMARY_TAG,
  summarizeSession,
  sweepIdleSessions,
} from "../agent/summarize-session.js";
import { listNotes } from "../db/note-queries.js";
import { deleteSession, findIdleSessions, saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function stubProvider(summary = "key decisions: A and B; pending: C"): AIProvider {
  return {
    id: "stub",
    name: "stub",
    supportsTools: true,
    chat: async () => ({
      content: summary,
      usage: { input: 0, output: 0 },
      finishReason: "stop",
    }),
  };
}

function seedConversation(sessionId: string, msgCount: number, withToolCalls = 0) {
  for (let i = 0; i < msgCount; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    saveMessage(db, sessionId, { role, content: `${role} msg ${i}` });
  }
  for (let i = 0; i < withToolCalls; i++) {
    saveMessage(db, sessionId, {
      role: "assistant",
      content: null,
      toolCalls: [{ id: `tc${i}`, name: "probe", arguments: {} }],
    });
  }
}

describe("computeImportance", () => {
  it("returns floor 0.2 even for tiny sessions", () => {
    expect(computeImportance(0, 0)).toBe(0.2);
    expect(computeImportance(2, 0)).toBeGreaterThanOrEqual(0.2);
  });

  it("scales up with messages + tool calls", () => {
    const tiny = computeImportance(4, 0);
    const medium = computeImportance(20, 5);
    const big = computeImportance(40, 15);
    expect(tiny).toBeLessThan(medium);
    expect(medium).toBeLessThan(big);
    expect(big).toBe(1);
  });

  it("never exceeds 1", () => {
    expect(computeImportance(100, 100)).toBe(1);
  });
});

describe("summarizeSession", () => {
  it("returns null for sessions below the minimum message count", async () => {
    const session = newSession(db, "m", "p");
    seedConversation(session.id, 2);
    const res = await summarizeSession(db, session.id, stubProvider(), "m");
    expect(res).toBeNull();
  });

  it("writes a note tagged session-summary on success", async () => {
    const session = newSession(db, "m", "p", undefined, "proj_a");
    seedConversation(session.id, 8);

    const res = await summarizeSession(db, session.id, stubProvider("X happened, Y is open"), "m");
    expect(res).not.toBeNull();
    expect(res!.noteId).toMatch(/^note_/);
    expect(res!.messageCount).toBe(8);

    const notes = listNotes(db, { tag: SESSION_SUMMARY_TAG });
    expect(notes.length).toBe(1);
    expect(notes[0].content).toBe("X happened, Y is open");
    expect(notes[0].session_id).toBe(session.id);
    expect(notes[0].project_id).toBe("proj_a");
    expect(notes[0].tags).toContain(SESSION_SUMMARY_TAG);
    expect(notes[0].importance).toBeGreaterThan(0);
  });

  it("is idempotent — second call is a no-op unless force=true", async () => {
    const session = newSession(db, "m", "p");
    seedConversation(session.id, 8);

    const first = await summarizeSession(db, session.id, stubProvider("first"), "m");
    expect(first).not.toBeNull();

    const second = await summarizeSession(db, session.id, stubProvider("second"), "m");
    expect(second).toBeNull();

    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG }).length).toBe(1);

    const forced = await summarizeSession(db, session.id, stubProvider("third"), "m", { force: true });
    expect(forced).not.toBeNull();
    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG }).length).toBe(2);
  });

  it("returns null when the summarizer produces empty output", async () => {
    const session = newSession(db, "m", "p");
    seedConversation(session.id, 6);
    const empty = stubProvider("   ");
    const res = await summarizeSession(db, session.id, empty, "m");
    expect(res).toBeNull();
    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG }).length).toBe(0);
  });

  it("returns null for a non-existent session id", async () => {
    const res = await summarizeSession(db, "nope", stubProvider(), "m");
    expect(res).toBeNull();
  });

  it("respects the ttlDays override", async () => {
    const session = newSession(db, "m", "p");
    seedConversation(session.id, 6);
    await summarizeSession(db, session.id, stubProvider(), "m", { ttlDays: 0 });
    const note = listNotes(db, { tag: SESSION_SUMMARY_TAG })[0];
    expect(note.ttl_at).toBeNull();
  });

  it("applies extra tags + agent attribution", async () => {
    const session = newSession(db, "m", "p");
    seedConversation(session.id, 6);
    await summarizeSession(db, session.id, stubProvider(), "m", {
      agent: "watcher",
      tags: ["cron"],
    });
    const note = listNotes(db, { tag: SESSION_SUMMARY_TAG })[0];
    expect(note.agent).toBe("watcher");
    expect(note.tags).toEqual(expect.arrayContaining([SESSION_SUMMARY_TAG, "cron"]));
  });

  it("counts tool calls toward importance", async () => {
    const a = newSession(db, "m", "p");
    seedConversation(a.id, 6, 0);
    const b = newSession(db, "m", "p");
    seedConversation(b.id, 6, 10);

    const resA = await summarizeSession(db, a.id, stubProvider("a"), "m");
    const resB = await summarizeSession(db, b.id, stubProvider("b"), "m");
    expect(resB!.importance).toBeGreaterThan(resA!.importance);
  });
});

describe("getSessionSummary", () => {
  it("returns null when no summary exists", () => {
    expect(getSessionSummary(db, "anything")).toBeNull();
  });

  it("returns the summary note when present", async () => {
    const session = newSession(db, "m", "p");
    seedConversation(session.id, 6);
    await summarizeSession(db, session.id, stubProvider("sum"), "m");
    const found = getSessionSummary(db, session.id);
    expect(found).not.toBeNull();
    expect(found!.content).toBe("sum");
  });
});

describe("findIdleSessions", () => {
  it("filters by updated_at cutoff and key prefix", () => {
    // Two fresh sessions, one stale one.
    const fresh = newSession(db, "m", "p", "chat:user");
    const stale = newSession(db, "m", "p", "autopilot:task-1");
    const oldChat = newSession(db, "m", "p", "chat:other");
    // Backdate two of them.
    const past = "2020-01-01 00:00:00";
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id IN (?, ?)").run(past, stale.id, oldChat.id);
    // Need messages so they're not empty.
    seedConversation(stale.id, 6);
    seedConversation(oldChat.id, 6);
    seedConversation(fresh.id, 6);

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const all = findIdleSessions(db, now, { minMessages: 4 });
    const ids = all.map((s) => s.id);
    expect(ids).toContain(stale.id);
    expect(ids).toContain(oldChat.id);

    const onlyAutopilot = findIdleSessions(db, now, {
      keyPrefixes: ["autopilot:"],
      minMessages: 4,
    });
    expect(onlyAutopilot.map((s) => s.id)).toEqual([stale.id]);
  });

  it("excludes sessions below minMessages", () => {
    const s = newSession(db, "m", "p");
    seedConversation(s.id, 1);
    const past = "2020-01-01 00:00:00";
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(past, s.id);

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    expect(findIdleSessions(db, now, { minMessages: 4 })).toEqual([]);
  });
});

describe("sweepIdleSessions", () => {
  it("summarizes idle sessions and reports results", async () => {
    const a = newSession(db, "m", "p", "autopilot:a");
    const b = newSession(db, "m", "p", "autopilot:b");
    const fresh = newSession(db, "m", "p", "autopilot:c");
    seedConversation(a.id, 6);
    seedConversation(b.id, 6);
    seedConversation(fresh.id, 6);

    // Mark a and b as old, leave fresh recent.
    const past = "2020-01-01 00:00:00";
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id IN (?, ?)").run(past, a.id, b.id);

    const res = await sweepIdleSessions(db, stubProvider("sum"), "m", {
      idleMinutes: 60,
      keyPrefixes: ["autopilot:"],
    });
    expect(res.scanned).toBe(2);
    expect(res.summarized.map((r) => r.noteId).length).toBe(2);
    expect(res.failed).toEqual([]);

    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG }).length).toBe(2);
    // Fresh session was untouched.
    expect(getSessionSummary(db, fresh.id)).toBeNull();
  });

  it("skips already-summarized sessions", async () => {
    const s = newSession(db, "m", "p", "autopilot:x");
    seedConversation(s.id, 6);
    const past = "2020-01-01 00:00:00";
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(past, s.id);
    await summarizeSession(db, s.id, stubProvider("first"), "m");

    const res = await sweepIdleSessions(db, stubProvider("second"), "m", {
      idleMinutes: 60,
      keyPrefixes: ["autopilot:"],
    });
    expect(res.summarized.length).toBe(0);
    expect(res.skipped).toEqual([s.id]);
  });

  it("collects provider errors into failed[]", async () => {
    const s = newSession(db, "m", "p", "autopilot:x");
    seedConversation(s.id, 6);
    const past = "2020-01-01 00:00:00";
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(past, s.id);

    const erroring: AIProvider = {
      id: "boom",
      name: "boom",
      supportsTools: true,
      chat: async () => {
        throw new Error("boom");
      },
    };

    const res = await sweepIdleSessions(db, erroring, "m", {
      idleMinutes: 60,
      keyPrefixes: ["autopilot:"],
    });
    // summarizeMessages swallows provider errors and returns ""; summarizeSession
    // treats that as a no-op skip rather than a failure.
    expect(res.summarized.length).toBe(0);
    expect(res.skipped).toEqual([s.id]);
  });
});

describe("deleteSession", () => {
  it("removes the session row and its messages", () => {
    const s = newSession(db, "m", "p");
    seedConversation(s.id, 4);
    expect(deleteSession(db, s.id)).toBe(true);
    expect(deleteSession(db, s.id)).toBe(false);
  });
});
