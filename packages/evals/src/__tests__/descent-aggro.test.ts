/**
 * Whether the party can see who is about to be hit.
 *
 * Every enemy chooses its target by threat: accrued at 0.6 of the damage a
 * member deals, forced onto whoever is taunting, ties broken at random. That
 * number is on every fighter and, until this test, appeared in no tool output,
 * no scene and no contract field — so the whole aggro system was played blind.
 *
 * The traces show what blind looks like, and none of the three symptoms
 * resembles the others: `vanish` was called zero times across sixteen runs,
 * `taunt` was refused on 46 of 111 attempts, and `shield` landed on whoever
 * looked hurt rather than whoever was next. One invisible number, three bugs.
 *
 * What is asserted here is only that the fact is *stated*. Whether a model then
 * uses it is a question for a run against a real model, and this cannot answer
 * it — but a party that cannot read the number certainly cannot act on it.
 */

import { describe, expect, it } from "vitest";
import { createSimulation, simulationPolicies } from "../sim/index.js";

/**
 * A simulation wound forward until the party is actually in a fight.
 *
 * Driven by a baseline policy rather than by hand, because that is the same
 * path the ladder sweep uses — a fight reached this way is a fight the game
 * really produces, not one assembled by a test.
 */
function inCombat(seed = 1000, fightFor = 0) {
  const sim = createSimulation("descent", { seed });
  const make = simulationPolicies("descent")["rule-based"];
  if (!make) throw new Error("no rule-based baseline to drive the party with");
  const tactics = make();
  const phase = () => String((sim.snapshot() as { phase?: string }).phase);
  for (let i = 0; i < 400 && !sim.done && phase() !== "combat"; i++) {
    tactics.act(sim);
    sim.advance();
  }
  // Optionally trade blows until somebody has actually drawn attention. At the
  // open every score is zero, so the interesting assertion — that real numbers
  // are shown — needs damage dealt first. Stopping as soon as the standings
  // appear matters: the median fight is four rounds, so running a fixed three
  // walks straight out the other side of it.
  const shown = () => (sim as unknown as { describeFor(w: string): string }).describeFor("rogue");
  for (let i = 0; i < fightFor && !sim.done && phase() === "combat"; i++) {
    if (shown().includes("Drawing attacks:")) break;
    tactics.act(sim);
    sim.advance();
  }
  return sim as typeof sim & { describeFor(who: string): string };
}

/** Guard against a test that quietly checks nothing. */
function requireCombat(sim: ReturnType<typeof inCombat>): void {
  if (String((sim.snapshot() as { phase?: string }).phase) !== "combat") {
    throw new Error("could not reach combat — this test would otherwise be vacuous");
  }
}

describe("what the party can see about being hit", () => {
  it("states who is drawing attacks, with the numbers", () => {
    const sim = inCombat();
    requireCombat(sim);
    const seen = sim.describeFor("guardian");
    // Three honest branches: a taunt overrides everything, an opening fight has
    // no standings yet and says so, and otherwise the numbers are shown.
    expect(seen).toMatch(/Drawing attacks:|is taunting:|Nobody has drawn attention yet/);
  });

  it("shows real standings once damage has been dealt", () => {
    // The branch that matters. Before this, a rogue could not tell whether it
    // had pulled the party's enemies onto itself, which is the decision
    // `vanish` exists to serve.
    const sim = inCombat(1000, 3);
    requireCombat(sim);
    const seen = sim.describeFor("rogue");
    if (seen.includes("is taunting:")) return;
    const line = seen.split("\n").find((l) => l.includes("Drawing attacks:"));
    expect(line, "combat has run three rounds and nobody has any threat").toBeDefined();
    expect(line).toMatch(/\b(guardian|mage|rogue|cleric|ranger) [1-9]\d*/);
  });

  it("names every living member in the order they will be targeted", () => {
    const sim = inCombat(1000, 3);
    requireCombat(sim);
    const seen = sim.describeFor("cleric");
    const line = seen.split("\n").find((l) => l.includes("Drawing attacks:"));
    if (!line) {
      // A taunt overrides the standings entirely, and that case is asserted by
      // the test above. Skipping silently is what would make this vacuous, so
      // say which branch ran.
      expect(seen).toContain("is taunting:");
      return;
    }
    for (const who of ["guardian", "mage", "rogue", "cleric", "ranger"]) {
      const alive = !String(sim.snapshot()[who] ?? "").includes("DOWN");
      if (alive) expect(line).toContain(who);
    }
  });

  it("tells the rogue what vanish is for", () => {
    // The ability was described as "Drop all your threat" — true, and useless
    // when threat was a number nobody could read. It is only a decision now
    // that the standings are on screen, so the description says what it buys.
    const sim = inCombat();
    const tools = (sim as unknown as { tools(): Record<string, { name: string; description: string }[]> }).tools();
    const vanish = tools.rogue?.find((t) => t.name === "vanish");
    expect(vanish?.description ?? "").toMatch(/turn on whoever is drawing next/);
  });
});
