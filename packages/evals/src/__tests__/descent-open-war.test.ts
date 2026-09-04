/**
 * What happens after somebody turns — which, until 2026-08-19, was nothing.
 *
 * The betrayal layer shipped a public defection, buffed the defector, gave it a
 * free opening strike, and told it *"You may name party members as targets, and
 * they may name you."* None of that last part was true. `useBasic` resolved its
 * target through `findEnemy`, which searches `state.enemies` and has no branch
 * for a person, so **both directions were refused** and `findTurnedCombatant`
 * — the function that resolves a person as a target — was unreachable code.
 *
 * Measured on the run of 2026-08-19: a turned rogue tried to attack a named
 * loyalist three times across ten rounds and was refused every time. After its
 * one free strike it had no way to hurt anybody for the rest of the game, and
 * the party had no way to hit back. They travelled three floors together.
 *
 * Every test here is a property that run violated.
 */

import { describe, expect, it } from "vitest";
import type { ClassId } from "../sim/descent/model.js";
import { createSimulation, simulationDefaults, simulationPolicies } from "../sim/index.js";

const CLASSES: ClassId[] = ["guardian", "mage", "rogue", "cleric", "ranger"];

interface War {
  turn(agent: string, who?: string): string;
  useBasic(agent: string, target: string): string;
  requestRetreat(agent: string): string;
  traitorRoles(): ReadonlySet<ClassId>;
  announce(): string;
  view(): { phase: string; party: Record<ClassId, { hp: number; maxHp: number; power: number; dead: boolean }> };
  effective(f: unknown): void;
  investTalent(agent: string, talent: string): string;
  state: { party: Record<ClassId, { talentPoints: number; turned: boolean }> };
}
type Sim = ReturnType<typeof createSimulation> & War;

/** A party in a fight, with one traitor, ready to be betrayed. */
function inCombat(seed = 1000): { sim: Sim; traitor: ClassId; loyal: ClassId } {
  const sim = createSimulation("descent", {
    seed,
    days: 40,
    ...simulationDefaults("descent"),
    traitors: 1,
    reveal: "social",
  }) as Sim;
  const pol = simulationPolicies("descent")["rule-based"]?.();
  if (!pol) throw new Error("no rule-based baseline");
  for (let i = 0; i < 40 && !sim.done; i++) {
    if (sim.view().phase === "combat") break;
    pol.act(sim);
    sim.advance();
  }
  const traitor = [...sim.traitorRoles()][0];
  const loyal = CLASSES.find((c) => !sim.traitorRoles().has(c));
  if (!traitor || !loyal) throw new Error("this seed rolled no traitor");
  return { sim, traitor, loyal };
}

describe("once somebody has turned", () => {
  it("lets the traitor name a person, which is what `turn` has always promised", () => {
    const { sim, traitor, loyal } = inCombat();
    sim.turn(traitor);
    expect(sim.useBasic(traitor, loyal)).not.toMatch(/^Refused|standing against you/);
  });

  it("lets the party hit back", () => {
    // The half that matters more. A defector the party cannot answer is not a
    // mechanic, it is a cutscene.
    const { sim, traitor, loyal } = inCombat();
    sim.turn(traitor);
    expect(sim.useBasic(loyal, traitor)).not.toMatch(/^Refused|standing against you/);
  });

  it("names people in the refusal when a target does not exist", () => {
    // The old text answered "no enemy called \"rogue\" is standing. Try:
    // husk-3, shaman-4" to a loyalist trying to defend itself — teaching the
    // party, wrongly, that fighting back was not a thing.
    const { sim, traitor, loyal } = inCombat();
    sim.turn(traitor);
    let refusal = "";
    try {
      sim.useBasic(loyal, "nobody-at-all");
    } catch (err) {
      refusal = (err as Error).message;
    }
    expect(refusal).toContain(traitor);
  });

  it("refuses to let anybody walk away", () => {
    const { sim, traitor, loyal } = inCombat();
    sim.turn(traitor);
    let refusal = "";
    try {
      sim.requestRetreat(loyal);
    } catch (err) {
      refusal = (err as Error).message;
    }
    expect(refusal).toMatch(/no retreating|coming with you/i);
  });

  it("starts a fight even when the turn happens outside one", () => {
    // The observed failure: a traitor declared during `explore`, and because
    // attacks are combat-only nobody could swing while every exploration verb
    // stayed legal. The party kept descending with its declared killer.
    const sim = createSimulation("descent", {
      seed: 1000,
      days: 40,
      ...simulationDefaults("descent"),
      traitors: 1,
      reveal: "social",
    }) as Sim;
    const traitor = [...sim.traitorRoles()][0];
    expect(sim.view().phase).not.toBe("combat");
    sim.turn(traitor);
    expect(sim.view().phase, "turning outside combat must start one").toBe("combat");
  });

  it("does not end that fight just because there are no monsters in it", () => {
    // A traitor-only fight has an empty `enemies` array, and the combat branch
    // ended an encounter the moment nothing was left standing — so a turn
    // outside combat resolved to peace before anybody acted.
    const sim = createSimulation("descent", {
      seed: 1000,
      days: 40,
      ...simulationDefaults("descent"),
      traitors: 1,
      reveal: "social",
    }) as Sim;
    const traitor = [...sim.traitorRoles()][0];
    sim.turn(traitor);
    sim.advance();
    expect(sim.view().phase, "the fight ended with the defector still standing").toBe("combat");
  });

  it("tells everybody, in the round it happens", () => {
    // `lastLog` surfaces a round later and the combat branch overwrites it, so
    // a silent turn used to be invisible: a body on the floor, no attribution,
    // and on a final round no next announcement to explain it.
    const { sim, traitor, loyal } = inCombat();
    sim.turn(traitor);
    const tools = sim.sharedTools();
    const look = tools.find((t) => t.name === "look");
    if (!look) throw new Error("no look tool");
    return (look.execute({}, { agentName: loyal }) as Promise<{ output?: string }>).then((r) => {
      expect(String(r.output)).toMatch(/has turned on the party/);
    });
  });

  it("keeps the defection through a stat recompute", () => {
    /*
     * `turn()` mutated `power`, `armor` and `maxHp`; `effective()` rebuilds all
     * three from base + level + gear + talents and knew nothing about it. In
     * the live run one skill point erased the whole thing:
     *
     *     turn 147  maxHp 190 -> 304 | power  35 -> 105
     *     turn 192  maxHp 304 -> 190 | power 105 ->  37
     */
    const { sim, traitor } = inCombat();
    const before = { ...sim.view().party[traitor] };
    sim.turn(traitor);
    const after = { ...sim.view().party[traitor] };
    // Asserted first, and the reason is a control run: with the derivation
    // removed from `effective()`, `turn()` applies nothing, so "unchanged by a
    // recompute" is trivially true and the whole test passes against broken
    // code. It did. A persistence check has to prove there was something to
    // persist.
    expect(after.power, "turning did not buff anything").toBeGreaterThan(before.power);
    expect(after.maxHp).toBeGreaterThan(before.maxHp);
    sim.effective(sim.state.party[traitor]);
    expect(sim.view().party[traitor].power, "a bare recompute erased the buff").toBe(after.power);
    expect(sim.view().party[traitor].maxHp).toBe(after.maxHp);
  });

  it("strikes whoever the traitor named, not whoever is weakest", () => {
    // A rogue turned saying "You're the one I put my knife in" about the
    // cleric, and the engine killed the guardian, because the guardian happened
    // to be lower on health. The traitor's own narration was false.
    const { sim, traitor } = inCombat();
    const others = CLASSES.filter((c) => c !== traitor && !sim.view().party[c].dead);
    const strongest = others.sort((a, b) => sim.view().party[b].hp - sim.view().party[a].hp)[0];
    const before = sim.view().party[strongest].hp;
    sim.turn(traitor, strongest);
    expect(sim.view().party[strongest].hp, "the named target was not the one hit").toBeLessThan(before);
  });

  it("puts the defector on the enemy side of the scene, spoilers or not", () => {
    const { sim, traitor } = inCombat();
    sim.turn(traitor);
    const scene = (sim.snapshot() as { scene: { party: Array<{ id: string; turned: boolean }> } }).scene;
    expect(scene.party.find((p) => p.id === traitor)?.turned).toBe(true);
    for (const other of scene.party.filter((p) => p.id !== traitor)) expect(other.turned).toBe(false);
  });

  it("computes the bind threshold instead of always saying three", () => {
    // It was the literal string "three of you". With a party down to two the
    // true threshold is one, and this line told the last loyalist alive that
    // she needed three. She never tried.
    const { sim } = inCombat();
    expect(sim.announce()).toMatch(/bind` holds somebody if 3 of you/);
    for (const id of ["mage", "ranger"] as ClassId[]) sim.state.party[id].turned = false;
    (sim.view().party.mage as { dead: boolean }).dead = true;
    (sim.view().party.ranger as { dead: boolean }).dead = true;
    expect(sim.announce(), "the threshold did not follow the headcount").toMatch(/bind` holds somebody if 2 of you/);
  });
});
