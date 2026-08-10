/**
 * A clock the benchmark controls.
 *
 * The bug this closes never failed a scenario, which is why it was worth
 * closing: several scenarios book wakes from wall-clock phrases, so a published
 * baseline only reproduced on a similar day, and a result that moved because of
 * the calendar would have read as a result that moved because of the code. The
 * same latent bug in a unit test turned CI red on `main` — "every monday at
 * 8:30 within the next two hours" is a false assertion for two hours a week.
 */

import { describe, expect, it } from "vitest";
import { type AgentConfig, DEFAULT_CONFIG, resolveTimeProvider } from "@tailored-ai/core";
import { DEFAULT_PINNED_AT, DEFAULT_TIMEZONE, registerPinnedClock, timeConfigBlock } from "../clock.js";

registerPinnedClock();

function resolve(time: unknown) {
  return resolveTimeProvider({ ...structuredClone(DEFAULT_CONFIG), time } as AgentConfig);
}

describe("the pinned clock", () => {
  it("reports the instant it was pinned to, not the host's", () => {
    const clock = resolve(timeConfigBlock({ pinnedAt: "2026-08-12T17:00:00.000Z" }));

    // Within a second of the pin: it starts there and advances from there.
    const drift = Math.abs(clock.now().getTime() - Date.parse("2026-08-12T17:00:00.000Z"));
    expect(drift).toBeLessThan(1000);
  });

  it("advances, because a stopped clock breaks everything that measures elapsed time", async () => {
    // The design property, not a detail. Recorded latency, the schedule
    // runner's poll tick and retry backoff all read the difference between two
    // readings; freeze it and they see zero for ever.
    const clock = resolve(timeConfigBlock({ pinnedAt: "2026-08-12T17:00:00.000Z" }));

    const first = clock.now().getTime();
    await new Promise((r) => setTimeout(r, 25));
    const second = clock.now().getTime();

    expect(second).toBeGreaterThan(first);
  });

  it("pins the timezone too, so day rollover does not depend on the host", () => {
    const clock = resolve(timeConfigBlock({ pinnedAt: DEFAULT_PINNED_AT, timeZone: "Asia/Tokyo" }));

    expect(clock.timeZone()).toBe("Asia/Tokyo");
    expect(clock.timeZoneSource).toBe("config");
  });

  it("defaults to a Wednesday, clear of the boundary that broke the schedule test", () => {
    const clock = resolve(timeConfigBlock({}));

    const day = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: DEFAULT_TIMEZONE }).format(clock.now());
    expect(day).toBe("Wednesday");
  });

  it("refuses an unparseable instant rather than silently running on the host clock", () => {
    expect(() => resolve({ provider: "pinned", options: { at: "next tuesday" } })).toThrow(/Invalid time\.options\.at/);
  });

  it("emits no time block when pinning is switched off", () => {
    // `--pinned-at off` has to reach the old behaviour exactly: no `time` key,
    // so the runtime resolves `system` the way every deployment does.
    expect(timeConfigBlock({ pinnedAt: null })).toBeUndefined();
  });

  it("can be registered twice, because a worker may build more than one runtime", () => {
    expect(() => {
      registerPinnedClock();
      registerPinnedClock();
    }).not.toThrow();
  });
});
