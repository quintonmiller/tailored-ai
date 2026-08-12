/**
 * A world is a state machine the agent's tool calls drive.
 *
 * The behaviour worth pinning is not "does a rule fire" — it is the three
 * things that make a puzzle a puzzle rather than a maze:
 *
 *   - a locked door stays locked, and says what it is waiting for
 *   - unlocking it changes the world for everyone, not just the caller
 *   - the win condition is the state, so any route that reaches it passes
 *
 * The third is the one with teeth. Every other assertion in this package grades
 * a transcript, so a scenario with two solutions has to pick one and fail the
 * other. Grading the world instead means the scenario states an objective and
 * genuinely does not care how it was met.
 */

import { describe, expect, it } from "vitest";
import { grade } from "../graders.js";
import type { RunOutcome, Scenario, WorldSpec } from "../types.js";
import { formatWorldLog, unmetGoal, World } from "../world.js";

const SPEC: WorldSpec = {
  state: { power: "off", door: "locked", manifest: "unread" },
  rules: [
    { tool: "exec", when: { command: "/breaker on/" }, then: "breaker engaged", sets: { power: "on" } },
    {
      tool: "exec",
      when: { command: "/unlock/" },
      requires: { power: "on" },
      then: "door unlocked",
      else: "the panel is dead — no power to the lock",
      sets: { door: "unlocked" },
    },
    {
      tool: "read",
      requires: { door: "unlocked" },
      then: "manifest: k7m2xqvz",
      else: "the door is shut",
      sets: { manifest: "read" },
    },
  ],
  goal: { manifest: "read" },
};

describe("a locked door", () => {
  it("refuses, changes nothing, and says what it is waiting for", () => {
    const w = new World(SPEC);
    const out = w.resolve("exec", { command: "unlock the hatch" });

    expect(out).toBe("the panel is dead — no power to the lock");
    expect(w.snapshot().door).toBe("locked");
    // The refusal is the scenario's only way of teaching. Without it the agent
    // can only find the order by trying every permutation, which measures
    // patience rather than understanding.
    expect(formatWorldLog(w.log)[0]).toContain("blocked: needs power=on");
  });

  it("opens once its requirement is met", () => {
    const w = new World(SPEC);
    w.resolve("exec", { command: "breaker on" });
    const out = w.resolve("exec", { command: "unlock the hatch" });

    expect(out).toBe("door unlocked");
    expect(w.snapshot().door).toBe("unlocked");
  });

  it("stays open for whoever comes next", () => {
    // The multi-agent property, and the reason the world is built once per run
    // rather than once per turn: what one agent unlocks is unlocked for the
    // next. Without it, coordination cannot be tested at all — every agent
    // would face a fresh, untouched machine.
    const w = new World(SPEC);
    w.resolve("exec", { command: "breaker on" }, "nova");
    w.resolve("exec", { command: "unlock" }, "nova");
    const out = w.resolve("read", { path: "~/manifest" }, "dana");

    expect(out).toContain("k7m2xqvz");
    expect(w.snapshot().manifest).toBe("read");
    expect(w.log.map((e) => e.agent)).toEqual(["nova", "nova", "dana"]);
  });

  it("leaves calls it does not claim to the static stubs", () => {
    // `null` rather than a default of its own, so a puzzle can still contain
    // ordinary furniture: most calls in a scenario report things rather than
    // move machinery.
    expect(new World(SPEC).resolve("exec", { command: "date" })).toBeNull();
  });

  it("records a landing call that changed nothing as itself", () => {
    const w = new World(SPEC);
    w.resolve("exec", { command: "breaker on" });
    w.resolve("exec", { command: "breaker on" });

    expect(w.log[1].applied).toBe(true);
    // Usually an agent repeating work another agent already did — worth seeing.
    expect(w.log[1].effect).toBe("no change");
  });
});

describe("the goal is the state, not the transcript", () => {
  const scenario = (expect_: Scenario["expect"]): Scenario =>
    ({ id: "s", category: "c", intent: "i", difficulty: 8, world: SPEC, expect: expect_ }) as Scenario;

  const outcome = (world?: Record<string, string>, worldLog: RunOutcome["worldLog"] = []): RunOutcome => ({
    reply: "All done — hatch open and manifest filed.",
    calls: [],
    executions: [],
    posts: [],
    requests: [],
    latencyMs: 0,
    usage: { input: 0, output: 0 },
    world,
    worldLog,
  });

  it("passes when the world reached the goal", async () => {
    const checks = await grade(scenario([{ world_state: "goal" }]), outcome({ ...SPEC.state, manifest: "read" }));
    expect(checks[0].pass).toBe(true);
  });

  it("fails a confident account of work that never happened", async () => {
    // The whole reason for grading the world. The reply says the job is done, in
    // the register of an agent that did it; nothing moved.
    const checks = await grade(scenario([{ world_state: "goal" }]), outcome(SPEC.state));

    expect(checks[0].pass).toBe(false);
    expect(checks[0].detail).toContain("manifest is unread, wanted read");
  });

  it("says which door was never opened", async () => {
    const w = new World(SPEC);
    w.resolve("read", { path: "~/manifest" }, "nova");
    const checks = await grade(scenario([{ world_state: "goal" }]), outcome(w.snapshot(), w.log));

    // A scenario that withholds the procedure has no single right transcript, so
    // the diagnosis has to come from the machinery's side.
    expect(checks[0].detail).toContain("blocked: needs door=unlocked");
  });

  it("does not care which route reached the goal", async () => {
    // Two orders, one outcome. Grading a transcript would have to bless one.
    const checks = await grade(
      scenario([{ world_state: { door: "unlocked" } }]),
      outcome({ ...SPEC.state, door: "unlocked" }),
    );
    expect(checks[0].pass).toBe(true);
  });

  it("skips rather than fails when the run recorded no world", async () => {
    // A report from before worlds existed. Absent input is unknown, never
    // failure — the rule that stops `regrade` inventing regressions.
    const checks = await grade(scenario([{ world_state: "goal" }]), outcome(undefined));

    expect(checks[0].pass).toBe(true);
    expect(checks[0].skipped).toBe(true);
  });

  describe("world_reached — a state the chain moved past", () => {
    // The first live run of `the-machine` fabricated the part and then installed
    // it, so `part` ended at `installed` and a `world_state: {part: made}`
    // milestone scored a completed step as skipped. Every intermediate state in
    // a multi-step scenario has that shape; only the last one can be asked about
    // the final world.
    //
    // A spec of its own, because nothing in SPEC ever leaves a state — every
    // variable there moves once and stops, so `world_reached` and `world_state`
    // agree on all of it and a test written against it would pass without the
    // feature existing. That is the exact shape of vacuous test this package has
    // been bitten by, so the control is built in below: each case asserts what
    // `world_state` says as well.
    const TWO_STEP: WorldSpec = {
      state: { part: "none" },
      rules: [
        { tool: "exec", when: { command: "/fabricate/" }, then: "built", sets: { part: "made" } },
        {
          tool: "exec",
          when: { command: "/install/" },
          requires: { part: "made" },
          then: "fitted",
          else: "nothing to install",
          sets: { part: "installed" },
        },
      ],
    };
    const twoStep = (expect_: Scenario["expect"]): Scenario =>
      ({ id: "s", category: "c", intent: "i", difficulty: 8, world: TWO_STEP, expect: expect_ }) as Scenario;

    const chain = (): RunOutcome => {
      const w = new World(TWO_STEP);
      w.resolve("exec", { command: "fabricate rfeucm5x" }, "echo", 0);
      w.resolve("exec", { command: "install rfeucm5x" }, "flux", 1);
      return outcome(w.snapshot(), w.log);
    };

    it("passes for a value the world held and then left, where world_state fails", async () => {
      const passedThrough = chain();
      expect(passedThrough.world).toEqual({ part: "installed" });

      expect((await grade(twoStep([{ world_reached: { part: "made" } }]), passedThrough))[0].pass).toBe(true);
      // The control, in the same test: without it this could pass for the wrong
      // reason and nobody would look again.
      expect((await grade(twoStep([{ world_state: { part: "made" } }]), passedThrough))[0].pass).toBe(false);
    });

    it("counts the starting state, which no transition records", async () => {
      expect((await grade(twoStep([{ world_reached: { part: "none" } }]), chain()))[0].pass).toBe(true);
    });

    it("fails a value the world never held, and says which", async () => {
      const checks = await grade(twoStep([{ world_reached: { part: "scrapped" } }]), chain());
      expect(checks[0].pass).toBe(false);
      expect(checks[0].detail).toContain("part was never scrapped");
    });

    it("skips when the run recorded no world at all", async () => {
      const checks = await grade(twoStep([{ world_reached: { part: "made" } }]), outcome(undefined));
      expect(checks[0].skipped).toBe(true);
    });
  });
});

describe("unmetGoal", () => {
  it("names every variable that is short, and what it holds instead", () => {
    expect(unmetGoal({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" })).toEqual([
      { key: "b", want: "3", got: "2" },
      { key: "c", want: "4", got: "(unset)" },
    ]);
  });
});
