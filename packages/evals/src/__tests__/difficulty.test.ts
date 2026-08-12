import { describe, expect, it } from "vitest";
import { DIFFICULTY_LEVELS, describeDifficulty, MAX_DIFFICULTY, parseDifficultyFilter } from "../difficulty.js";

/**
 * The filter is the whole point of the field: the loop this exists for is "run
 * only the hard ones, read the failures, write harder ones". A spec that
 * silently selected the wrong rows would report a frontier score over a set
 * that quietly included the reflex rows.
 */
describe("parseDifficultyFilter", () => {
  const levels = Array.from({ length: MAX_DIFFICULTY }, (_, i) => i + 1);
  // Derived from the scale rather than written out, so extending it does not
  // leave these quietly testing the old top. `4+` meant "4 and 5" until the
  // scale grew two rungs, and a literal list would still say so.
  const matching = (spec: string) => levels.filter(parseDifficultyFilter(spec));

  it("reads a single level", () => {
    expect(matching("4")).toEqual([4]);
  });

  it("reads N+ as everything from there up", () => {
    expect(matching("4+")).toEqual([4, 5, 6, 7]);
    expect(matching(`${MAX_DIFFICULTY}+`)).toEqual([MAX_DIFFICULTY]);
  });

  it("reads a range, inclusive at both ends", () => {
    expect(matching("2-3")).toEqual([2, 3]);
  });

  it("reads a comma-separated list, and mixed forms", () => {
    expect(matching("1,7")).toEqual([1, 7]);
    expect(matching("1,3-4")).toEqual([1, 3, 4]);
  });

  it("tolerates whitespace, which a shell quote makes easy to introduce", () => {
    expect(matching(" 2 - 3 ")).toEqual([2, 3]);
  });

  it("refuses a spec it cannot read rather than matching nothing", () => {
    // The failure this prevents: an unreadable spec that quietly selects an
    // empty set prints "no scenarios matched", which reads like "nothing is
    // that hard" rather than "you typed it wrong".
    expect(() => parseDifficultyFilter("hard")).toThrow(/not a level/);
    expect(() => parseDifficultyFilter("4-2")).toThrow(/backwards/);
    expect(() => parseDifficultyFilter("")).toThrow(/selected no levels/);
    expect(() => parseDifficultyFilter("9")).toThrow(/outside the 1-7 scale/);
  });
});

describe("the scale", () => {
  it("names every level it claims to span", () => {
    // A level with no name renders as a bare number in every report and error,
    // and the number alone does not tell a reader what it is asserting.
    for (let level = 1; level <= MAX_DIFFICULTY; level++) {
      expect(DIFFICULTY_LEVELS[level], `level ${level}`).toBeTruthy();
      expect(describeDifficulty(level)).toBe(`${level} ${DIFFICULTY_LEVELS[level].name}`);
    }
  });
});
