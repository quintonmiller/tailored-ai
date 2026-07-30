/**
 * Rewind takes a conversation back N turns without deleting anything.
 *
 * `/room reset` already threw the whole conversation away, which is right when
 * it is a total loss and wrong every other time. Conversations usually go bad
 * at an identifiable point — one misread instruction compounded over six
 * turns, one tool result that poisons every later answer — and what you want
 * then is to drop the tail.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countTurns, previewRewind, rewindSession, undoRewind } from "../agent/rewind.js";
import { newSession } from "../agent/session.js";
import { getSessionMessages, saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";

let db: Database.Database;
let sessionId: string;
const KEY = "room:discord.1:kiki";

beforeEach(() => {
  db = initDatabase(":memory:");
  sessionId = newSession(db, "m", "p", KEY).id;
});

afterEach(() => db.close());

/** Three turns, each a user message followed by an assistant reply. */
function seed(): void {
  for (const n of [1, 2, 3]) {
    saveMessage(db, sessionId, { role: "user", content: `ask ${n}` });
    saveMessage(db, sessionId, { role: "assistant", content: `answer ${n}` });
  }
}

const visible = () => getSessionMessages(db, sessionId).map((m) => m.content);
const ids = () => [sessionId];

describe("rewindSession", () => {
  beforeEach(seed);

  it("hides the last turn and everything in it", () => {
    const result = rewindSession(db, KEY, 1);

    expect(result?.turns).toBe(1);
    expect(result?.messages).toBe(2);
    expect(visible()).toEqual(["ask 1", "answer 1", "ask 2", "answer 2"]);
  });

  it("hides several turns at once", () => {
    rewindSession(db, KEY, 2);

    expect(visible()).toEqual(["ask 1", "answer 1"]);
    expect(countTurns(db, ids())).toBe(1);
  });

  /** Deleting would make the operation unauditable, and one turn too many is the obvious mistake. */
  it("hides rather than deletes", () => {
    rewindSession(db, KEY, 2);

    const stored = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId) as {
      n: number;
    };
    expect(stored.n).toBe(6);
  });

  it("quotes the first thing taken back, so an off-by-one is visible", () => {
    expect(rewindSession(db, KEY, 1)?.excerpt).toBe("ask 3");
    expect(rewindSession(db, KEY, 1)?.excerpt).toBe("ask 2");
  });

  it("composes — two rewinds of one turn equal one rewind of two", () => {
    rewindSession(db, KEY, 1);
    rewindSession(db, KEY, 1);

    expect(visible()).toEqual(["ask 1", "answer 1"]);
  });

  it("takes back what exists when asked for more turns than there are", () => {
    const result = rewindSession(db, KEY, 99);

    expect(result?.turns).toBe(3);
    expect(visible()).toEqual([]);
  });

  it("reports nothing to do on an empty conversation", () => {
    const empty = newSession(db, "m", "p", "room:discord.1:nobody").id;
    expect(empty).toBeTruthy();
    expect(rewindSession(db, "room:discord.1:nobody", 1)).toBeNull();
  });

  it("reports nothing to do for a session key that does not exist", () => {
    expect(rewindSession(db, "room:discord.1:ghost", 1)).toBeNull();
  });
});

describe("previewRewind", () => {
  beforeEach(seed);

  it("describes the cut without making it", () => {
    const preview = previewRewind(db, KEY, 2);

    expect(preview?.turns).toBe(2);
    expect(preview?.excerpt).toBe("ask 2");
    expect(visible()).toHaveLength(6);
  });
});

describe("undoRewind", () => {
  beforeEach(seed);

  it("puts back the messages the last rewind hid", () => {
    rewindSession(db, KEY, 2);

    const undone = undoRewind(db, KEY);

    expect(undone?.restored).toBe(4);
    expect(visible()).toEqual(["ask 1", "answer 1", "ask 2", "answer 2", "ask 3", "answer 3"]);
  });

  /** Rewinding twice and undoing once should land one step back, not where you started. */
  it("restores one rewind, not all of them", () => {
    rewindSession(db, KEY, 1);
    rewindSession(db, KEY, 1);

    undoRewind(db, KEY);

    expect(visible()).toEqual(["ask 1", "answer 1", "ask 2", "answer 2"]);
  });

  it("reports nothing to undo when no rewind happened", () => {
    expect(undoRewind(db, KEY)).toBeNull();
  });
});

describe("getSessionMessages", () => {
  beforeEach(seed);

  /**
   * History is re-read from the DB every round, so a rewind has to take effect
   * on the next turn without restarting anything.
   */
  it("skips rewound rows so the model stops seeing them", () => {
    expect(getSessionMessages(db, sessionId)).toHaveLength(6);

    rewindSession(db, KEY, 1);

    expect(getSessionMessages(db, sessionId)).toHaveLength(4);
  });
});
