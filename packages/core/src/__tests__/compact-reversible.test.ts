/**
 * Compaction hides a conversation; it does not destroy it.
 *
 * It used to `DELETE FROM messages` and write a model-authored summary in the
 * originals' place — no archive, no tombstone, no event. A summary that dropped
 * the one fact that mattered dropped it permanently, and that shipped alongside
 * `agent/rewind.ts`, which goes to some length to stay undoable for exactly
 * this reason.
 *
 * These pin the new contract, and the ordering property that makes automatic
 * compaction discussable at all: a provider failure must leave the session
 * untouched rather than hidden behind a summary that never arrived.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactSession, listSessionCompactions, undoCompaction } from "../agent/compact.js";
import { newSession } from "../agent/session.js";
import { getSessionMessages, saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";

let db: Database.Database;

function summarizer(text = "they agreed on the retry policy"): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: false,
    async chat(_params: ChatParams): Promise<ChatResponse> {
      return { content: text, usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  };
}

function brokenProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: false,
    async chat(): Promise<ChatResponse> {
      throw new Error("provider is down");
    },
  };
}

function seed(sessionId: string, n = 6): void {
  for (let i = 0; i < n; i++) {
    saveMessage(db, sessionId, { role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` });
  }
}

/** Every row, including the ones the model can no longer see. */
function rawCount(sessionId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId) as { n: number }).n;
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("compaction is reversible", () => {
  it("hides the conversation from the model", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id);

    await compactSession(db, session.id, summarizer(), "m");

    const visible = getSessionMessages(db, session.id);
    expect(visible).toHaveLength(1);
    expect(visible[0].content).toContain("[Conversation Summary]");
  });

  it("keeps every original row instead of deleting it", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);

    await compactSession(db, session.id, summarizer(), "m");

    // Six originals plus the summary. Before this they were gone.
    expect(rawCount(session.id)).toBe(7);
  });

  it("puts the conversation back, and takes the summary away with it", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);
    await compactSession(db, session.id, summarizer(), "m");

    const undone = undoCompaction(db, session.id);

    expect(undone).toEqual({ restored: 6, batch: 1 });
    const visible = getSessionMessages(db, session.id);
    expect(visible).toHaveLength(6);
    // A summary of the conversation sitting next to the conversation is worse
    // than either alone.
    expect(visible.some((m) => m.content?.includes("[Conversation Summary]"))).toBe(false);
  });

  it("undoes one step at a time, like rewind", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);
    await compactSession(db, session.id, summarizer("first pass"), "m");
    saveMessage(db, session.id, { role: "user", content: "later message" });
    saveMessage(db, session.id, { role: "assistant", content: "later reply" });
    saveMessage(db, session.id, { role: "user", content: "later still" });
    await compactSession(db, session.id, summarizer("second pass"), "m");

    expect(undoCompaction(db, session.id)?.batch).toBe(2);
    // Batch 1 is still folded away — undoing twice walks back two steps.
    expect(listSessionCompactions(db, session.id)).toEqual([{ batch: 1, messages: 6 }]);

    expect(undoCompaction(db, session.id)?.batch).toBe(1);
    expect(listSessionCompactions(db, session.id)).toEqual([]);
  });

  it("returns null when there is nothing to undo", () => {
    const session = newSession(db, "m", "fake");
    seed(session.id);
    expect(undoCompaction(db, session.id)).toBeNull();
  });

  it("reports what is folded away", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);
    await compactSession(db, session.id, summarizer(), "m");

    expect(listSessionCompactions(db, session.id)).toEqual([{ batch: 1, messages: 6 }]);
  });
});

describe("compaction ordering", () => {
  it("leaves the session untouched when the summary never arrives", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);

    await expect(compactSession(db, session.id, brokenProvider(), "m")).rejects.toThrow("provider is down");

    // The precondition for ever running this automatically: a failure must not
    // hide the conversation behind a summary that does not exist.
    expect(getSessionMessages(db, session.id)).toHaveLength(6);
    expect(listSessionCompactions(db, session.id)).toEqual([]);
  });

  it("skips a session too short to be worth compacting, and hides nothing", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 2);

    const result = await compactSession(db, session.id, summarizer(), "m");

    expect(result.skipped).toBe(true);
    expect(getSessionMessages(db, session.id)).toHaveLength(2);
  });

  it("announces itself on the bus so a subscriber can archive or undo it", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);
    const events = new TypedEventBus();
    const seen: Array<Record<string, unknown>> = [];
    events.on("session.compacted", (p) => {
      seen.push(p as unknown as Record<string, unknown>);
    });

    await compactSession(db, session.id, summarizer(), "m", { events });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: session.id, batch: 1, messages: 6 });
  });

  it("emits nothing when the summary failed", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);
    const events = new TypedEventBus();
    const seen: unknown[] = [];
    events.on("session.compacted", (p) => seen.push(p));

    await expect(compactSession(db, session.id, brokenProvider(), "m", { events })).rejects.toThrow();

    expect(seen).toHaveLength(0);
  });
});

describe("compaction and rewind do not collide", () => {
  it("leaves rewound rows hidden rather than adopting them", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);
    db.prepare("UPDATE messages SET rewound_batch = 1 WHERE session_id = ? AND content = ?").run(
      session.id,
      "message 0",
    );

    await compactSession(db, session.id, summarizer(), "m");
    undoCompaction(db, session.id);

    // The rewound message stays rewound: undoing a compaction must not
    // resurrect something a separate rewind deliberately hid.
    const visible = getSessionMessages(db, session.id);
    expect(visible).toHaveLength(5);
    expect(visible.some((m) => m.content === "message 0")).toBe(false);
  });
});

/**
 * All-or-nothing compaction is the wrong trade for a long-running conversation.
 * Measured on a real 1,632-message session: the whole history summarised to 907
 * characters — 534x — which keeps the facts and loses the voice, the running
 * context and every established preference. A keep-recent window means the
 * summary stands in only for the distant past.
 */
describe("partial compaction", () => {
  it("leaves the newest messages visible", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 10);

    await compactSession(db, session.id, summarizer(), "m", { keepRecent: 4 });

    const visible = getSessionMessages(db, session.id);
    // 4 kept + 1 summary.
    expect(visible).toHaveLength(5);
    expect(visible.filter((m) => m.content?.includes("[Conversation Summary]"))).toHaveLength(1);
  });

  it("puts the summary before the messages it precedes", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 10);

    await compactSession(db, session.id, summarizer(), "m", { keepRecent: 4 });

    const visible = getSessionMessages(db, session.id);
    // The summary row is written last and carries the highest id; ordering on
    // the batch is what stops the model reading the ending and then a synopsis
    // of the beginning.
    expect(visible[0].content).toContain("[Conversation Summary]");
    expect(visible[1].content).toBe("message 6");
    expect(visible.at(-1)?.content).toBe("message 9");
  });

  it("summarises only what it hides, not the kept window", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 10);
    const seen: string[] = [];
    const spy: AIProvider = {
      id: "fake",
      name: "fake",
      supportsTools: false,
      async chat(p) {
        seen.push(String(p.messages.at(-1)?.content ?? ""));
        return { content: "summary", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
    };

    await compactSession(db, session.id, spy, "m", { keepRecent: 4 });

    // Sending the kept window to the summariser too would put the same content
    // in the next request twice — once summarised, once verbatim.
    expect(seen[0]).toContain("message 5");
    expect(seen[0]).not.toContain("message 6");
  });

  it("skips when nothing is older than the window", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 6);

    const r = await compactSession(db, session.id, summarizer(), "m", { keepRecent: 20 });

    expect(r.skipped).toBe(true);
    expect(getSessionMessages(db, session.id)).toHaveLength(6);
  });

  it("still restores everything on undo", async () => {
    const session = newSession(db, "m", "fake");
    seed(session.id, 10);
    await compactSession(db, session.id, summarizer(), "m", { keepRecent: 4 });

    undoCompaction(db, session.id);

    const visible = getSessionMessages(db, session.id);
    expect(visible).toHaveLength(10);
    expect(visible.some((m) => m.content?.includes("[Conversation Summary]"))).toBe(false);
  });
});
