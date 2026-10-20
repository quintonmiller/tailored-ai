/**
 * The charts on the walls: the measure a chart shows, each day's total from
 * the server's hours on the page's own clock, a scale with round ticks, the
 * numbers in a few characters, and time by activity as bars that say from
 * when it was counted. Nothing made up: a quiet day is a zero.
 */
import { describe, expect, it } from "vitest";
import {
  chartGlance,
  dayChart,
  durationWords,
  lastDays,
  measureOf,
  niceScale,
  perDay,
  type StatsData,
  shortNumber,
  timeChart,
} from "./charts";

/** Noon today on the page's clock, and an hour on a day before it, as the server sends hours. */
const NOW = new Date(2026, 9, 20, 12, 0).getTime();
const hourOn = (daysAgo: number, hour = 10) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const stats: StatsData = {
  days: 14,
  tokens: [
    { hour: hourOn(0), agent: "planner", prompt: 1200, completion: 300, calls: 4 },
    { hour: hourOn(0, 11), agent: "writer", prompt: 800, completion: 200, calls: 2 },
    { hour: hourOn(2), agent: "planner", prompt: 5000, completion: 1000, calls: 9 },
    { hour: hourOn(9), agent: "planner", prompt: 99, completion: 1, calls: 1 },
  ],
  turns: [
    { hour: hourOn(0), agent: "planner", n: 3 },
    { hour: hourOn(1), agent: "writer", n: 2 },
  ],
  done: [{ hour: hourOn(1), agent: "writer", n: 1 }],
  time: [
    { hour: hourOn(0, 9), agent: "planner", what: "searching the web", ms: 40 * 60_000 },
    { hour: hourOn(0, 10), agent: "writer", what: "writing", ms: 25 * 60_000 },
    { hour: hourOn(0, 10), agent: "planner", what: "thinking", ms: 10 * 60_000 },
    { hour: hourOn(3), agent: "planner", what: "searching the web", ms: 60 * 60_000 },
  ],
  since: hourOn(20),
};

describe("which measure a chart shows", () => {
  it("is named in a few ways, and nothing it doesn't know", () => {
    expect(measureOf("Tokens")).toBe("tokens");
    expect(measureOf("tasks done")).toBe("tasks");
    expect(measureOf(" time ")).toBe("time");
    expect(measureOf("weather")).toBeUndefined();
    expect(measureOf(undefined)).toBeUndefined();
  });
});

describe("days on a chart", () => {
  it("are the last days on the page's clock, oldest first, ending with today", () => {
    const days = lastDays(7, NOW);
    expect(days).toHaveLength(7);
    expect(days.at(-1)?.label).toBe("Today");
    expect(days.at(-1)?.start).toBe(new Date(2026, 9, 20).getTime());
    expect(days[0]?.start).toBe(new Date(2026, 9, 14).getTime());
  });

  it("sum each day's hours, of the agents asked about, leaving out hours outside them", () => {
    const days = lastDays(7, NOW);
    expect(perDay(stats.tokens, (r) => r.prompt, days)).toEqual([0, 0, 0, 0, 5000, 0, 2000]);
    expect(perDay(stats.tokens, (r) => r.prompt, days, ["writer"])).toEqual([0, 0, 0, 0, 0, 0, 800]);
  });
});

describe("a chart by the day", () => {
  it("stacks tokens read and written, with today's and the period's totals", () => {
    const c = dayChart(stats, "tokens", 7, NOW);
    expect(c.series.map((s) => s.key)).toEqual(["prompt", "completion"]);
    expect(c.series[1]?.values.at(-1)).toBe(500);
    expect(c.today).toBe(2500);
    expect(c.total).toBe(8500);
  });

  it("counts turns and tasks done, a quiet day a zero", () => {
    expect(dayChart(stats, "turns", 3, NOW).series[0]?.values).toEqual([0, 2, 3]);
    expect(dayChart(stats, "tasks", 3, NOW).series[0]?.values).toEqual([0, 1, 0]);
    expect(dayChart(stats, "tasks", 3, NOW, ["planner"]).total).toBe(0);
  });
});

describe("a scale", () => {
  it("runs from zero in round steps to a top that holds the most", () => {
    expect(niceScale(8500)).toEqual({ max: 10000, step: 2500, ticks: [0, 2500, 5000, 7500, 10000] });
    expect(niceScale(3)).toEqual({ max: 3, step: 1, ticks: [0, 1, 2, 3] });
    expect(niceScale(0.4).max).toBeCloseTo(0.4);
  });

  it("still has an axis when everything is zero", () => {
    expect(niceScale(0)).toEqual({ max: 1, step: 1, ticks: [0, 1] });
  });
});

describe("numbers and times in a few characters", () => {
  it("shortens big numbers", () => {
    expect(shortNumber(950)).toBe("950");
    expect(shortNumber(1234)).toBe("1.2k");
    expect(shortNumber(34_000)).toBe("34k");
    expect(shortNumber(1_500_000)).toBe("1.5M");
    expect(shortNumber(250_000_000)).toBe("250M");
  });

  it("says how long in seconds, minutes, or hours and minutes", () => {
    expect(durationWords(45_000)).toBe("45 s");
    expect(durationWords(12 * 60_000)).toBe("12 min");
    expect(durationWords(130 * 60_000)).toBe("2 h 10 min");
    expect(durationWords(120 * 60_000)).toBe("2 h");
  });
});

describe("time by activity", () => {
  it("adds up each activity over the days given, longest first", () => {
    const t = timeChart(stats, lastDays(1, NOW));
    expect(t.bars).toEqual([
      { what: "searching the web", ms: 40 * 60_000 },
      { what: "writing", ms: 25 * 60_000 },
      { what: "thinking", ms: 10 * 60_000 },
    ]);
    expect(t.total).toBe(75 * 60_000);
    expect(timeChart(stats, lastDays(7, NOW)).bars[0]).toEqual({ what: "searching the web", ms: 100 * 60_000 });
  });

  it("sums what doesn't fit as everything else", () => {
    const t = timeChart(stats, lastDays(1, NOW), undefined, 2);
    expect(t.bars).toEqual([
      { what: "searching the web", ms: 40 * 60_000 },
      { what: "everything else", ms: 35 * 60_000 },
    ]);
  });

  it("says from when it was counted, when that was after the first day began", () => {
    const fresh = { ...stats, since: hourOn(0, 8) };
    expect(timeChart(fresh, lastDays(1, NOW)).since).toBe(Date.parse(fresh.since));
    expect(timeChart(fresh, lastDays(7, NOW), ["writer"]).since).toBe(Date.parse(fresh.since));
    expect(timeChart(stats, lastDays(7, NOW)).since).toBeUndefined();
  });
});

describe("a chart from across a room", () => {
  it("is the measure, today's number and the week's", () => {
    expect(chartGlance(stats, "tokens", NOW).big).toEqual({ text: "2.5k", sub: "today · 8.5k this week" });
    expect(chartGlance(stats, "time", NOW).big?.text).toBe("1 h 15 min");
    expect(chartGlance(undefined, "turns", NOW).empty).toBe("Loading…");
  });
});
