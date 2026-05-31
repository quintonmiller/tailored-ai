import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { appendTickLog, listTickLogsByTickId } from "../db/tick-log-queries.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("listTickLogsByTickId", () => {
  it("returns rows for the given tick_id in ascending order", () => {
    const tickId = "tick-abc";
    const otherId = "tick-xyz";

    const row1 = appendTickLog(db, { tick_id: tickId, agent: "default", kind: "start", summary: "first" });
    const _row2 = appendTickLog(db, { tick_id: tickId, agent: "default", kind: "material", summary: "second" });
    const row3 = appendTickLog(db, { tick_id: tickId, agent: "default", kind: "noop", summary: "third" });
    appendTickLog(db, { tick_id: otherId, agent: "default", kind: "start", summary: "other" });

    const results = listTickLogsByTickId(db, tickId);

    expect(results).toHaveLength(3);
    expect(results[0].kind).toBe("start");
    expect(results[1].kind).toBe("material");
    expect(results[2].kind).toBe("noop");
    expect(results[0].id).toBe(row1.id);
    expect(results[2].id).toBe(row3.id);
  });

  it("returns empty array when tick_id has no logs", () => {
    const results = listTickLogsByTickId(db, "nonexistent");
    expect(results).toHaveLength(0);
  });
});
