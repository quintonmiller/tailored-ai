/**
 * Thinking together: a table of agents all thinking at once shares one cue
 * over them, and two side by side, or one alone, keep their own signs.
 */
import { describe, expect, it } from "vitest";
import { SHARED_THINKING, type Thinker, TOGETHER, thinkingTogether, thinkingWords } from "./together";

/** Six seats round a round table about a metre and a half across, as a meeting room lays them out. */
const table = (thinking: (i: number) => boolean): Thinker[] =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI * 2 * i) / 6;
    return { id: `seat-${i + 1}`, at: [1.6 * Math.sin(a), 1.6 * Math.cos(a)], thinking: thinking(i) };
  });

describe("thinkingTogether", () => {
  it("makes everyone thinking round a table one group", () => {
    expect(thinkingTogether(table(() => true))).toEqual([["seat-1", "seat-2", "seat-3", "seat-4", "seat-5", "seat-6"]]);
  });

  it("leaves out whoever round the table isn't thinking", () => {
    expect(thinkingTogether(table((i) => i % 2 === 0))).toEqual([["seat-1", "seat-3", "seat-5"]]);
  });

  it("keeps two thinking side by side, or one alone, to their own signs", () => {
    expect(SHARED_THINKING).toBe(3);
    expect(thinkingTogether(table((i) => i < 2))).toEqual([]);
    expect(thinkingTogether([{ id: "a", at: [0, 0], thinking: true }])).toEqual([]);
  });

  it("joins a long table end to end, each near the next, and keeps a table across the room apart", () => {
    // Eight down a long table a metre apart, and three at a round table well away from it.
    const long: Thinker[] = Array.from({ length: 8 }, (_, i) => ({
      id: `long-${i}`,
      at: [i - 3.5, 0],
      thinking: true,
    }));
    const far: Thinker[] = [0, 1, 2].map((i) => ({ id: `far-${i}`, at: [10 + i * 0.8, 6], thinking: true }));
    const groups = thinkingTogether([...far, ...long]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g[0].startsWith("long"))).toHaveLength(8);
    expect(groups.find((g) => g[0].startsWith("far"))).toHaveLength(3);
  });

  it("counts as together only those within reach of one another", () => {
    const apart: Thinker[] = [0, 1, 2].map((i) => ({ id: `b${i}`, at: [i * (TOGETHER + 0.1), 0], thinking: true }));
    expect(thinkingTogether(apart)).toEqual([]);
    const near: Thinker[] = [0, 1, 2].map((i) => ({ id: `b${i}`, at: [i * (TOGETHER - 0.1), 0], thinking: true }));
    expect(thinkingTogether(near)).toEqual([["b0", "b1", "b2"]]);
  });

  it("says how many are thinking", () => {
    expect(thinkingWords(4)).toBe("4 thinking");
  });
});
