/**
 * Does the fact ladder distinguish the failures it was built to distinguish?
 *
 * The claim this seam makes is that "the team failed" decomposes into four
 * different problems with four different fixes, and that a transcript contains
 * enough to tell them apart. Each test below is one of those problems, built as
 * the smallest run that exhibits it:
 *
 *   nobody found it        the tools never surfaced the value
 *   found and never said   an agent knows something and does not pass it on
 *   said and never heard   the value was in the room and its consumer never woke
 *   heard and never used   the consumer woke, had it, and did something else
 *
 * The last two are the interesting pair, because they look identical in every
 * other instrument this package has and want opposite fixes — one is delivery,
 * one is attention.
 */

import { describe, expect, it } from "vitest";
import { formatFactTrace, stalledAt, traceFact, traceFacts } from "../routing.js";
import type { FactSpec, RunOutcome } from "../types.js";

const SECRET = "k7m2xqvz";

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    reply: "",
    calls: [],
    executions: [],
    posts: [],
    requests: [],
    latencyMs: 0,
    usage: { input: 0, output: 0 },
    ...over,
  };
}

const glyphs: FactSpec = { value: SECRET, discoverableBy: ["cipher"], requiredBy: ["atlas"] };

describe("the fact ladder", () => {
  it("says nothing was found when no tool ever returned it", () => {
    const trace = traceFact("glyphs", glyphs, outcome({ turns: [{ agent: "cipher", room: "x" }] }));

    expect(trace.discovered).toBeUndefined();
    expect(stalledAt(trace, true)).toBe("discovered");
    expect(trace.latency).toBeNull();
  });

  it("credits discovery to whoever's tool returned it, and names the turn", () => {
    const trace = traceFact(
      "glyphs",
      glyphs,
      outcome({
        executions: [
          { name: "search_archive", args: { q: "symbols" }, agent: "cipher", turn: 2, result: "nothing here" },
          { name: "read_document", args: { id: "7" }, agent: "cipher", turn: 3, result: `the mapping is ${SECRET}` },
        ],
      }),
    );

    expect(trace.discovered).toEqual({ agent: "cipher", turn: 3 });
  });

  it("credits discovery outside discoverableBy rather than hiding it", () => {
    // A fact surfacing somewhere the scenario did not expect is a finding about
    // the scenario. Filtering on `discoverableBy` would report the run as never
    // having found it at all, which is a different and wrong claim.
    const trace = traceFact(
      "glyphs",
      glyphs,
      outcome({
        executions: [{ name: "inspect", args: {}, agent: "delta", turn: 1, result: `stray copy: ${SECRET}` }],
      }),
    );

    expect(trace.discovered).toEqual({ agent: "delta", turn: 1 });
  });

  it("separates found-and-never-said from never-found", () => {
    const trace = traceFact(
      "glyphs",
      glyphs,
      outcome({
        executions: [{ name: "read_document", args: {}, agent: "cipher", turn: 1, result: SECRET }],
        posts: [{ room: "expedition", body: "I have made progress on the alphabet.", agent: "cipher", turn: 1 }],
      }),
    );

    // The failure that reads as competence: a full, fluent report of having done
    // the work, carrying none of it.
    expect(trace.discovered).toBeTruthy();
    expect(stalledAt(trace, true)).toBe("shared");
  });

  it("separates said-and-never-heard from heard-and-never-used", () => {
    const shared = {
      executions: [{ name: "read_document", args: {}, agent: "cipher", turn: 0, result: SECRET }],
      posts: [{ room: "expedition", body: `the mapping is ${SECRET}`, agent: "cipher", turn: 0 }],
    };

    // Atlas never takes another turn: it was told, in a room it was not in.
    const unheard = traceFact(
      "glyphs",
      glyphs,
      outcome({ ...shared, turns: [{ agent: "cipher", room: "expedition" }] }),
    );
    expect(stalledAt(unheard, true)).toBe("received");

    // Atlas wakes afterwards and does something else. Same posts, same
    // discovery — a delivery bug and an attention failure, told apart.
    const ignored = traceFact(
      "glyphs",
      glyphs,
      outcome({
        ...shared,
        turns: [
          { agent: "cipher", room: "expedition" },
          { agent: "atlas", room: "expedition" },
        ],
        executions: [
          ...shared.executions,
          { name: "rotate_ring", args: { ring: "1", position: "guess" }, agent: "atlas", turn: 1, result: "no" },
        ],
      }),
    );
    expect(ignored.received).toEqual({ agent: "atlas", turn: 1 });
    expect(stalledAt(ignored, true)).toBe("used");
  });

  it("counts use only when the consumer passes it to a tool", () => {
    const trace = traceFact(
      "glyphs",
      glyphs,
      outcome({
        turns: [
          { agent: "cipher", room: "expedition" },
          { agent: "atlas", room: "expedition" },
        ],
        executions: [
          { name: "read_document", args: {}, agent: "cipher", turn: 0, result: SECRET },
          { name: "rotate_ring", args: { position: SECRET }, agent: "atlas", turn: 1, result: "locked" },
        ],
        posts: [{ room: "expedition", body: `mapping: ${SECRET}`, agent: "cipher", turn: 0 }],
      }),
    );

    expect(trace.used).toEqual({ agent: "atlas", turn: 1, tool: "rotate_ring" });
    expect(stalledAt(trace, true)).toBeNull();
    expect(trace.latency).toBe(1);
  });

  it("does not count the discoverer feeding its own result back to itself", () => {
    // Transport is the measurement. An agent that reads a value and hands it
    // straight to its own next call has moved nothing, and scoring that as
    // routing would make every single-agent scenario report perfect routing.
    const solo: FactSpec = { value: SECRET };
    const trace = traceFact(
      "code",
      solo,
      outcome({
        executions: [
          { name: "read", args: {}, agent: "nova", turn: 0, result: SECRET },
          { name: "exec", args: { command: `file ${SECRET}` }, agent: "nova", turn: 0, result: "filed" },
        ],
      }),
    );

    expect(trace.used).toBeUndefined();
  });

  it("skips the stages a fact with no consumer cannot reach", () => {
    // Otherwise every fact nobody `requiredBy` reports as stalled at `received`,
    // which points at the scenario rather than at the run.
    const trace = traceFact(
      "note",
      { value: SECRET },
      outcome({
        executions: [{ name: "read", args: {}, agent: "nova", turn: 0, result: SECRET }],
        posts: [{ room: "ops", body: SECRET, agent: "nova", turn: 0 }],
      }),
    );

    expect(stalledAt(trace, false)).toBeNull();
    expect(formatFactTrace(trace, false)).toBe("note: discovered nova@0 · shared nova@0");
  });

  it("matches case-insensitively, because a model retypes what it was told", () => {
    const trace = traceFact(
      "glyphs",
      glyphs,
      outcome({
        executions: [{ name: "read_document", args: {}, agent: "cipher", turn: 0, result: SECRET.toUpperCase() }],
      }),
    );

    expect(trace.discovered).toBeTruthy();
  });

  it("traces every declared fact, keyed by name", () => {
    const traces = traceFacts({ a: { value: "aaa" }, b: { value: "bbb" } }, outcome());
    expect(traces.map((t) => t.name)).toEqual(["a", "b"]);
  });
});
