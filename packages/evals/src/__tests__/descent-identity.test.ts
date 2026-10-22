import { describe, expect, it } from "vitest";
import { generatePartyIdentities } from "../sim/descent/identity.js";
import type { DescentSimulation } from "../sim/descent/index.js";
import { CLASSES, type ClassId } from "../sim/descent/model.js";
import { createSimulation } from "../sim/index.js";
import { makeRng } from "../sim/rng.js";

const fresh = (seed: number, days = 40) =>
  createSimulation("descent", {
    seed,
    days,
    preparation: true,
    startingGold: 180,
    startingSkillPoints: 2,
    maze: true,
  }) as DescentSimulation;

describe("seeded descent identities", () => {
  it("repeats exactly for one seed while varying names, traits, history, and motives across seeds", () => {
    const first = fresh(73).view();
    const again = fresh(73).view();
    expect(again.party).toEqual(first.party);

    const signatures = new Set<string>();
    for (let seed = 1; seed <= 20; seed += 1) {
      const party = fresh(seed).view().party;
      signatures.add(
        JSON.stringify(
          CLASSES.map((id) => ({
            name: party[id].identity.displayName,
            traits: party[id].identity.traits.map((trait) => trait.score),
            story: party[id].identity.backstory,
            goal: party[id].identity.secretGoal.id,
          })),
        ),
      );
      expect(new Set(CLASSES.map((id) => party[id].identity.displayName.toLowerCase())).size).toBe(CLASSES.length);
      expect(new Set(CLASSES.map((id) => party[id].identity.secretGoal.id)).size).toBe(CLASSES.length);
      for (const id of CLASSES) {
        expect(party[id].identity.traits).toHaveLength(5);
        expect(party[id].identity.traits.every((trait) => trait.score >= 1 && trait.score <= 100)).toBe(true);
      }
    }
    expect(signatures.size).toBeGreaterThanOrEqual(18);
  });

  it("uses a fork that cannot perturb another simulation RNG stream", () => {
    const untouched = makeRng(991).fork("path");
    const expected = Array.from({ length: 12 }, () => untouched.next());

    const root = makeRng(991);
    generatePartyIdentities(root.fork("identities-v1"));
    const path = root.fork("path");
    expect(Array.from({ length: 12 }, () => path.next())).toEqual(expected);
  });

  it("shows an agent its private motive while allies receive only public identity", () => {
    const sim = fresh(12);
    const party = sim.view().party;
    const guardianGoal = party.guardian.identity.secretGoal.title;
    const mageGoal = party.mage.identity.secretGoal.title;
    const guardianView = sim.describeFor("guardian");

    expect(guardianView).toContain(guardianGoal);
    expect(guardianView).not.toContain(mageGoal);
    expect(guardianView).toContain(party.mage.identity.displayName);
    expect(guardianView).toContain(party.mage.identity.publicAspiration);
  });

  it("allows one safe camp rename without changing class authority", () => {
    const sim = fresh(5);
    const old = sim.view().party.guardian.identity.displayName;
    expect(sim.chooseName("guardian", "Mira Vale")).toMatch(/class id remains guardian/i);
    expect(sim.view().party.guardian.identity).toMatchObject({
      displayName: "Mira Vale",
      generatedName: old,
      nameSource: "agent",
      renamed: true,
    });
    expect(sim.view().party.guardian.id).toBe("guardian");
    expect(() => sim.chooseName("guardian", "Another Name")).toThrow(/already chosen/i);
    expect(() => sim.chooseName("mage", "Mira Vale")).toThrow(/already called/i);
    expect(() => sim.chooseName("mage", "<script>")).toThrow(/letters, spaces/i);
    expect(sim.enterDungeon("guardian")).toMatch(/party will enter/i);
    expect(sim.metrics().namesChosen).toBe(1);
  });

  it("keeps a motive private from allies until disclosure while retaining observer recap data", () => {
    const sim = fresh(18);
    const owner: ClassId = "mage";
    const title = sim.view().party[owner].identity.secretGoal.title;
    expect(sim.scene().party.find((member) => member.id === owner)?.identity.secretGoal).toMatchObject({
      title,
      revealed: false,
    });
    expect(sim.describeFor("guardian")).not.toContain(title);

    expect(sim.revealGoal(owner)).toContain(title);
    expect(sim.scene().party.find((member) => member.id === owner)?.identity.secretGoal.revealed).toBe(true);
    expect(sim.describeFor("guardian")).toContain(title);
    expect(sim.metrics().secretGoalsRevealed).toBe(1);
    expect(() => sim.revealGoal(owner)).toThrow(/already known/i);
  });

  it("advances a motive from a real action and awards exactly one skill point", () => {
    let sim: DescentSimulation | undefined;
    let giver: ClassId | undefined;
    for (let seed = 1; seed <= 500 && !giver; seed += 1) {
      const candidate = fresh(seed);
      const found = CLASSES.find((id) => candidate.view().party[id].identity.secretGoal.id === "benefactor");
      if (found) {
        sim = candidate;
        giver = found;
      }
    }
    expect(sim).toBeDefined();
    expect(giver).toBeDefined();
    if (!sim || !giver) return;

    const receiver = CLASSES.find((id) => id !== giver) as ClassId;
    const before = sim.view().party[giver].talentPoints;
    sim.giveGold(giver, receiver, 100);
    const completed = sim.view().party[giver];
    expect(completed.identity.secretGoal).toMatchObject({ progress: 100, completed: true, revealed: true });
    expect(completed.talentPoints).toBe(before + 1);
    expect(sim.metrics()).toMatchObject({ personalGoalsCompleted: 1, secretGoalsRevealed: 1 });

    sim.giveGold(receiver, giver, 1);
    sim.giveGold(giver, receiver, 1);
    expect(sim.view().party[giver].talentPoints).toBe(before + 1);
    expect(sim.metrics().personalGoalsCompleted).toBe(1);
  });

  it("discloses still-secret motives in the end-of-run scene for the recap", () => {
    const sim = fresh(9, 0);
    expect(sim.done).toBe(true);
    expect(sim.scene().party.every((member) => member.identity.secretGoal.title !== null)).toBe(true);
  });
});
