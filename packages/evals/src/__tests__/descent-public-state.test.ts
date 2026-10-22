/**
 * What every agent is told at the top of a round, and what it must never be.
 *
 * `look` was 817 calls across seventeen traces — 12% of every tool call the
 * simulation received — and nearly all of it was an agent spending a whole
 * model round trip to ask for facts it was already entitled to. Those facts are
 * now pushed once, in `announce()`, which every agent reads.
 *
 * That makes `announce()` the most dangerous method in the file. It is read by
 * all five, so anything the simulation deliberately handed to one role leaks
 * the moment it appears here — and the leak would be invisible, because a run
 * with perfect shared information looks like a well-coordinated team rather
 * than like a broken one.
 *
 * The line is the one the private view already draws: condition and worn gear
 * are public, packs and purses are not. `give_gold` and `trade_item` are only
 * decisions while nobody can see what everybody is carrying.
 */

import { describe, expect, it } from "vitest";
import { createSimulation, simulationDefaults, simulationPolicies } from "../sim/index.js";

function played(seed = 1000, rounds = 12) {
  // The configuration the scenario actually plays, not the constructor's bare
  // defaults. Without it `maze` is off and there is no floor map at all — so
  // the whole <map> section, the part with the most to leak, would go
  // unexercised while the test still passed.
  const sim = createSimulation("descent", { seed, days: 40, ...simulationDefaults("descent") });
  const make = simulationPolicies("descent")["rule-based"];
  if (!make) throw new Error("no rule-based baseline");
  const pol = make();
  for (let i = 0; i < rounds && !sim.done; i++) {
    pol.act(sim);
    sim.advance();
  }
  return sim as typeof sim & { announce(): string; describeFor(who: string): string };
}

describe("the round-start state block", () => {
  it("states where the party is without anybody asking", () => {
    const said = played().announce();
    expect(said).toContain("<state>");
    expect(said, "the played configuration has a map; this test is not exercising it").toContain("<map>");
    expect(said).toMatch(/<where floor="\d+"/);
    expect(said).toMatch(/phase="[a-z]+"/);
    expect(said).toMatch(/round="\d+" of="\d+"/);
  });

  it("gives everybody the party's condition", () => {
    const said = played().announce();
    expect(said).toContain("<party>");
    for (const who of ["guardian", "mage", "rogue", "cleric", "ranger"]) {
      expect(said).toContain(who);
    }
  });

  it("never puts a purse in it", () => {
    // The private view writes a purse as "purse 137 gold". If that string ever
    // reaches the shared block, `give_gold` stops being a decision: everybody
    // can already see who is short.
    for (let seed = 1000; seed < 1012; seed++) {
      expect(played(seed).announce(), `seed ${seed} leaked a purse`).not.toMatch(/purse \d+ gold/);
    }
  });

  it("never puts a pack in it", () => {
    for (let seed = 1000; seed < 1012; seed++) {
      expect(played(seed).announce(), `seed ${seed} leaked a pack`).not.toMatch(/^\s*pack:/m);
    }
  });

  it("never puts the rogue's scouting in it", () => {
    // Scouting is the clearest case of the rule: it is an action *because* it
    // buys knowledge nobody had, and the rogue then has to choose to tell the
    // others. Pushing it would delete the choice.
    for (let seed = 1000; seed < 1012; seed++) {
      const said = played(seed).announce();
      expect(said, `seed ${seed} leaked the scout report`).not.toContain("What you saw ahead");
      expect(said).not.toContain("nobody else knows any of this");
    }
  });

  it("keeps the private view genuinely private", () => {
    // The other half of the same claim: what is withheld above must still be
    // reaching the one agent entitled to it, or the split is not a split, it is
    // a deletion.
    const sim = played();
    const mine = sim.describeFor("guardian");
    expect(mine).toContain("Your sheet:");
    expect(mine).toMatch(/purse \d+ gold/);
  });

  it("costs less than the calls it replaces", () => {
    // A block pushed to five agents every round is only a saving if it is not
    // enormous. This is a budget, deliberately generous, that fails loudly if
    // the block ever grows into a second transcript.
    const said = played().announce();
    expect(said.length, `state block is ${said.length} characters`).toBeLessThan(4000);
  });
});
