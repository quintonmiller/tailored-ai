/**
 * When the exploratory worker next takes an agent's turn, as everything that
 * shows it works it out: within the agent's hours, once the day's limit
 * lifts, and not at all while it is switched off or paused.
 */
import { describe, expect, it } from "vitest";
import { nextOwnTurn, ownTurnsOf } from "../exploratory/next-turn.js";

const now = new Date("2026-10-19T22:00:00.000Z");
const state = {
  enabled: true,
  paused_until: null,
  last_tick_at: "2026-10-19T21:50:00.000Z",
  current_interval_ms: null,
  runs_today: 3,
  tokens_today_resets_at: "2026-10-19",
};
const at = (online: Parameters<typeof ownTurnsOf>[1], s: Partial<typeof state> = {}) => {
  const own = ownTurnsOf({ ...state, ...s }, online, "UTC", now);
  const next = own ? nextOwnTurn(own, now.getTime()) : undefined;
  return next === undefined ? undefined : new Date(next).toISOString();
};

describe("an agent's next turn of its own", () => {
  it("is its last turn plus the interval it is on", () => {
    expect(at({ cadence: { interval_minutes: 30 } })).toBe("2026-10-19T22:20:00.000Z");
    // Backed off to an hour: the interval it is on, not the one it was given.
    expect(at({ cadence: { interval_minutes: 30 } }, { current_interval_ms: 3_600_000 })).toBe(
      "2026-10-19T22:50:00.000Z",
    );
  });

  it("waits for its hours to start, when they are over for the day", () => {
    const online = { cadence: { interval_minutes: 30, window: { start: "09:00", end: "17:00" } } };
    // 22:00, every half hour from 09:00 to 17:00: not a turn every half hour through the night, but 09:00.
    expect(at(online)).toBe("2026-10-20T09:00:00.000Z");
    // Its first turn, outside its hours, is when they start; inside them, now.
    expect(at(online, { last_tick_at: null })).toBe("2026-10-20T09:00:00.000Z");
    expect(at({ cadence: { interval_minutes: 30 } }, { last_tick_at: null })).toBe(now.toISOString());
  });

  it("waits for the day's limit to lift once it has had all its turns", () => {
    const online = { cadence: { interval_minutes: 30 }, budgets: { stop_after_runs_per_day: 3 } };
    expect(at(online)).toBe("2026-10-20T00:00:00.000Z");
    // Counted on a day gone by: the limit has lifted.
    expect(at(online, { tokens_today_resets_at: "2026-10-18" })).toBe("2026-10-19T22:20:00.000Z");
    expect(at({ ...online, budgets: { stop_after_runs_per_day: 4 } })).toBe("2026-10-19T22:20:00.000Z");
  });

  it("is none while it is switched off or paused, or when its hours never come", () => {
    expect(at({ cadence: { interval_minutes: 30 } }, { enabled: false })).toBeUndefined();
    expect(at({ cadence: { interval_minutes: 30 } }, { paused_until: "2026-10-20T08:00:00.000Z" })).toBeUndefined();
    // A pause that has run out is no pause.
    expect(at({ cadence: { interval_minutes: 30 } }, { paused_until: "2026-10-19T08:00:00.000Z" })).toBe(
      "2026-10-19T22:20:00.000Z",
    );
    expect(at({ cadence: { interval_minutes: 30, window: { start: "09:00", end: "9:00" } } })).toBeUndefined();
  });
});
