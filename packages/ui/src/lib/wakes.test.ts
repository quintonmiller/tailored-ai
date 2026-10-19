/**
 * When an agent that runs on its own next takes a turn: its last turn plus
 * its interval, held back by a pause, and never in the past.
 */
import { describe, expect, it } from "vitest";
import { nextTurn, type OwnTurns } from "./wakes";

const now = Date.UTC(2026, 9, 10, 12);
const agent = (over: Partial<OwnTurns> = {}): OwnTurns => ({
  enabled_in_state: true,
  paused_until: null,
  last_tick_at: "2026-10-10T11:50:00.000Z",
  current_interval_ms: 30 * 60_000,
  cadence: { interval_minutes: 15 },
  ...over,
});

describe("nextTurn", () => {
  it("is its last turn plus the interval it has backed off to", () => {
    expect(nextTurn(agent(), now)).toEqual({ kind: "due", at: Date.UTC(2026, 9, 10, 12, 20), every: 30 * 60_000 });
  });

  it("falls back to the interval it was given before it has backed off", () => {
    expect(nextTurn(agent({ current_interval_ms: null }), now)).toMatchObject({ at: Date.UTC(2026, 9, 10, 12, 5) });
  });

  it("is now when it is already due, or has never run", () => {
    expect(nextTurn(agent({ last_tick_at: "2026-10-10T09:00:00.000Z" }), now)).toMatchObject({ at: now });
    expect(nextTurn(agent({ last_tick_at: null }), now)).toMatchObject({ kind: "due", at: now });
  });

  it("waits out a pause, and says when one is over", () => {
    expect(nextTurn(agent({ paused_until: "2026-10-10T16:00:00.000Z" }), now)).toEqual({
      kind: "paused",
      until: Date.UTC(2026, 9, 10, 16),
    });
    // A pause that has run out is no pause.
    expect(nextTurn(agent({ paused_until: "2026-10-10T08:00:00.000Z" }), now).kind).toBe("due");
  });

  it("says when it is switched off, and when there is nothing to tell the time by", () => {
    expect(nextTurn(agent({ enabled_in_state: false }), now)).toEqual({ kind: "off" });
    expect(nextTurn(agent({ current_interval_ms: null, cadence: null }), now)).toEqual({ kind: "unknown" });
  });
});
