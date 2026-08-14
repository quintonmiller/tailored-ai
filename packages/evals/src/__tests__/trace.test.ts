/**
 * The trace has to survive being read while it is being written.
 *
 * That is the whole reason it is NDJSON and the whole reason these tests exist:
 * a viewer polls a file that a worker is appending to, so it will routinely read
 * a final line that is half a JSON object. Throwing there would take the viewer
 * down every few seconds, at exactly the moment somebody is watching.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileSink, looksRefused, readTrace } from "../trace.js";

const scratch = () => mkdtempSync(join(tmpdir(), "tai-trace-"));

describe("a trace file", () => {
  it("round-trips what was written", () => {
    const path = join(scratch(), "t.ndjson");
    const write = fileSink(path);
    write({ kind: "round", at: 1, round: 0 });
    write({
      kind: "call",
      at: 2,
      turn: 0,
      agent: "sluice",
      tool: "raise_paddle",
      args: {},
      result: "up",
      refused: false,
    });
    const events = readTrace(path);
    expect(events.map((e) => e.kind)).toEqual(["round", "call"]);
  });

  it("drops a half-written last line instead of throwing", () => {
    const path = join(scratch(), "t.ndjson");
    writeFileSync(path, `${JSON.stringify({ kind: "round", at: 1, round: 0 })}\n{"kind":"call","at":2,"tu`);
    const events = readTrace(path);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("round");
  });

  it("reads a file that does not exist as empty", () => {
    expect(readTrace(join(scratch(), "nothing.ndjson"))).toEqual([]);
  });

  it("creates the directory it is pointed at", () => {
    const path = join(scratch(), "nested", "deeper", "t.ndjson");
    fileSink(path)({ kind: "end", at: 1, turns: 3 });
    expect(readTrace(path)).toHaveLength(1);
  });

  it("never throws out of the sink, whatever happens", () => {
    // A trace is instrumentation. A run that dies because nobody could write a
    // log line has traded the thing being measured for the measurement.
    const sink = fileSink(join(scratch(), "t.ndjson"));
    expect(() => {
      const looping: Record<string, unknown> = {};
      looping.self = looping;
      sink({ kind: "state", at: 1, turn: 0, round: 0, snapshot: looping });
    }).not.toThrow();
  });
});

describe("spotting a refusal", () => {
  it("recognises the shapes the harness and the simulations produce", () => {
    expect(looksRefused("Refused: your hands are not on a paddle of chamber 2")).toBe(true);
    expect(looksRefused("refused: preconditions not met (power must be on)")).toBe(true);
    expect(looksRefused("you are not authorised for that. flux has to run it.")).toBe(true);
    expect(looksRefused("Your paddle is up and signal's is already standing.")).toBe(false);
    // A refusal reported *inside* a successful narration is not a refusal — the
    // call landed. Colouring it red would make a working run look broken.
    expect(looksRefused("The gate swings. An earlier attempt was refused.")).toBe(false);
  });
});
