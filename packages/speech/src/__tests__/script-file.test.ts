import { describe, expect, it } from "vitest";
import { parseScript } from "../script-file.js";

describe("parseScript", () => {
  it("reads SPEAKER: line dialogue", () => {
    const { turns, cast } = parseScript("GM: You are in a back room.\nREX: So what's the job?");
    expect(turns).toEqual([
      { speaker: "GM", text: "You are in a back room." },
      { speaker: "REX", text: "So what's the job?" },
    ]);
    expect(cast).toEqual(["GM", "REX"]);
  });

  it("skips act headings and blank lines, and says how many", () => {
    const { turns, skipped } = parseScript("ACT 1 - THE JOB\n\nGM: Hello.\n\n--- scene break ---\n");
    expect(turns).toHaveLength(1);
    expect(skipped).toEqual(["ACT 1 - THE JOB", "--- scene break ---"]);
  });

  it("joins consecutive lines from one speaker into one utterance", () => {
    // A paragraph break is not worth re-priming the voice for.
    const { turns } = parseScript("GM: The case is warm.\nGM: Sully is watching your hands.");
    expect(turns).toEqual([{ speaker: "GM", text: "The case is warm. Sully is watching your hands." }]);
  });

  it("does not treat a colon inside a sentence as a speaker", () => {
    // Without the length bound this parses as a speaker called
    // "The rule is simple" and fails casting with a baffling message.
    const { turns } = parseScript("GM: The rule is simple: do not open the case.");
    expect(turns).toEqual([{ speaker: "GM", text: "The rule is simple: do not open the case." }]);
  });

  it("keeps first-appearance order in the cast", () => {
    const { cast } = parseScript("MARA: a\nGM: b\nMARA: c\nREX: d");
    expect(cast).toEqual(["MARA", "GM", "REX"]);
  });

  it("returns nothing for prose with no dialogue at all", () => {
    const { turns, skipped } = parseScript("Just some notes.\nNothing spoken here.");
    expect(turns).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });
});
