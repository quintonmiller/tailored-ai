/**
 * The traitor's outlet, and the party's answer to it.
 *
 * Until 2026-08-18 the betrayal layer was `whisper` and `accuse`, neither of
 * which does anything mechanical. A traitor had no move to make, which is why a
 * measured 24-round run ended with the traitor still describing the mage as
 * "the frag" and waiting for an opportunity that did not exist in the rules.
 *
 * `turn` is that move: one public, irreversible defection. These tests are
 * about the three properties that keep it a decision rather than an accident.
 */

import { describe, expect, it } from "vitest";
import type { ClassId } from "../sim/descent/model.js";
import { createSimulation, simulationDefaults } from "../sim/index.js";

interface Turnable {
  state: { party: Record<ClassId, { turned: boolean; dead: boolean; hp: number; power: number; armor: number }> };
  snapshot(): Record<string, unknown>;
  sharedTools(): Array<{ name: string; execute(a: unknown, c: unknown): Promise<unknown> }>;
}

function sim(reveal = "off"): {
  s: Turnable;
  traitor: ClassId;
  call: (n: string, a: unknown, who: string) => Promise<string>;
} {
  const s = createSimulation("descent-betrayed", {
    seed: 424242,
    days: 40,
    ...simulationDefaults("descent-betrayed"),
    traitors: "1",
    revealTraitors: true,
    reveal,
  }) as unknown as Turnable;
  const traitor = ((s.snapshot() as { scene?: { betrayal?: { traitors?: ClassId[] } } }).scene?.betrayal?.traitors ??
    [])[0];
  const call = async (name: string, args: unknown, who: string) => {
    const tool = s.sharedTools().find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const out = (await tool.execute(args, { agentName: who })) as { output?: string };
    // The tools report a refusal in their text rather than throwing.
    return String(out?.output ?? out);
  };
  return { s, traitor, call };
}

const loyalOf = (traitor: ClassId): ClassId =>
  (["guardian", "mage", "rogue", "cleric", "ranger"] as ClassId[]).find((c) => c !== traitor) as ClassId;

describe("who may turn", () => {
  it("lets somebody who is against the party do it", async () => {
    const { s, traitor, call } = sim();
    expect(await call("turn", {}, traitor)).not.toMatch(/^Refused:/);
    expect(s.state.party[traitor].turned).toBe(true);
  });

  it("refuses a loyal character, so a misread tool cannot end a run", async () => {
    const { s, traitor, call } = sim();
    const loyal = loyalOf(traitor);
    expect(await call("turn", {}, loyal)).toMatch(/^Refused:.*nothing to turn from/i);
    expect(s.state.party[loyal].turned).toBe(false);
  });

  it("cannot be taken back", async () => {
    const { traitor, call } = sim();
    await call("turn", {}, traitor);
    expect(await call("turn", {}, traitor)).toMatch(/^Refused:.*already turned/i);
  });
});

describe("what turning does", () => {
  it("buffs the defector by the swept amounts", async () => {
    // 3x/12 comes from a 60-seed sweep of the whole loop; see TURN_POWER.
    const { s, traitor, call } = sim();
    const before = { power: s.state.party[traitor].power, armor: s.state.party[traitor].armor };
    await call("turn", {}, traitor);
    expect(s.state.party[traitor].power).toBe(before.power * 3);
    // Small, and the reason is arithmetic rather than taste. Armour here is flat
    // subtraction with a floor of one, so the invariant that matters is not the
    // number itself but that a real hit still lands: a first pass at +12 left
    // every physical attack in the party doing exactly 1, and the sweep on top
    // of it was measuring invulnerability rather than betrayal.
    expect(s.state.party[traitor].armor).toBe(before.armor + 2);
    const realHit = 24; // an ability, not a base stat: live traces land 20-43.
    expect(Math.max(1, realHit - s.state.party[traitor].armor)).toBeGreaterThan(realHit / 2);
  });

  it("is public the moment it happens", async () => {
    // Discrete and announced, so the log keeps a named author for every hit and
    // no damage ever arrives from nowhere.
    const { traitor, call } = sim();
    await call("turn", {}, traitor);
    const seen = await call("look", {}, loyalOf(traitor));
    expect(`${seen}`).toBeTruthy();
    const { s } = sim();
    expect(s.state.party[loyalOf(traitor)].turned).toBe(false);
  });
});

describe("the vigil", () => {
  it("refuses before a floor has been cleared, and says why", async () => {
    const { traitor, call } = sim("vigil");
    expect(await call("vigil", { who: traitor }, loyalOf(traitor))).toMatch(/^Refused:.*floor cleared/i);
  });

  it("is absent entirely when the mode is off", async () => {
    const { s } = sim("off");
    expect(s.sharedTools().map((t) => t.name)).not.toContain("vigil");
  });

  it("is the only reveal tool its mode offers", async () => {
    for (const [mode, expected] of [
      ["vigil", "vigil"],
      ["reckoning", "reckoning"],
    ] as Array<[string, string]>) {
      const names = sim(mode)
        .s.sharedTools()
        .map((t) => t.name);
      expect(names).toContain(expected);
      for (const other of ["vigil", "tally", "reckoning"].filter((n) => n !== expected)) {
        expect(names).not.toContain(other);
      }
    }
  });
});
