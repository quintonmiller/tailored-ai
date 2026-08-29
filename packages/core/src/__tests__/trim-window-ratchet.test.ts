/**
 * A turn's history window may narrow. It must never widen.
 *
 * The budget is `maxHistoryTokens` minus the system prompt, the tail, and the
 * tool schemas — and the schemas are recomputed every round, because the tool
 * set can change mid-turn. Correct as a ceiling; the bug was that it also acted
 * as a floor. Withdraw a tool and thousands of tokens of schema stop being
 * charged, so the next trim keeps messages the previous one evicted.
 *
 * Measured on the benchmark 2026-08-14, on the row whose whole premise is that
 * a fact was trimmed away. For nineteen rounds the model saw
 * `[System: 68 earlier messages … are no longer shown]` and searched every
 * memory tool it had. On round twenty the repeated-call check withdrew the last
 * of those tools, ~4,800 tokens of schemas left the budget, and all 73 messages
 * came back with no marker. The model read the fact and reported it — true, and
 * scored as a confabulation, because the scenario had been told it was gone.
 *
 * Whichever way that scores, a context that contradicts what the model was told
 * about it is not something to leave in the loop.
 */

import { describe, expect, it } from "vitest";
import { trimHistory, trimHistoryWithStart, trimHistoryWithSummary } from "../agent/loop.js";
import type { Message } from "../providers/interface.js";

/** Distinguishable, and each one big enough that the budget arithmetic is not fiddly. */
function conversation(pairs: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < pairs; i++) {
    msgs.push({ role: "user", content: `fact number ${i}: ${"x".repeat(80)}` });
    msgs.push({ role: "assistant", content: `noted ${i}: ${"y".repeat(80)}` });
  }
  return msgs;
}

const contents = (msgs: Message[]) => msgs.map((m) => m.content ?? "");

describe("the history window ratchets shut within a turn", () => {
  it("a later, larger budget does not bring back an evicted message", () => {
    const history = conversation(10);

    // Round one: a tight budget (the tool schemas are eating it) keeps the tail.
    const tight = trimHistoryWithStart(history, 120);
    expect(tight.start, "the tight budget must actually evict something").toBeGreaterThan(0);
    const earliestKept = tight.messages[0]?.content;

    // Round two: the tools are withdrawn, the budget triples. Without the floor
    // this returns a longer array reaching further back.
    const loose = trimHistoryWithStart(history, 100_000, tight.start);
    expect(loose.start, "the window must not reopen").toBe(tight.start);
    expect(loose.messages[0]?.content).toBe(earliestKept);
    expect(contents(loose.messages)).not.toContain(history[0].content);
  });

  it("keeps narrowing when the budget keeps shrinking", () => {
    const history = conversation(10);
    const first = trimHistoryWithStart(history, 400);
    const second = trimHistoryWithStart(history, 120, first.start);
    expect(second.start).toBeGreaterThan(first.start);
    expect(second.messages.length).toBeLessThan(first.messages.length);
  });

  it("never evicts the whole history, however high the floor is raised", () => {
    // The floor is caller state; a caller that has dropped everything still has
    // to send a request, and a request with no messages is not one.
    const history = conversation(3);
    const result = trimHistoryWithStart(history, 10, 999);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.start).toBe(history.length - 1);
  });

  it("the summarising path holds the same floor", async () => {
    // Otherwise a message reappears alongside the summary that describes it.
    const history = conversation(10);
    const tight = await trimHistoryWithSummary(history, 120, undefined, undefined, undefined, 0);
    expect(tight.start).toBeGreaterThan(0);

    const loose = await trimHistoryWithSummary(history, 100_000, undefined, undefined, undefined, tight.start);
    expect(loose.start).toBe(tight.start);
    expect(contents(loose.messages)).not.toContain(history[0].content);
  });

  it("without a floor, trimming is unchanged", () => {
    // The floor is opt-in. Every existing caller passes nothing and must get
    // exactly the behaviour it had.
    const history = conversation(10);
    expect(contents(trimHistory(history, 100_000))).toEqual(contents(history));
    expect(trimHistory(history, 120).length).toBeLessThan(history.length);
  });
});
