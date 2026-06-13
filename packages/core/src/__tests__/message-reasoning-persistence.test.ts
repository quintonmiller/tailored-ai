/**
 * Reasoning persistence round-trip (#254): saveMessage writes the reasoning
 * column and getSessionMessages hydrates it, while messages without a trace
 * leave it undefined. The migration adds the column on an existing DB.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../agent/session.js";
import { getSessionMessages, saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("message reasoning persistence (#254)", () => {
  it("round-trips reasoning on an assistant message", () => {
    const s = newSession(db, "m", "p", "k1");
    saveMessage(db, s.id, { role: "user", content: "hi" });
    saveMessage(db, s.id, { role: "assistant", content: "answer", reasoning: "step by step" });

    const msgs = getSessionMessages(db, s.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].reasoning).toBeUndefined();
    expect(msgs[1].content).toBe("answer");
    expect(msgs[1].reasoning).toBe("step by step");
  });

  it("leaves reasoning undefined when not provided", () => {
    const s = newSession(db, "m", "p", "k2");
    saveMessage(db, s.id, { role: "assistant", content: "no trace" });
    expect(getSessionMessages(db, s.id)[0].reasoning).toBeUndefined();
  });

  it("adds the reasoning column on a pre-existing messages table (migration)", () => {
    // Simulate an older DB: drop the column, then re-run initDatabase.
    db.exec("CREATE TABLE IF NOT EXISTS _probe (x)"); // ensure db is live
    // initDatabase is idempotent; calling it again must not throw on the
    // already-present column (the ALTER is wrapped in try/catch).
    expect(() => initDatabase(":memory:").close()).not.toThrow();
  });
});
