/**
 * The questions worth asking a model one turn at a time.
 *
 * Every probe here is a question this workstream has already answered the
 * expensive way — by playing a forty-round run and reading the trace. The cost
 * of each answer was roughly four hours and one sample, and three of them
 * turned out to be about harness bugs rather than about models.
 *
 * A probe is deliberately *not* a test of good play. It asks whether a
 * character in the situation the tool was designed for thinks of the tool at
 * all. That is the class of defect that has actually bitten here: an action
 * economy nobody stated, a tool name shadowed by the harness, a brief that
 * argued a traitor out of acting. All three would have shown up in thirty
 * seconds.
 */

import type { ProbeSetup } from "./probe.js";
import type { ClassId } from "./sim/descent/model.js";
import type { Simulation } from "./sim/types.js";

interface Party {
  state: {
    party: Record<ClassId, { hp: number; maxHp: number; downedAt: number | null; dead: boolean }>;
    tick: number;
  };
  traitorRoles(): ReadonlySet<ClassId>;
}

const traitorOf = (sim: Simulation): ClassId => [...(sim as unknown as Party).traitorRoles()][0];
const loyalOf = (sim: Simulation): ClassId => {
  const traitors = (sim as unknown as Party).traitorRoles();
  return (["guardian", "mage", "rogue", "cleric", "ranger"] as ClassId[]).find((c) => !traitors.has(c)) as ClassId;
};

export const PROBES: ProbeSetup[] = [
  {
    name: "traitor-vial",
    asks: "does a traitor holding a free vial ever use it?",
    simOptions: { traitors: 1, reveal: "social" },
    warmup: 4,
    agent: "rogue",
    // Whoever the roll actually made a traitor. Asking a fixed class measured a
    // loyal character being invited to poison somebody four times in six.
    agentFor: (sim) => traitorOf(sim),
    wants: ["poison", "execute_actions"],
    arrange: (sim) => `traitor is ${traitorOf(sim)}`,
  },
  {
    name: "read-a-stranger",
    asks: "does anybody size somebody up unprompted, with the layer on?",
    simOptions: { traitors: 1, reveal: "social" },
    warmup: 3,
    agent: "cleric",
    agentFor: (sim) => loyalOf(sim),
    wants: ["size_up", "execute_actions"],
  },
  {
    name: "somebody-is-down",
    asks: "does the party pick up a body before the clock runs out?",
    simOptions: { traitors: 0, reveal: "off" },
    warmup: 6,
    agent: "cleric",
    wants: ["heal", "execute_actions", "use_item"],
    arrange: (sim) => {
      const s = (sim as unknown as Party).state;
      s.party.mage.hp = 0;
      s.party.mage.downedAt = s.tick;
      return "mage is on the floor";
    },
  },
  {
    name: "out-of-arrows",
    asks: "does a ranger with an empty quiver notice, and do something else?",
    simOptions: { traitors: 0, reveal: "off" },
    warmup: 6,
    agent: "ranger",
    wants: ["execute_actions", "attack", "buy", "rest"],
    arrange: (sim) => {
      const s = (sim as unknown as Party).state as unknown as {
        party: Record<ClassId, { arrows: number }>;
      };
      s.party.ranger.arrows = 0;
      return "quiver empty";
    },
  },
];
