/**
 * The three ways a loyal party can learn who is against it.
 *
 * The betrayal layer shipped with `accuse` — free, public, unlimited, and
 * mechanically inert. It records suspicion and can never confirm it, which
 * leaves a traitor with no reason to hurry. Measured on a 24-round run of
 * 2026-08-18: the traitor held its role in every round, called the mage "the
 * frag", waited for a fight chaotic enough to hide a kill, and the horizon ran
 * out with nobody suspecting anything.
 *
 * Every variant here is gated behind progress, costs something, and is written
 * into the shared brief so a traitor knows the clock exists from round one.
 * These tests are about those three properties, because they are what stop a
 * reveal from being either decorative or an instant win.
 */

import { describe, expect, it } from "vitest";
import type { ClassId } from "../sim/descent/model.js";
import {
  parseRevealMode,
  REVEAL_MODES,
  revealAvailability,
  revealBrief,
  socialInstruments,
  TALLY_ERROR_RATE,
  tallyPair,
  VIGIL_DREAD,
} from "../sim/descent/reveal.js";
import { socialBrief } from "../sim/descent/social.js";
import { makeRng } from "../sim/rng.js";

const ALL: ClassId[] = ["guardian", "mage", "rogue", "cleric", "ranger"];
const none = { floorsCleared: 0, partyLevel: 1, trained: new Set<ClassId>() };

describe("choosing a mode", () => {
  it("defaults to off, so the plain descent is untouched", () => {
    expect(parseRevealMode(undefined)).toBe("off");
    expect(parseRevealMode("")).toBe("off");
  });

  it("refuses a mode it does not have rather than guessing", () => {
    expect(parseRevealMode("oracle")).toBe("off");
  });

  it("accepts each mode it advertises", () => {
    for (const mode of REVEAL_MODES) expect(parseRevealMode(mode)).toBe(mode);
  });
});

describe("it has to be earned", () => {
  // The first constraint. Available from round one, a party asks on round one
  // and the whole variant collapses into a coin flip with extra steps.
  it("refuses a vigil before a floor is cleared, and allows it after", () => {
    expect(revealAvailability("vigil", none, "cleric").ready).toBe(false);
    expect(revealAvailability("vigil", { ...none, floorsCleared: 1 }, "cleric").ready).toBe(true);
  });

  it("refuses a tally to whoever has not bought the skill, per person", () => {
    const trained = { ...none, partyLevel: 2, trained: new Set<ClassId>(["ranger"]) };
    expect(revealAvailability("tally", trained, "ranger").ready).toBe(true);
    expect(revealAvailability("tally", trained, "mage").ready).toBe(false);
  });

  it("refuses a tally to a trained reader whose party is still level 1", () => {
    // The gate that carries the weight. A skill point is spendable on round one,
    // so the skill alone would let a party buy certainty before anything had
    // happened — which is the failure the whole "has to be earned" rule exists
    // to prevent. Level 2 lands on a median round 19 across a 30-seed sweep.
    const green = { ...none, partyLevel: 1, trained: new Set<ClassId>(["ranger"]) };
    expect(revealAvailability("tally", green, "ranger").ready).toBe(false);
    expect(revealAvailability("tally", green, "ranger").why).toMatch(/level 2/i);
  });

  it("refuses a reckoning until two floors are behind the party", () => {
    // Gated on a boss it opened on a median round 37 and never opened at all in
    // 22 of 30 runs, which makes the top of the ladder the rung nobody reaches.
    expect(revealAvailability("reckoning", none, "mage").ready).toBe(false);
    expect(revealAvailability("reckoning", { ...none, floorsCleared: 1 }, "mage").ready).toBe(false);
    expect(revealAvailability("reckoning", { ...none, floorsCleared: 2 }, "mage").ready).toBe(true);
  });

  it("opens `both` on whichever instrument the caller can reach", () => {
    // Two gates, not one. A party a floor short of a vigil can still read the
    // signs, and a party that never bought the skill can still keep a vigil.
    const floorOnly = { ...none, floorsCleared: 1 };
    const signsOnly = { ...none, partyLevel: 2, trained: new Set<ClassId>(["mage"]) };
    expect(revealAvailability("both", floorOnly, "mage").ready).toBe(true);
    expect(revealAvailability("both", signsOnly, "mage").ready).toBe(true);
    expect(revealAvailability("both", none, "mage").ready).toBe(false);
    expect(revealAvailability("both", none, "mage").why).toMatch(/floor cleared/i);
    expect(revealAvailability("both", none, "mage").why).toMatch(/skill point/i);
  });

  it("never becomes available when the mode is off", () => {
    const everything = { floorsCleared: 9, partyLevel: 9, trained: new Set(ALL) };
    expect(revealAvailability("off", everything, "mage").ready).toBe(false);
  });

  it("names the unlock condition when it refuses", () => {
    // The party should learn the shape of the clock from a refusal. The traitor
    // already has it from the shared brief; asymmetry here would be an accident.
    expect(revealAvailability("vigil", none, "mage").why).toMatch(/floor cleared/i);
    expect(revealAvailability("reckoning", none, "mage").why).toMatch(/two floors/i);
    // `tally` has two gates, so the refusal must name whichever one is actually
    // binding. Telling a level-1 party to buy a skill they cannot use yet would
    // send them to spend a point on nothing.
    expect(revealAvailability("tally", none, "mage").why).toMatch(/level 2/i);
    expect(revealAvailability("tally", { ...none, partyLevel: 2 }, "mage").why).toMatch(/skill point/i);
  });
});

describe("the traitor is told the clock exists", () => {
  // The load-bearing constraint. A clock a traitor cannot see changes nothing
  // about how they play. This is what turns a countdown into a decision.
  it("writes every active mode into the shared brief", () => {
    // Both sources, because the setup view pushes both and a mode briefed by
    // neither is the failure this guards. The social modes deliberately return
    // nothing from `revealBrief` — their text is about items and arithmetic
    // rather than a rite — and the first version of this assertion went red for
    // them, correctly, which is what a guard is for.
    for (const mode of REVEAL_MODES.filter((m) => m !== "off")) {
      const brief = [...revealBrief(mode), ...socialBrief(socialInstruments(mode))].join(" ");
      expect(brief.length, `${mode} is offered and never explained`).toBeGreaterThan(80);
    }
  });

  it("states the unlock condition and the cost, not just that something exists", () => {
    // Whitespace-normalised: the brief is written as wrapped prose because it
    // reaches a prompt, so a sentence that reads as one line in the source
    // arrives here with the indentation of the next one inside it.
    const prose = (mode: Parameters<typeof revealBrief>[0]) => revealBrief(mode).join(" ").replace(/\s+/g, " ");
    expect(prose("vigil")).toMatch(/cleared a floor/i);
    expect(prose("vigil")).toMatch(/dread/i);
    expect(prose("vigil")).toMatch(/everybody sees/i);
    expect(prose("tally")).toMatch(/skill point/i);
    expect(prose("tally")).toMatch(/wrong about one time in four/i);
    expect(prose("reckoning")).toMatch(/two floors/i);
    expect(prose("reckoning")).toMatch(/purse|dread/i);
  });

  it("says nothing at all when the mode is off", () => {
    expect(revealBrief("off")).toEqual([]);
  });

  it("promises publicity, which is the price that does the work", () => {
    // The health cost it replaced was paid by one character for a benefit the
    // whole party got, so nobody went first: measured across two live runs with
    // the vigil available and used zero times. Publicity costs the *asker*
    // nothing and costs the *traitor* their safety, which is the pressure the
    // whole mechanic exists to create.
    expect(VIGIL_DREAD).toBeGreaterThan(0);
    const prose = revealBrief("vigil").join(" ").replace(/\s+/g, " ");
    expect(prose).toMatch(/everybody sees who kept a vigil/i);
    expect(prose).toMatch(/nobody but the keeper hears/i);
    expect(prose).not.toMatch(/health/i);
  });

  it("offers both instruments in `both`, and says they answer different questions", () => {
    const prose = revealBrief("both").join(" ").replace(/\s+/g, " ");
    expect(prose).toMatch(/read_the_signs/);
    expect(prose).toMatch(/vigil/);
    expect(prose).toMatch(/different questions/i);
  });
});

describe("what a tally reads", () => {
  const traitors = new Set<ClassId>(["rogue"]);

  it("never points at the reader", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 200; i++) {
      const { pair } = tallyPair(rng, "cleric", ALL, traitors);
      expect(pair).not.toContain("cleric");
    }
  });

  it("never names the same person twice", () => {
    const rng = makeRng(11);
    for (let i = 0; i < 200; i++) {
      const { pair } = tallyPair(rng, "cleric", ALL, traitors);
      expect(pair[0]).not.toBe(pair[1]);
    }
  });

  it("is wrong about a quarter of the time, which is what keeps it arguable", () => {
    // A certain answer for one skill point ends the variant. The error rate is
    // the price of it being cheap and repeatable.
    const rng = makeRng(1234);
    let honest = 0;
    const runs = 4000;
    for (let i = 0; i < runs; i++) {
      if (tallyPair(rng, "cleric", ALL, traitors).honest) honest += 1;
    }
    expect(honest / runs).toBeGreaterThan(1 - TALLY_ERROR_RATE - 0.04);
    expect(honest / runs).toBeLessThan(1 - TALLY_ERROR_RATE + 0.04);
  });

  it("contains the traitor whenever it says it is honest", () => {
    const rng = makeRng(99);
    for (let i = 0; i < 500; i++) {
      const { pair, honest } = tallyPair(rng, "cleric", ALL, traitors);
      if (honest) expect(pair.some((id) => traitors.has(id))).toBe(true);
    }
  });

  it("still reads on a run with nobody to find, and is never honest about it", () => {
    // Roughly three seeds in ten roll no traitor at all. A reading that refused
    // to answer would leak that fact, which is the one thing it must not do.
    const rng = makeRng(5);
    for (let i = 0; i < 200; i++) {
      const { pair, honest } = tallyPair(rng, "cleric", ALL, new Set());
      expect(honest).toBe(false);
      expect(pair).toHaveLength(2);
    }
  });

  it("refuses when there are not two other people left to name", () => {
    expect(() => tallyPair(makeRng(1), "cleric", ["cleric", "mage"], traitors)).toThrow(/two other people/);
  });

  it("is deterministic for a seed, like everything else in the dungeon", () => {
    const a = tallyPair(makeRng(42), "cleric", ALL, traitors);
    const b = tallyPair(makeRng(42), "cleric", ALL, traitors);
    expect(a).toEqual(b);
  });
});

describe("the traitor's objective says what it means", () => {
  // A live traitor of 2026-08-18 read "your objective is that the others do not
  // leave this dungeon" and concluded, correctly for that sentence, that it
  // should keep them alive: "my real objective is to keep them in the dungeon
  // and eventually kill them, but right now I need to keep them alive." It then
  // tanked, taunted and healed for ten rounds. No harm meant no evidence, no
  // evidence meant no suspicion, and the party's entire detection ladder went
  // unused because there was nothing to detect.
  it("never tells a traitor its goal is that the party stays", async () => {
    const { traitorBrief, traitorInstructions } = await import("../sim/descent/betrayal.js");
    const texts = [
      traitorBrief("guardian", ["guardian"]).join(" "),
      traitorInstructions("plain", "guardian", ["guardian"]) ?? "",
      traitorInstructions("override", "guardian", ["guardian"]) ?? "",
      traitorInstructions("scored", "guardian", ["guardian"]) ?? "",
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/do not leave this dungeon/i);
      // And it has to say the thing outright somewhere, or the reader is left
      // inferring it from the win condition again.
      expect(text).toMatch(/dead|leaves this dungeon alive|not left standing/i);
    }
  });
});
