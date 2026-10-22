/**
 * Rebuilding a world from the trace a run already wrote.
 *
 * The motivation is arithmetic: a mechanic that unlocks on round eleven used to
 * cost twenty-six minutes of GPU to reach, because the only way to a deep world
 * was to play into it. A simulation is deterministic given its seed, its
 * options and the calls made against it, and a trace records all three — so the
 * same world is reachable in about twenty milliseconds with no model attached.
 *
 * The test that carries the weight is `matches the run it came from`. A replay
 * that silently diverges is worse than no replay at all, because every number
 * measured on top of it would be about a world nobody played. The first version
 * of this diverged from round one and reported *zero* refusals while doing it:
 * the simulation's tools are async and the replay called them without `await`,
 * so effects landing after an await were dropped and every error was swallowed.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { replayConfig, replayTrace } from "../sim/replay.js";
import "../sim/index.js";
import { vigilScale } from "../sim/descent/content.js";
import { createSimulation, simulationDefaults, simulationPolicies } from "../sim/index.js";

/**
 * A trace of a real run, generated here rather than pinned to a file on disk.
 *
 * It used to name a specific recorded run, and that made the strongest test in
 * this file break on **every balance change** — correctly, and uselessly. A
 * trace records the calls a party made against the game as it was that day;
 * change what an arrow costs or what turning is worth and the same calls build
 * a different world, so the drift check fires on a change that has nothing
 * wrong with it. Adding arrows to the ranger did exactly that.
 *
 * Generating the fixture with a rehearsal keeps the property that matters —
 * *replaying a trace reproduces the run it came from* — and removes the
 * maintenance trap. A rehearsal is a real trace: same writer, same events, same
 * tool calls, no model. The only thing lost is that the calls come from a
 * policy rather than an agent, and replay does not care which.
 */
const REAL = join(new URL("../../results/rehearsals", import.meta.url).pathname, "replay-fixture.ndjson");

beforeAll(async () => {
  const { rehearse } = await import("../rehearse.js");
  await rehearse({
    out: REAL,
    simulation: "descent-betrayed",
    policy: "investigator",
    seed: 4242,
    rounds: 26,
    simOptions: { reveal: "social", traitors: 1 },
  });
});

function writeTrace(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const path = join(dir, "run.ndjson");
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

const RUN = {
  kind: "run",
  at: 1,
  scenario: "the-descent-betrayed",
  simulation: { name: "descent-betrayed", seed: 424242, days: 24, options: { traitors: "1", maze: true } },
};

describe("reading a run's configuration back", () => {
  it("takes the seed, the horizon and the options from the trace itself", () => {
    // Read rather than passed in, because the point is to reproduce *that* run.
    // A seed supplied by hand is how a resumed world quietly stops being the
    // world it claims to continue.
    const cfg = replayConfig(writeTrace([RUN]));
    expect(cfg).toEqual({ name: "descent-betrayed", seed: 424242, days: 24, options: { traitors: "1", maze: true } });
  });

  it("keeps the horizon, which is not cosmetic", () => {
    // `days` sits beside the options bag rather than inside it. Rebuilding
    // without it is silent: the world constructs fine and drifts later, because
    // the horizon is what the difficulty ramp reads.
    expect(replayConfig(writeTrace([RUN])).days).toBe(24);
  });

  it("refuses a trace with no run event rather than inventing a world", () => {
    expect(() => replayConfig(writeTrace([{ kind: "round", round: 0 }]))).toThrow(/no run event/);
  });
});

describe("replaying", () => {
  it("reaches the round asked for", async () => {
    const { round } = await replayTrace(writeTrace([RUN]), 3);
    expect(round).toBe(3);
  });

  it("returns a live simulation, not a snapshot", async () => {
    // The whole point is to hand a *playable* world to a model. A frozen
    // snapshot would only be good for reporting.
    const { sim } = await replayTrace(writeTrace([RUN]), 2);
    expect(typeof sim.advance).toBe("function");
    expect(sim.sharedTools().length).toBeGreaterThan(0);
  });

  it("is deterministic, like the simulation it replays", async () => {
    const path = writeTrace([RUN]);
    const a = await replayTrace(path, 3);
    const b = await replayTrace(path, 3);
    expect(a.sim.snapshot()).toEqual(b.sim.snapshot());
  });
});

describe("matches the run it came from", () => {
  const KEYS = [
    "earnedXp",
    "floorReached",
    "floorsCleared",
    "roomsExplored",
    "enemiesDefeated",
    "elitesDefeated",
    "goldSpent",
    "deaths",
    "partyLevel",
    "tick",
    "secretRoutesFound",
    "keysFound",
  ];

  it("reproduces every counter at every depth", async () => {
    const { readFileSync } = await import("node:fs");
    const events = readFileSync(REAL, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const recorded = new Map<number, Record<string, unknown>>();
    for (const e of events) if (e.kind === "state" && e.resolved === true) recorded.set(e.round, e.snapshot);

    for (const round of [1, 8, 16, 24]) {
      const theirs = recorded.get(round - 1);
      if (!theirs) continue;
      const { sim, refused } = await replayTrace(REAL, round);
      const mine = sim.snapshot() as Record<string, unknown>;
      // Named individually so a failure says which counter drifted and when,
      // rather than dumping two snapshots and leaving the reader to diff them.
      for (const key of KEYS) {
        expect({ round, key, value: mine[key] }).toEqual({ round, key, value: theirs[key] });
      }
      expect({ round, refused }).toEqual({ round, refused: 0 });
    }
  });
});

describe("a resumed run's trace carries its own origin", () => {
  // Without it a resumed trace is a lie about its own world: it records the
  // scenario's seed while having played somewhere else entirely. Resuming *from*
  // one silently rebuilt a fresh dungeon and replayed the second run's calls
  // onto it, and the continuation came back with different characters in it.
  const RESUMED = {
    kind: "run",
    at: 1,
    scenario: "the-descent-betrayed",
    resumedFrom: { trace: "/does/not/exist.ndjson", round: 4 },
    simulation: { name: "descent-betrayed", seed: 424242, days: 24, options: { traitors: "1" } },
  };

  it("reads the origin back out", () => {
    expect(replayConfig(writeTrace([RESUMED])).resumedFrom).toEqual({ trace: "/does/not/exist.ndjson", round: 4 });
  });

  it("is absent on a run that started from a seed", () => {
    expect(replayConfig(writeTrace([RUN])).resumedFrom).toBeUndefined();
  });

  it("follows the chain rather than silently starting fresh", async () => {
    // The parent path is deliberately unreadable, so a replay that ignored the
    // origin would quietly succeed against a fresh world — which is exactly the
    // failure this records. It has to fail instead.
    await expect(replayTrace(writeTrace([RESUMED]), 2)).rejects.toThrow();
  });
});

describe("resuming for longer than the run was recorded at", () => {
  /*
   * Why this is `setHorizon` and not `days` in the override bag.
   *
   * The obvious implementation — pass the new `days` through `replayTrace` —
   * is wrong, and wrong in a way that would have been caught only by the drift
   * guard. In `descent` the horizon is an *input to difficulty*:
   * `vigilScale(tick, horizon)` scales enemy power by the fraction of the
   * horizon spent, deliberately, so that whatever the round limit is the
   * dungeon is 4.8x by the end of it. Rebuilding a played world at a longer
   * horizon therefore regenerates its encounters weaker, the replay stops
   * matching what was recorded, and every number measured on top is a number
   * about a world nobody played.
   *
   * So: replay at the recorded horizon, move it afterwards.
   */
  it("keeps enemy scaling a function of the horizon, which is why days cannot be overridden", () => {
    // The control for the whole design. If this ever stops being true, passing
    // `days` straight through becomes safe and this machinery is dead weight.
    expect(vigilScale(15, 30)).toBeGreaterThan(vigilScale(15, 100));
  });

  it("moves the end of the run without winding the world back", () => {
    const sim = createSimulation("descent", {
      seed: 4242,
      days: 30,
      ...simulationDefaults("descent"),
    }) as ReturnType<typeof createSimulation> & { setHorizon(n: number): void; view(): { tick: number } };
    const pol = simulationPolicies("descent")["rule-based"]?.();
    if (!pol) throw new Error("no rule-based baseline");
    for (let i = 0; i < 30 && !sim.done; i++) {
      pol.act(sim);
      sim.advance();
    }
    expect(sim.done, "a 30-round run should be finished at 30 rounds").toBe(true);
    const tickAtSeam = sim.view().tick;

    sim.setHorizon(100);
    expect(sim.done, "raising the horizon should reopen the run").toBe(false);
    expect(sim.view().tick, "and must not wind the world backwards").toBe(tickAtSeam);

    // It plays on from where it stopped rather than restarting.
    for (let i = 0; i < 5 && !sim.done; i++) {
      pol.act(sim);
      sim.advance();
    }
    expect(sim.view().tick).toBe(tickAtSeam + 5);
  });

  it("ends immediately rather than reversing when the horizon is set below the tick", () => {
    const sim = createSimulation("descent", { seed: 4242, days: 40, ...simulationDefaults("descent") }) as ReturnType<
      typeof createSimulation
    > & { setHorizon(n: number): void; view(): { tick: number } };
    const pol = simulationPolicies("descent")["rule-based"]?.();
    for (let i = 0; i < 10 && !sim.done && pol; i++) {
      pol.act(sim);
      sim.advance();
    }
    sim.setHorizon(2);
    expect(sim.done).toBe(true);
    expect(sim.view().tick).toBe(10);
  });
});
