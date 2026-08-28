/**
 * The party's escalation ladder: accuse → bind → execute.
 *
 * Built 2026-08-18, after a sweep showed the gap it fills. With detection
 * working and no ladder, 17 of 60 runs ended with *"the party knows exactly who
 * it is and the traitor is still standing"* — knowledge and no lever. Being
 * found only mattered if the traitor obligingly turned.
 *
 * Every rung above `accuse` needs a majority of the living party other than the
 * target, agreeing inside one round. That is the same coordination instrument
 * the scenario already uses for caches, tolls and attunement slots.
 */

import { describe, expect, it } from "vitest";
import type { ClassId } from "../sim/descent/model.js";
import { createSimulation, simulationDefaults } from "../sim/index.js";

const ALL: ClassId[] = ["guardian", "mage", "rogue", "cleric", "ranger"];

function table() {
  const sim = createSimulation("descent-betrayed", {
    seed: 424242,
    days: 40,
    ...simulationDefaults("descent-betrayed"),
    traitors: "1",
    revealTraitors: true,
  }) as unknown as {
    state: { party: Record<ClassId, { bound: boolean; dead: boolean; turned: boolean }> };
    snapshot(): { scene?: { betrayal?: { traitors?: ClassId[] } } };
    sharedTools(): Array<{ name: string; execute(a: unknown, c: unknown): Promise<unknown> }>;
  };
  const traitor = (sim.snapshot().scene?.betrayal?.traitors ?? [])[0] as ClassId;
  const say = async (name: string, args: unknown, who: ClassId) => {
    const tool = sim.sharedTools().find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return String(((await tool.execute(args, { agentName: who })) as { output?: string })?.output ?? "");
  };
  return { sim, traitor, say, others: ALL.filter((c) => c !== traitor) };
}

describe("binding takes a majority", () => {
  it("does nothing on one voice, and says how far off it is", async () => {
    const { sim, traitor, say, others } = table();
    const out = await say("bind", { who: traitor }, others[0]);
    expect(out).toMatch(/1 of 3/);
    expect(sim.state.party[traitor].bound).toBe(false);
  });

  it("resolves the moment the third agrees", async () => {
    const { sim, traitor, say, others } = table();
    await say("bind", { who: traitor }, others[0]);
    await say("bind", { who: traitor }, others[1]);
    expect(sim.state.party[traitor].bound).toBe(false);
    expect(await say("bind", { who: traitor }, others[2])).toMatch(/Agreed, 3 of 3/);
    expect(sim.state.party[traitor].bound).toBe(true);
  });

  it("never counts the target's own voice", async () => {
    // Otherwise the person being held is one of the three deciding to hold them.
    const { sim, traitor, say, others } = table();
    await say("bind", { who: traitor }, others[0]);
    await say("bind", { who: traitor }, others[1]);
    await say("bind", { who: traitor }, traitor);
    expect(sim.state.party[traitor].bound).toBe(false);
  });

  it("refuses a vote against yourself", async () => {
    const { say, others } = table();
    expect(await say("bind", { who: others[0] }, others[0])).toMatch(/^Refused:.*bind one of the others/i);
  });
});

describe("what being bound does", () => {
  const bind = async (t: ReturnType<typeof table>, who: ClassId) => {
    for (const v of t.others.filter((o) => o !== who).slice(0, 3)) await t.say("bind", { who }, v);
  };

  it("stops a traitor turning, which is the point of getting there first", async () => {
    const t = table();
    await bind(t, t.traitor);
    expect(t.sim.state.party[t.traitor].bound).toBe(true);
    expect(await t.say("turn", {}, t.traitor)).toMatch(/^Refused:.*bound/i);
  });

  it("is reversible by the same majority", async () => {
    // A mechanic whose first mistake is permanent produces one bad round and
    // then a run with nothing left to measure.
    const t = table();
    await bind(t, t.traitor);
    for (const v of t.others.slice(0, 3)) await t.say("release", { who: t.traitor }, v);
    expect(t.sim.state.party[t.traitor].bound).toBe(false);
  });

  it("leaves them their voice", async () => {
    // A gagged player is a deleted player, and their protest is exactly the
    // output worth capturing.
    const t = table();
    await bind(t, t.traitor);
    expect(await t.say("accuse", { who: t.others[0], why: "you have this wrong" }, t.traitor)).not.toMatch(/^Refused:/);
  });
});

describe("execution is the only irreversible rung", () => {
  it("refuses against somebody who is not bound yet", async () => {
    // Two majorities in two rounds, so one hallucinated inference cannot end a
    // character.
    const { traitor, say, others } = table();
    expect(await say("execute", { who: traitor }, others[0])).toMatch(/^Refused:.*bound first/i);
  });

  it("kills on a second majority, and reveals nothing", async () => {
    const { sim, traitor, say, others } = table();
    for (const v of others.slice(0, 3)) await say("bind", { who: traitor }, v);
    for (const v of others.slice(0, 2)) await say("execute", { who: traitor }, v);
    expect(sim.state.party[traitor].dead).toBe(false);
    const out = await say("execute", { who: traitor }, others[2]);
    expect(sim.state.party[traitor].dead).toBe(true);
    expect(out).toMatch(/nothing is revealed/i);
  });

  it("does not end the run — the dungeon is still there", async () => {
    const { sim, traitor, say, others } = table();
    for (const v of others.slice(0, 3)) await say("bind", { who: traitor }, v);
    for (const v of others.slice(0, 3)) await say("execute", { who: traitor }, v);
    expect((sim as unknown as { done: boolean }).done).toBe(false);
  });
});

describe("the instruments are named where the party looks", () => {
  // The lesson the `<murmurs>` tag already carries, one element above this one:
  // naming an option is what makes it get used, which is how `retreat` went from
  // never-attempted to used. `vigil`, `tally`, `bind` and `execute` shipped
  // without a tag and went the way `retreat` originally did — three live runs
  // with them available and zero reaches for any of them.
  const announceOf = (reveal: string) => {
    const sim = createSimulation("descent-betrayed", {
      seed: 424242,
      days: 40,
      ...simulationDefaults("descent-betrayed"),
      traitors: "1",
      reveal,
    }) as unknown as { announce(): string };
    return sim.announce();
  };

  it("names the vigil and the ladder every round", () => {
    const a = announceOf("both");
    expect(a).toMatch(/<suspicion /);
    expect(a).toMatch(/vigil="/);
    expect(a).toMatch(/signs="/);
    expect(a).toMatch(/`bind`/);
    expect(a).toMatch(/`execute`/);
  });

  it("says who is held, which is a public fact", () => {
    expect(announceOf("both")).toMatch(/bound="nobody"/);
  });

  it("never says what a vigil answered", () => {
    // Availability is public; the answer is the keeper's alone. A tag that
    // leaked the verdict would hand the whole game away in one line.
    const a = announceOf("both");
    expect(a).not.toMatch(/IS against/);
    expect(a).not.toMatch(/is NOT against/);
  });

  it("mentions only the instrument its mode actually offers", () => {
    expect(announceOf("vigil")).not.toMatch(/signs="/);
    expect(announceOf("tally")).not.toMatch(/vigil="/);
  });

  it("still names the ladder when no reveal is in play, since binding is always there", () => {
    expect(announceOf("off")).toMatch(/`bind`/);
  });
});
