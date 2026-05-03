import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBudget,
  getAutopilotSettings,
  getTokenUsageInWindow,
  isInTimeWindow,
  isInDisabledHours,
  isInQuietHours,
  recordTokenUsage,
  updateAutopilotSettings,
} from "../db/autopilot-queries.js";
import { initDatabase } from "../db/schema.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("autopilot settings", () => {
  it("initializes with defaults on first init", () => {
    const s = getAutopilotSettings(db);
    expect(s.paused).toBe(false);
    expect(s.token_cap_1h).toBeNull();
    expect(s.token_cap_24h).toBeNull();
    expect(s.quiet_start).toBeNull();
    expect(s.disabled_start).toBeNull();
  });

  it("updates fields and round-trips through the row", () => {
    const updated = updateAutopilotSettings(db, {
      token_cap_1h: 10_000,
      token_cap_24h: 200_000,
      quiet_start: "22:00",
      quiet_end: "07:00",
      paused: true,
    });
    expect(updated.token_cap_1h).toBe(10_000);
    expect(updated.token_cap_24h).toBe(200_000);
    expect(updated.quiet_start).toBe("22:00");
    expect(updated.paused).toBe(true);

    const fetched = getAutopilotSettings(db);
    expect(fetched.paused).toBe(true);
    expect(fetched.token_cap_1h).toBe(10_000);
  });

  it("clears fields with null", () => {
    updateAutopilotSettings(db, { token_cap_1h: 10_000 });
    const cleared = updateAutopilotSettings(db, { token_cap_1h: null });
    expect(cleared.token_cap_1h).toBeNull();
  });
});

describe("token usage", () => {
  it("records and sums within a window", () => {
    recordTokenUsage(db, { promptTokens: 100, completionTokens: 50 });
    recordTokenUsage(db, { promptTokens: 200, completionTokens: 25 });

    const total = getTokenUsageInWindow(db, 1);
    expect(total).toBe(375);
  });

  it("excludes usage older than the window", () => {
    db.prepare(
      "INSERT INTO token_usage (prompt_tokens, completion_tokens, created_at) VALUES (?, ?, datetime('now', '-2 hours'))",
    ).run(1000, 500);
    recordTokenUsage(db, { promptTokens: 100, completionTokens: 50 });

    expect(getTokenUsageInWindow(db, 1)).toBe(150);
    expect(getTokenUsageInWindow(db, 5)).toBe(1650);
  });
});

describe("checkBudget", () => {
  it("returns not exceeded when no caps set", () => {
    recordTokenUsage(db, { promptTokens: 10_000_000, completionTokens: 10_000_000 });
    const status = checkBudget(db);
    expect(status.exceeded).toBe(false);
  });

  it("reports the first exceeded window", () => {
    updateAutopilotSettings(db, { token_cap_1h: 100, token_cap_24h: 1000 });
    recordTokenUsage(db, { promptTokens: 80, completionTokens: 30 });

    const status = checkBudget(db);
    expect(status.exceeded).toBe(true);
    expect(status.window).toBe("1h");
    expect(status.usage).toBe(110);
    expect(status.cap).toBe(100);
  });

  it("reports a later window when earlier caps aren't hit", () => {
    updateAutopilotSettings(db, { token_cap_1h: 10_000, token_cap_24h: 100 });
    recordTokenUsage(db, { promptTokens: 80, completionTokens: 30 });

    const status = checkBudget(db);
    expect(status.exceeded).toBe(true);
    expect(status.window).toBe("24h");
  });

  it("ignores caps set to 0 or null", () => {
    updateAutopilotSettings(db, { token_cap_1h: 0, token_cap_24h: null });
    recordTokenUsage(db, { promptTokens: 10_000, completionTokens: 10_000 });

    expect(checkBudget(db).exceeded).toBe(false);
  });
});

describe("time window helpers", () => {
  it("matches when inside a same-day window", () => {
    const noon = new Date("2026-01-01T12:00:00");
    expect(isInTimeWindow("09:00", "17:00", noon)).toBe(true);
  });

  it("does not match outside a same-day window", () => {
    const morning = new Date("2026-01-01T08:00:00");
    expect(isInTimeWindow("09:00", "17:00", morning)).toBe(false);
  });

  it("matches midnight-crossing windows", () => {
    const late = new Date("2026-01-01T23:30:00");
    const early = new Date("2026-01-01T03:00:00");
    const mid = new Date("2026-01-01T12:00:00");

    expect(isInTimeWindow("22:00", "07:00", late)).toBe(true);
    expect(isInTimeWindow("22:00", "07:00", early)).toBe(true);
    expect(isInTimeWindow("22:00", "07:00", mid)).toBe(false);
  });

  it("returns false when bounds missing or invalid", () => {
    expect(isInTimeWindow(null, "07:00")).toBe(false);
    expect(isInTimeWindow("22:00", null)).toBe(false);
    expect(isInTimeWindow("bad", "07:00")).toBe(false);
  });

  it("isInDisabledHours / isInQuietHours read the right fields", () => {
    updateAutopilotSettings(db, {
      disabled_start: "00:00",
      disabled_end: "06:00",
      quiet_start: "22:00",
      quiet_end: "23:00",
    });
    const settings = getAutopilotSettings(db);

    expect(isInDisabledHours(settings, new Date("2026-01-01T03:00:00"))).toBe(true);
    expect(isInDisabledHours(settings, new Date("2026-01-01T12:00:00"))).toBe(false);
    expect(isInQuietHours(settings, new Date("2026-01-01T22:30:00"))).toBe(true);
  });
});
