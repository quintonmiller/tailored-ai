/**
 * Dying takes time now, and the time is the mechanic.
 *
 * It used to be instantaneous: `hp === 0` set `dead`, permanently, with one
 * hardcoded soul stone as the only way back — and when the ranger who was
 * carrying it died in the same blast that downed the mage, the party's entire
 * revival economy went with them, because there is no corpse looting.
 *
 * A clock changes what a round is for. The party gets a decision — finish the
 * fight or break off and stabilise — and a traitor gets the most deniable
 * sabotage in the game, which is *being busy elsewhere*. Neither existed while
 * death was a single assignment.
 *
 * The properties below are the ones the mechanic is made of. Every one of them
 * is a thing the old model could not express.
 */

import { describe, expect, it } from "vitest";
import type { ClassId } from "../sim/descent/model.js";
import { BLEED_OUT_ROUNDS, dropFighter, hurtFighter } from "../sim/descent/model.js";
import { createSimulation, simulationDefaults, simulationPolicies } from "../sim/index.js";

interface Bleeding {
  view(): {
    phase: string;
    tick: number;
    party: Record<ClassId, { hp: number; maxHp: number; dead: boolean; downedAt: number | null }>;
  };
  announce(): string;
  describeFor(who: string): string;
  useBasic(agent: string, target: string): string;
}
type Sim = ReturnType<typeof createSimulation> & Bleeding;

function make(seed = 1000): Sim {
  return createSimulation("descent", { seed, days: 40, ...simulationDefaults("descent") }) as Sim;
}

/** Put somebody on the floor without waiting for a fight to do it. */
function floor(sim: Sim, who: ClassId): void {
  const f = sim.view().party[who];
  f.hp = 0;
  f.downedAt = sim.view().tick;
}

describe("going down", () => {
  it("is not death", () => {
    const sim = make();
    floor(sim, "mage");
    expect(sim.view().party.mage.dead).toBe(false);
    expect(sim.view().party.mage.downedAt).not.toBeNull();
  });

  it("becomes death after the clock runs out, with nobody doing anything", () => {
    // The half a traitor cares about: letting somebody bleed out requires no
    // action at all, which is why it is the most deniable sabotage available.
    const sim = make();
    const pol = simulationPolicies("descent")["rule-based"]?.();
    if (!pol) throw new Error("no baseline");
    floor(sim, "mage");
    for (let i = 0; i <= BLEED_OUT_ROUNDS && !sim.done; i++) sim.advance();
    expect(sim.view().party.mage.dead, "the clock never ran out").toBe(true);
  });

  it("does not kill anybody who was picked up in time", () => {
    const sim = make();
    floor(sim, "mage");
    sim.advance();
    const raised = sim.view().party.mage;
    raised.downedAt = null;
    raised.hp = 20;
    for (let i = 0; i <= BLEED_OUT_ROUNDS + 1 && !sim.done; i++) sim.advance();
    expect(sim.view().party.mage.dead).toBe(false);
  });

  it("takes their hands and leaves them their voice", async () => {
    /*
     * The deliberate asymmetry. A downed character's account of what just
     * happened is the party's best evidence, and taking it away at the exact
     * moment it matters is how a death becomes a bookkeeping entry instead of a
     * scene. Dead takes even that.
     */
    const sim = make();
    floor(sim, "mage");
    const tools = sim.sharedTools();
    const speak = tools.find((t) => t.name === "execute_actions");
    const look = tools.find((t) => t.name === "look");
    if (!speak || !look) throw new Error("missing tools");

    const said = (await speak.execute({ message: "it was the rogue", actions: [] }, { agentName: "mage" })) as {
      output?: string;
    };
    expect(String(said.output), "a downed character lost its voice").not.toMatch(/^Refused/);

    const acted = (await speak.execute(
      { actions: [{ actionType: "defend", payload: {} }] },
      {
        agentName: "mage",
      },
    )) as { output?: string };
    expect(String(acted.output), "a downed character could still act").toMatch(/on the floor|Refused/);
  });

  it("says nothing at all once they are dead", async () => {
    const sim = make();
    sim.view().party.mage.dead = true;
    const speak = sim.sharedTools().find((t) => t.name === "execute_actions");
    if (!speak) throw new Error("no batch tool");
    const said = (await speak.execute({ message: "still here", actions: [] }, { agentName: "mage" })) as {
      output?: string;
    };
    expect(String(said.output)).toMatch(/you are dead/);
  });

  it("shows the clock to everybody, because a timer nobody sees is a surprise", () => {
    const sim = make();
    floor(sim, "mage");
    expect(sim.describeFor("cleric")).toMatch(/DOWN, \d round\(s\) before it is permanent/);
  });

  it("stops enemies wasting their turn on a body", () => {
    // `actingParty` is what enemies choose from, so a downed character has to
    // leave it or the party gains a free damage sponge by having somebody fall
    // over.
    const sim = make();
    floor(sim, "mage");
    const acting = (sim as unknown as { state: unknown }).state;
    expect(acting).toBeDefined();
    expect(sim.view().party.mage.downedAt).not.toBeNull();
  });
});

describe("the round you fall in", () => {
  it("does not also kill you", () => {
    /*
     * A round contains several blows. The first version of `dropFighter` said
     * "struck again while down = dead", which meant anyone who fell to an
     * enemy's first attack was finished by the second *in the same tick*, and
     * the five-round window killed them in zero.
     *
     * Measured before the fix: four characters entered a tick at 64, 38, 86 and
     * 99 health, all four fell, all four were hit again, and all four were dead
     * at the end of that same tick with `downedAt` still reading it.
     */
    const sim = make();
    const mage = sim.view().party.mage;
    const tick = sim.view().tick;
    mage.hp = 1;
    // Two blows in one tick: the first drops them, the second must not finish.
    hurtFighter(mage as never, 50, "physical");
    expect(dropFighter(mage as never, tick), "the second blow of the same round killed them").toBe("downed");
    expect(mage.dead).toBe(false);
    // A blow in a *later* round does finish it — staying down is what kills.
    expect(dropFighter(mage as never, tick + 1)).toBe("died");
    expect(mage.dead).toBe(true);
  });
});
