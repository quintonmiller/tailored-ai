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
import { rehearse } from "../rehearse.js";
import { createSimulation } from "../sim/index.js";
import { fileSink, finishSimulationTrace, looksRefused, readTrace, type TraceEvent } from "../trace.js";

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

  it("records the fully resolved horizon before ending, where that means anything", () => {
    /*
     * The factory runs on; the dungeon does not.
     *
     * Running a world to its horizon under the last decisions made is what
     * makes an eight-round agent run comparable with a baseline swept over
     * sixty days — for a company, which keeps paying wages whether anybody is
     * managing it. For a dungeon it is a fiction: an unattended party standing
     * in a room with monsters in it is eaten, so every tick past the agents'
     * last round manufactures damage nobody chose to take.
     *
     * Measured twice on 2026-08-19. Once when `--rounds` raised the horizon and
     * left the roster behind: 16 unattended ticks, a healthy party on tick 39
     * and five corpses on tick 55. And again with the roster correct, where the
     * overrun turned four survivors and an executed traitor into "the party was
     * wiped out on floor 3".
     *
     * So `descent` opts out via `runsOnUnattended`, and the factory — which is
     * what the argument was written about — keeps the behaviour.
     */
    const factory = createSimulation("factory", { seed: 1, days: 1 });
    const events: TraceEvent[] = [];
    finishSimulationTrace(factory, (event) => events.push(event), { turn: 0, round: 0, turns: 1 });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "state", resolved: true });
    expect(events[1]).toMatchObject({ kind: "end", turns: 1 });
  });

  it("leaves a dungeon exactly where the party left it", () => {
    const sim = createSimulation("descent", { seed: 1, days: 40 });
    const before = (sim.snapshot() as { ticksSurvived: number }).ticksSurvived;
    const events: TraceEvent[] = [];
    finishSimulationTrace(sim, (event) => events.push(event), { turn: 0, round: 0, turns: 1 });
    expect(
      (events[0] as unknown as { snapshot: { ticksSurvived: number } }).snapshot.ticksSurvived,
      "the world kept playing after the agents stopped",
    ).toBe(before);
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

describe("a rehearsal's output file", () => {
  /*
   * A rehearsal writes to a path named after its policy, not after the clock.
   *
   * `fileSink` appends, which is exactly right for a run — every run gets its
   * own timestamped file and a viewer tails it. A rehearsal reuses one path, so
   * appending left three whole runs concatenated in
   * `descent-rule-based.ndjson`: the header of the oldest, then a shuffle of
   * every run's states. Nothing failed; the file just quietly described a game
   * nobody played.
   */
  it("holds exactly one run, however many times it is refreshed", async () => {
    const out = join(scratch(), "descent-rule-based.ndjson");
    await rehearse({ out, policy: "rule-based", seed: 1000, rounds: 4 });
    await rehearse({ out, policy: "rule-based", seed: 1000, rounds: 4 });

    const events = readTrace(out);
    expect(events.filter((event) => event.kind === "run")).toHaveLength(1);
    expect(events[0].kind, "the run header has to be the first line a reader sees").toBe("run");
  });

  it("records the world it played, so a scoreboard can tell two configurations apart", async () => {
    const out = join(scratch(), "descent-maze.ndjson");
    await rehearse({ out, policy: "rule-based", seed: 7, rounds: 4, startFloor: 1, maze: true, preparation: true });
    const [head] = readTrace(out);
    expect(head.kind).toBe("run");
    expect(head.kind === "run" && head.simulation).toMatchObject({
      name: "descent",
      seed: 7,
      options: { startFloor: 1, maze: true, preparation: true },
    });
  });
});

describe("why a run ended", () => {
  it("names the roster running out, which is the commonest ending of all", () => {
    /*
     * `endedBecause` describes a world that finished — wiped, betrayed, out of
     * ticks. The usual ending is none of those: the agents' rounds run out
     * while the world is still perfectly playable.
     *
     * It was hidden while the harness ran every simulation on to its horizon,
     * because by the time the end event was written the sim always had a reason.
     * Turning that off for the dungeon left `reason` absent entirely, and every
     * report read `ENDED: undefined` — which looks exactly like a crash.
     */
    const sim = createSimulation("descent", { seed: 1, days: 40 });
    const events: TraceEvent[] = [];
    finishSimulationTrace(sim, (event) => events.push(event), { turn: 0, round: 0, turns: 1 });
    const end = events.find((e) => e.kind === "end") as unknown as { reason?: string };
    expect(end.reason, "an ending with no name reads as a crash").toBeDefined();
    expect(end.reason).toMatch(/rounds ran out/);
  });

  it("still prefers the simulation's own reason when it has one", () => {
    const sim = createSimulation("descent", { seed: 1, days: 1 });
    (sim as unknown as { state: { wiped: boolean } }).state.wiped = true;
    const events: TraceEvent[] = [];
    finishSimulationTrace(sim, (event) => events.push(event), { turn: 0, round: 0, turns: 1 });
    const end = events.find((e) => e.kind === "end") as unknown as { reason?: string };
    expect(end.reason).toMatch(/wiped out/);
  });
});
