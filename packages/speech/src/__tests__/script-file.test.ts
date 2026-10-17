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
    const { cast } = parseScript("JUNO: a\nGM: b\nJUNO: c\nREX: d");
    expect(cast).toEqual(["JUNO", "GM", "REX"]);
  });

  it("returns nothing for prose with no dialogue at all", () => {
    const { turns, skipped } = parseScript("Just some notes.\nNothing spoken here.");
    expect(turns).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });
});

describe("parseScript delivery directions", () => {
  it("reads a direction from a parenthesis before the colon", () => {
    const { turns } = parseScript("GM (flat, a count not a threat): Give me the ledger.");
    expect(turns).toEqual([{ speaker: "GM", text: "Give me the ledger.", direction: "flat, a count not a threat" }]);
  });

  it("leaves a plain line without one", () => {
    const { turns } = parseScript("GM: Give me the ledger.");
    expect(turns[0].direction).toBeUndefined();
  });

  // Parentheses after the colon are the engine's business, not ours: Kokoro
  // reads them aloud, Breeze performs them as vocal events. Either way the
  // parser must leave them in the text rather than lift them out.
  it("does not take a parenthesis inside the spoken text as a direction", () => {
    const { turns } = parseScript("REX: I check the door (again) before I answer.");
    expect(turns[0].direction).toBeUndefined();
    expect(turns[0].text).toBe("I check the door (again) before I answer.");
  });

  it("still joins consecutive lines when the direction has not changed", () => {
    const { turns } = parseScript("GM (wry): One. \nGM (wry): Then two.");
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("One. Then two.");
  });

  // The reason the join rule had to change. Two deliveries joined into one are
  // rendered in the first's voice, and nothing about the text reveals it —
  // only listening does.
  it("does not join across a change of direction", () => {
    const { turns } = parseScript("GM (flat): The ledger's missing a page.\nGM (louder, stepping in): Give it to me.");
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.direction)).toEqual(["flat", "louder, stepping in"]);
  });

  it("does not join a directed line onto an undirected one", () => {
    const { turns } = parseScript("GM: The lights are out.\nGM (quietly): And the hall is full of water.");
    expect(turns).toHaveLength(2);
  });
});
