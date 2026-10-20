import { describe, expect, it } from "vitest";
import { inOrder, Turns } from "./turns";

/** What is in the bubble at each clock time: the words, or nothing. */
function bubble(turns: Turns<string>, times: number[]): (string | undefined)[] {
  return times.map((t) => {
    turns.tick(t);
    return turns.speaking(t) ? turns.now?.what : undefined;
  });
}

describe("lines in turn", () => {
  it("keeps a line up until the one said after it is due, then shows that one", () => {
    const turns = new Turns<string>();
    expect(turns.add("question", 0, 5)).toBe(true);
    // The answer, timed to follow: what is up stays, and nothing is drawn again.
    expect(turns.add("answer", 3, 5)).toBe(false);
    expect(bubble(turns, [1, 2.9, 3, 7.9, 8])).toEqual(["question", "question", "answer", "answer", undefined]);
  });

  it("shows a line said before the one waiting in the bubble first, though it came second", () => {
    // The answer came in first, to start once the question has been read; then the question itself.
    const turns = new Turns<string>();
    turns.add("answer", 3, 5);
    expect(turns.add("question", 0, 5)).toBe(true);
    expect(turns.now?.what).toBe("question");
    expect(bubble(turns, [1, 3, 6])).toEqual(["question", "answer", "answer"]);
  });

  it("loses nothing to a third line coming while one waits", () => {
    const turns = new Turns<string>();
    turns.add("question", 0, 5);
    turns.add("far answer", 3, 5);
    turns.add("own answer", 6, 5);
    expect(bubble(turns, [1, 4, 7])).toEqual(["question", "far answer", "own answer"]);
  });

  it("puts a line said at the same moment as another in its place", () => {
    const turns = new Turns<string>();
    turns.add("first", 2, 5);
    expect(turns.add("second", 2, 5)).toBe(true);
    expect(bubble(turns, [2, 4, 7])).toEqual(["second", "second", undefined]);
  });

  it("skips a waiting line whose time went by while the one before was up", () => {
    const turns = new Turns<string>();
    turns.add("long", 0, 5);
    turns.add("soon over", 1, 5);
    turns.add("last", 3, 5);
    // From the first straight on to the last: "soon over" had only from 1 to 3.
    expect(turns.tick(4)).toBe(true);
    expect(turns.now?.what).toBe("last");
  });
});

describe("speech in the order said", () => {
  it("orders lines by when they were said, whatever order the speakers came in", () => {
    const speech = {
      writer: { text: "Here it is.", at: "2026-10-19T12:00:04Z" },
      planner: { text: "Is the draft ready?", at: "2026-10-19T12:00:00Z" },
      editor: undefined,
    };
    expect(inOrder(speech).map(([who]) => who)).toEqual(["planner", "writer"]);
  });
});
