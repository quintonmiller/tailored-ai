import { describe, expect, it } from "vitest";
import { nextOccurrence, occurrenceGapSeconds, parseEvery, parseWhen, WhenParseError } from "../schedules/when.js";

/**
 * The time grammar an agent has to hit on the first try.
 *
 * A parser that guesses wrong here books a wake at the wrong hour and nothing
 * downstream can notice — the schedule looks perfectly valid. So the cases that
 * matter most are the refusals: an input this cannot read must fail loudly
 * rather than resolve to something plausible.
 */

// Fixed reference so nothing here depends on when the suite runs.
const NOW = new Date(2026, 7, 6, 14, 30, 0); // Thu 6 Aug 2026, 14:30 local

describe("parseWhen — relative", () => {
  it.each([
    ["10 minutes", 10 * 60],
    ["10 min", 10 * 60],
    ["10m", 10 * 60],
    ["in 45 minutes", 45 * 60],
    ["2 hours", 2 * 3600],
    ["2h", 2 * 3600],
    ["90 seconds", 90],
    ["3 days", 3 * 86400],
    ["2 weeks", 14 * 86400],
  ])("reads %s", (input, seconds) => {
    const { at } = parseWhen(input, NOW);
    expect(at.getTime() - NOW.getTime()).toBe(seconds * 1000);
  });

  it("adds compound durations", () => {
    const { at } = parseWhen("1 hour 30 minutes", NOW);
    expect(at.getTime() - NOW.getTime()).toBe(90 * 60 * 1000);
  });

  it("refuses a duration with words it did not understand", () => {
    // "5 minutes past the hour" is a clock position, not a delay. Reading the
    // "5 minutes" and dropping the rest would book a wake 55 minutes early.
    expect(() => parseWhen("5 minutes past the hour", NOW)).toThrow(WhenParseError);
  });
});

describe("parseWhen — absolute", () => {
  it("reads a date and time", () => {
    const { at, defaultedTime } = parseWhen("2026-08-08 10:00", NOW);
    expect(at).toEqual(new Date(2026, 7, 8, 10, 0, 0));
    expect(defaultedTime).toBe(false);
  });

  it("reads the ISO-ish form with seconds", () => {
    const { at } = parseWhen("2026-08-08T10:00:00", NOW);
    expect(at).toEqual(new Date(2026, 7, 8, 10, 0, 0));
  });

  it("reads a 12-hour clock after a date", () => {
    const { at } = parseWhen("2026-08-08 9am", NOW);
    expect(at).toEqual(new Date(2026, 7, 8, 9, 0, 0));
  });

  it("defaults a date with no time to 09:00 and says so", () => {
    const { at, defaultedTime } = parseWhen("2026-08-08", NOW);
    expect(at).toEqual(new Date(2026, 7, 8, 9, 0, 0));
    // The flag is what makes the tool tell the agent. Without it the assumption
    // is silent, and a date-only booking is exactly where intent diverges.
    expect(defaultedTime).toBe(true);
  });
});

describe("parseWhen — clock and day words", () => {
  it("moves a clock time already past to tomorrow", () => {
    const { at } = parseWhen("9am", NOW); // 09:00 is behind 14:30
    expect(at).toEqual(new Date(2026, 7, 7, 9, 0, 0));
  });

  it("keeps a clock time still ahead on today", () => {
    const { at } = parseWhen("21:30", NOW);
    expect(at).toEqual(new Date(2026, 7, 6, 21, 30, 0));
  });

  it("reads tomorrow with and without a time", () => {
    expect(parseWhen("tomorrow 9am", NOW).at).toEqual(new Date(2026, 7, 7, 9, 0, 0));
    expect(parseWhen("tomorrow at 9am", NOW).at).toEqual(new Date(2026, 7, 7, 9, 0, 0));
    expect(parseWhen("tomorrow", NOW).at).toEqual(new Date(2026, 7, 7, 9, 0, 0));
  });

  it("reads today with a time", () => {
    expect(parseWhen("today 5pm", NOW).at).toEqual(new Date(2026, 7, 6, 17, 0, 0));
  });

  it("refuses a bare number", () => {
    // "10" reads equally as ten minutes and ten o'clock. A wake nine hours off
    // is worse than one the model has to phrase again.
    expect(() => parseWhen("10", NOW)).toThrow(WhenParseError);
  });

  it("lists the accepted forms when it refuses", () => {
    // The error text is the model's only documentation.
    expect(() => parseWhen("sometime next quarter", NOW)).toThrow(/relative[\s\S]*absolute/);
  });

  it("resolves civil time in an explicit zone, independent of the process zone", () => {
    const now = new Date("2026-08-09T19:00:00.000Z"); // Sun noon in Los Angeles
    expect(parseWhen("tomorrow 9am", now, "America/Los_Angeles").at.toISOString()).toBe("2026-08-10T16:00:00.000Z");
  });

  it("uses the post-transition offset when tomorrow crosses spring DST", () => {
    const now = new Date("2026-03-08T07:30:00.000Z"); // Sat 23:30 PST
    expect(parseWhen("tomorrow 9am", now, "America/Los_Angeles").at.toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });

  it("uses the post-transition offset when tomorrow crosses fall DST", () => {
    const now = new Date("2026-11-01T06:30:00.000Z"); // Sat 23:30 PDT
    expect(parseWhen("tomorrow 9am", now, "America/Los_Angeles").at.toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  it("rejects a wall time that does not exist during the spring transition", () => {
    expect(() => parseWhen("2026-03-08 02:30", NOW, "America/Los_Angeles")).toThrow(/does not exist/);
  });
});

describe("parseEvery", () => {
  it("makes plain intervals elapsed time, not cron", () => {
    expect(parseEvery("every 2 hours")).toEqual({ mode: "interval", seconds: 7200, source: "every 2 hours" });
    expect(parseEvery("every 30 minutes")).toEqual({ mode: "interval", seconds: 1800, source: "every 30 minutes" });
    expect(parseEvery("hourly")).toEqual({ mode: "interval", seconds: 3600, source: "hourly" });
  });

  it("supports intervals cron cannot express at all", () => {
    expect(parseEvery("every 3 days")).toEqual({ mode: "interval", seconds: 259200, source: "every 3 days" });
  });

  it("hands clock patterns to the existing schedule DSL", () => {
    expect(parseEvery("weekdays at 9am")).toEqual({ mode: "cron", cron: "0 9 * * 1-5", source: "weekdays at 9am" });
    expect(parseEvery("every monday at 8:30")).toEqual({
      mode: "cron",
      cron: "30 8 * * 1",
      source: "every monday at 8:30",
    });
  });

  it("passes raw cron through", () => {
    expect(parseEvery("15 */6 * * *")).toEqual({ mode: "cron", cron: "15 */6 * * *", source: "15 */6 * * *" });
  });
});

describe("nextOccurrence", () => {
  it("anchors an interval to its start, keeping the phase", () => {
    // The reason intervals do not go through cron. "every 2 hours" compiled to
    // cron fires on even hours and loses the :15, which is not what an agent
    // asking at 10:15 meant.
    const rec = parseEvery("every 2 hours");
    const anchor = new Date(2026, 7, 6, 10, 15, 0);
    const next = nextOccurrence(rec, new Date(2026, 7, 6, 11, 0, 0), anchor);
    expect(next).toEqual(new Date(2026, 7, 6, 12, 15, 0));
  });

  it("returns a future start rather than walking past it", () => {
    const rec = parseEvery("every 2 hours");
    const anchor = new Date(2026, 7, 10, 10, 15, 0);
    expect(nextOccurrence(rec, NOW, anchor)).toEqual(anchor);
  });

  it("skips a whole outage in one step instead of one occurrence at a time", () => {
    // Three hours down on an hourly schedule is one wake, not three. This is
    // the property that keeps a restart from stampeding the agent.
    const rec = parseEvery("every 1 hours");
    const anchor = new Date(2026, 7, 6, 9, 0, 0);
    const after = new Date(2026, 7, 6, 12, 30, 0);
    expect(nextOccurrence(rec, after, anchor)).toEqual(new Date(2026, 7, 6, 13, 0, 0));
  });

  it("advances a cron pattern to the next matching time", () => {
    const rec = parseEvery("weekdays at 9am");
    const next = nextOccurrence(rec, NOW); // Thu 14:30 -> Fri 09:00
    expect(next).toEqual(new Date(2026, 7, 7, 9, 0, 0));
  });

  it("advances cron in the configured timezone", () => {
    const rec = parseEvery("weekdays at 9am");
    const next = nextOccurrence(rec, new Date("2026-08-06T21:30:00.000Z"), null, "America/Los_Angeles");
    expect(next?.toISOString()).toBe("2026-08-07T16:00:00.000Z");
  });
});

describe("occurrenceGapSeconds", () => {
  it("reads an interval directly", () => {
    expect(occurrenceGapSeconds(parseEvery("every 30 minutes"), NOW)).toBe(1800);
  });

  it("measures a cron gap by asking it twice", () => {
    // Cron has no interval field, so the floor can only be enforced by
    // measuring. "every minute" is the case the floor exists to refuse.
    expect(occurrenceGapSeconds(parseEvery("* * * * *"), NOW)).toBe(60);
  });
});
