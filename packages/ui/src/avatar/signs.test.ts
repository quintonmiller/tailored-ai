/**
 * The words in a speech bubble: a glimpse of what was said, wrapped into a
 * few short lines, cut short with an ellipsis when there is more.
 */
import { describe, expect, it } from "vitest";
import { wrap } from "./signs";

describe("wrap", () => {
  it("keeps a short line as it is", () => {
    expect(wrap("On it.")).toEqual(["On it."]);
  });

  it("breaks between words, never past the width", () => {
    const lines = wrap("Flights are booked for Thursday and the hotel is next on my list");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    expect(lines.join(" ")).toBe("Flights are booked for Thursday and the hotel is next on my list");
  });

  it("stops at three lines, the last ending in an ellipsis", () => {
    const lines = wrap("word ".repeat(60));
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith("…")).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
  });

  it("cuts a word too long for any line", () => {
    const [line] = wrap("x".repeat(80));
    expect(line.length).toBeLessThanOrEqual(30);
    expect(line.endsWith("…")).toBe(true);
  });
});
