/**
 * The half of the broadcast that is arithmetic rather than pixels.
 *
 * The page itself is a browser and a headless check of canvas output would
 * assert on pixels nobody agreed on — but the sentences under it are pure
 * functions over two scenes, and those are exactly the thing that has to be
 * right. A viewer misreading an invented event is worse than a viewer seeing
 * less, so the rules that decide *whether* an event happened, and the rule that
 * decides what to call a blow that did nothing, are pinned here.
 *
 * The two traps these tests exist for:
 *
 * - The harness writes a snapshot after every turn, so one round of five agents
 *   publishes five scenes carrying identical `beats`. Anything derived from
 *   them must key on `beatsTick` or it reports five deaths for one.
 * - Old traces are missing newer fields, and a page that throws on one is a
 *   page that blanks for the rest of the run.
 */

import { describe, expect, it } from "vitest";
import {
  beatTallies,
  happenings,
  shieldedRefs,
  wastedReason,
  zeroDamageReason,
} from "../../viewer/broadcast/src/happenings.js";
import { isMark, itemCategory, markPath, slotMark, statusShort, statusTone } from "../../viewer/broadcast/src/marks.js";
import type { Scene, SceneBeat } from "../broadcast-contract.js";

/**
 * A scene with only the fields a test cares about.
 *
 * Cast rather than filled in: a trace written before a field existed arrives
 * exactly this shape, so building the partial *is* the realistic fixture, and a
 * complete one would quietly stop testing the tolerance.
 */
const scene = (fields: Partial<Scene>): Scene => fields as Scene;

const beats = (list: SceneBeat[], tick = 1): Partial<Scene> => ({ beats: list, beatsTick: tick });

describe("why a blow did nothing", () => {
  /**
   * `computeDamage` floors physical damage at 1 before shields and brings a
   * physical immunity back out of that floor as 1 — so a physical zero has
   * exactly one cause and can be named outright.
   */
  it("names the shield when the element is physical, because nothing else can reach zero", () => {
    expect(zeroDamageReason("physical", false)).toBe("the shield swallowed it");
    expect(zeroDamageReason("physical", true)).toBe("the shield swallowed it");
  });

  it("names immunity when the target had no shield to spend", () => {
    expect(zeroDamageReason("fire", false)).toBe("immune to fire");
  });

  /**
   * Both mechanisms were available, so both are printed. Picking one would be
   * the page inventing state, and a viewer who catches one invented label has
   * a reason to distrust every other number on the screen.
   */
  it("keeps the ambiguous case ambiguous", () => {
    expect(zeroDamageReason("frost", true)).toBe("shielded, or immune to frost");
  });

  it("uses the simulation's own word for an action that never happened", () => {
    expect(wastedReason("asleep")).toBe("asleep — the action was lost");
    expect(wastedReason(undefined)).toBe("the action was lost");
  });
});

describe("folding a round of beats", () => {
  it("sums the damage aimed at each combatant", () => {
    const tallies = beatTallies(
      [
        { kind: "hit", from: "rogue", to: "husk-1", amount: 90 },
        { kind: "hit", from: "mage", to: "husk-1", amount: 45 },
        { kind: "heal", from: "cleric", to: "guardian", amount: 30 },
      ],
      new Set(),
    );
    expect(tallies.get("husk-1")?.damage).toBe(135);
    expect(tallies.get("guardian")?.healed).toBe(30);
  });

  it("counts a landing blow that did nothing, and says why", () => {
    const tallies = beatTallies(
      [
        { kind: "hit", from: "crystal-2", to: "guardian", amount: 0, element: "physical" },
        { kind: "hit", from: "crystal-3", to: "guardian", amount: 0, element: "physical" },
      ],
      new Set(),
    );
    expect(tallies.get("guardian")).toMatchObject({ damage: 0, blanks: 2, reason: "the shield swallowed it" });
  });

  /**
   * An arcane well restores mana through a `mechanic` beat with an amount and
   * no element. Counting it as a wound would print a number in the colour of
   * damage over somebody who was just given something.
   */
  it("does not read a mana restore as a wound", () => {
    const tallies = beatTallies(
      [{ kind: "mechanic", to: "mage", amount: 40, note: "environment-arcane-well" }],
      new Set(),
    );
    expect(tallies.get("mage")).toBeUndefined();
  });

  it("keeps a lost action separate from a blow that landed for nothing", () => {
    const tallies = beatTallies([{ kind: "wasted", to: "mage", note: "asleep" }], new Set());
    expect(tallies.get("mage")).toMatchObject({ blanks: 0, wasted: "asleep — the action was lost" });
  });

  it("reads shields off the scene that preceded the round", () => {
    const carriers = shieldedRefs(
      scene({
        party: [{ id: "guardian", statuses: [{ kind: "shield", ticks: 1, amount: 31 }] }] as Scene["party"],
        enemies: [{ ref: "husk-1", statuses: [{ kind: "burn", ticks: 2, amount: 4 }] }] as Scene["enemies"],
      }),
    );
    expect([...carriers]).toEqual(["guardian"]);
  });

  it("survives a scene with no beats at all", () => {
    expect(beatTallies(undefined, new Set()).size).toBe(0);
  });
});

describe("what changed between two scenes", () => {
  const kinds = (before: Partial<Scene> | null, after: Partial<Scene>) =>
    happenings(before ? scene(before) : null, scene(after)).map((h) => h.kind);

  it("marks a descent, and does not also call it a move", () => {
    const before = { floor: 31, floorMap: { currentRoom: "a", rooms: [], routes: [], zone: "z", keys: 0 } };
    const after = { floor: 32, floorMap: { currentRoom: "b", rooms: [], routes: [], zone: "z", keys: 0 } };
    expect(kinds(before as Partial<Scene>, after as Partial<Scene>)).toEqual(["descend"]);
  });

  it("marks a move between rooms on the same floor, and names where they went", () => {
    const room = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      label: `${id} hall`,
      kind: "combat",
      links: [],
      x: 0,
      y: 0,
      visited: true,
      revealed: true,
      cleared: false,
      key: false,
      keyCollected: false,
      environment: null,
      threat: null,
      ...extra,
    });
    const map = (current: string) => ({
      zone: "The Sunken Gate",
      currentRoom: current,
      keys: 0,
      rooms: [room("a"), room("b")],
      routes: [],
    });
    const found = happenings(
      scene({ floor: 31, floorMap: map("a") } as Partial<Scene> as Scene),
      scene({ floor: 31, floorMap: map("b") } as Partial<Scene> as Scene),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "move", text: "The party moves into b hall." });
  });

  /**
   * A retreat is only knowable from the encounter left behind — the room keeps
   * its enemies and counts how many times the party has run from them.
   */
  it("marks a retreat, and reads the free swings off the same tick", () => {
    const room = (retreats: number) => ({
      id: "a",
      label: "chain hall",
      kind: "combat",
      links: [],
      x: 0,
      y: 0,
      visited: true,
      revealed: true,
      cleared: false,
      key: false,
      keyCollected: false,
      environment: null,
      threat: { enemies: 2, hp: 300, maxHp: 900, retreats },
    });
    const map = (retreats: number) => ({ zone: "z", currentRoom: "a", keys: 0, rooms: [room(retreats)], routes: [] });
    const found = happenings(
      scene({ floor: 31, floorMap: map(0), beatsTick: 4 } as Partial<Scene> as Scene),
      scene({
        floor: 31,
        floorMap: map(1),
        beatsTick: 5,
        beats: [
          { kind: "hit", from: "husk-1", to: "guardian", amount: 41 },
          { kind: "hit", from: "husk-2", to: "rogue", amount: 12 },
          // The party's own blow does not count: retreat empties their queue,
          // so anything from one of the five is not an unanswered swing.
          { kind: "hit", from: "rogue", to: "husk-1", amount: 90 },
        ],
      } as Partial<Scene> as Scene),
    );
    expect(found.map((h) => h.kind)).toEqual(["retreat", "opportunity"]);
    expect(found[1]).toMatchObject({
      text: "2 free swings land as the party pulls out.",
      detail: "53 damage, unanswered",
    });
  });

  it("says where a drop went, once", () => {
    const drop = { id: "sword-7", name: "Night Edge", rarity: "uncommon", kind: "weapon", to: "guardian" };
    const found = happenings(
      scene({ loot: [] } as Partial<Scene> as Scene),
      scene({ loot: [drop] } as Partial<Scene> as Scene),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "loot", who: "guardian", text: "Night Edge goes to guardian." });
    // Still in the list next turn, and not news any more.
    expect(kinds({ loot: [drop] } as Partial<Scene>, { loot: [drop] } as Partial<Scene>)).toEqual([]);
  });

  it("marks a level, an equip and a point spent", () => {
    const member = (extra: Record<string, unknown>) => ({
      id: "guardian",
      worn: [],
      talents: [],
      ...extra,
    });
    const found = happenings(
      scene({ level: 34, party: [member({})] } as Partial<Scene> as Scene),
      scene({
        level: 35,
        party: [
          member({
            worn: [{ id: "plate-2", name: "Bulwark Plate", slot: "armor", rarity: "rare" }],
            talents: [{ id: "bastion", name: "Bastion", rank: 1 }],
          }),
        ],
      } as Partial<Scene> as Scene),
    );
    expect(found.map((h) => h.kind)).toEqual(["levelup", "equip", "talent"]);
    expect(found[1].text).toBe("guardian puts on Bulwark Plate.");
    expect(found[2]).toMatchObject({ text: "guardian invests in Bastion.", detail: "rank 1" });
  });

  /**
   * The five-scenes-per-round trap. Two publications of the same round carry
   * identical beats, and the second must produce nothing at all.
   */
  it("does not re-announce a round of beats that five snapshots all carry", () => {
    const blank: SceneBeat[] = [{ kind: "hit", from: "husk-1", to: "guardian", amount: 0, element: "fire" }];
    expect(kinds(beats([], 4), beats(blank, 5))).toEqual(["nodamage"]);
    expect(kinds(beats(blank, 5), beats(blank, 5))).toEqual([]);
  });

  it("explains a blow that did nothing, naming the target rather than its ref", () => {
    const found = happenings(
      scene({ beatsTick: 4, enemies: [{ ref: "wisp-1", name: "Elite Fire Wisp" }] } as Partial<Scene> as Scene),
      scene({
        beatsTick: 5,
        beats: [{ kind: "hit", from: "mage", to: "wisp-1", amount: 0, element: "fire" }],
        enemies: [{ ref: "wisp-1", name: "Elite Fire Wisp" }],
      } as Partial<Scene> as Scene),
    );
    expect(found[0]).toMatchObject({
      kind: "nodamage",
      text: "Elite Fire Wisp takes nothing.",
      detail: "immune to fire",
    });
  });

  it("tolerates a scene from before any of these fields existed", () => {
    expect(() => happenings(null, scene({}))).not.toThrow();
    expect(happenings(scene({}), scene({}))).toEqual([]);
    expect(happenings(null, null)).toEqual([]);
  });
});

describe("the drawn vocabulary", () => {
  it("keeps the six categories apart by what an item is, not by where it sits", () => {
    expect(itemCategory({ kind: "consumable" })).toBe("consumable");
    expect(itemCategory({ kind: "weapon" })).toBe("loot");
    expect(itemCategory(undefined)).toBe("loot");
  });

  /**
   * Read from the party's side: the same kind means opposite things depending
   * on who is carrying it, and every chip is tinted from this rather than from
   * the status name.
   */
  it("reads a status from the carrier's point of view", () => {
    expect(statusTone("shield")).toBe("boon");
    expect(statusTone("taunt")).toBe("boon");
    expect(statusTone("burn")).toBe("bane");
    expect(statusTone("something-new")).toBe("bane");
  });

  it("gives a status added to the simulation a name rather than a blank", () => {
    expect(statusShort("freeze")).toBe("FRZE");
    expect(statusShort("petrify")).toBe("PETR");
  });

  it("draws every equipment slot, and falls back rather than throwing", () => {
    expect(slotMark("weapon")).toBe("weapon");
    expect(slotMark("armor")).toBe("armor");
    expect(slotMark("trinket")).toBe("trinket");
    expect(slotMark("sideslot")).toBe("loot");
    expect(isMark("weapon")).toBe(true);
    expect(isMark("nothing-anybody-drew")).toBe(false);
    expect(markPath("nothing-anybody-drew")).toBe(markPath("nodamage"));
  });
});

/**
 * Every instrument the party can pick up has a sentence of its own.
 *
 * A tool missing from the phrase table still renders — deliberately, so a new
 * ability degrades to a dull line rather than a blank one — which is precisely
 * why nothing ever failed when four of them went missing at once. `pay_toll`,
 * `pick_lock`, `breach_route` and `disarm_trap`, the whole consequential-route
 * family, all drew as flat grey `tool — args` text at the visual weight of a
 * `look`. A two-hundred-gold toll gate is among the largest commitments a party
 * makes and it read as background chatter.
 *
 * So the fallback stays, and this walks the simulation's own tool list instead.
 */
describe("the feed's vocabulary against the simulation's", () => {
  it("has a sentence for every tool a character can call", async () => {
    const { createSimulation } = await import("../sim/index.js");
    const { isPhrased, stripeFor } = await import("../../viewer/broadcast/src/vocabulary.js");
    const sim = createSimulation("descent", {
      seed: 4242,
      startFloor: 1,
      preparation: true,
      maze: true,
    }) as unknown as {
      tools(): Record<string, Array<{ name: string }>>;
      sharedTools(): Array<{ name: string }>;
    };

    const names = [...new Set([...Object.values(sim.tools()).flat(), ...sim.sharedTools()].map((t) => t.name))];
    expect(names.length, "the descent should register a real roster of tools").toBeGreaterThan(20);

    // `look` is deliberately silent in the feed — five agents read the sheet
    // every round and nobody watching learns anything from it.
    const unphrased = names.filter((name) => name !== "look" && !isPhrased(name));
    expect(unphrased, `these tools render as generic noise: ${unphrased.join(", ")}`).toEqual([]);

    // A phrase without a stripe is only half-dressed: the row reads correctly
    // and still draws in the default "quiet" grey next to a `look`.
    const unstriped = names.filter((name) => name !== "look" && stripeFor(name) === "quiet");
    expect(unstriped, `these tools draw with no stripe of their own: ${unstriped.join(", ")}`).toEqual([]);
  });
});

/**
 * A kill is the most-watched thing in a fight and had no event of its own.
 *
 * `beatTallies` computed `died` and threw it away, so the only record of a kill
 * anywhere in the log was whatever the combat prose happened to say. In one live
 * run an elite died in round 15 and neither the log nor the commentary mentioned
 * it, because the prose that round did not.
 */
describe("something going down", () => {
  it("marks an enemy death, and carries the ref so the name can be filled in", () => {
    const before = scene({
      beatsTick: 1,
      enemies: [{ ref: "hound-1", name: "Ash Hound", elite: true }],
      beats: [],
    });
    const after = scene({
      beatsTick: 2,
      enemies: [],
      beats: [
        { kind: "hit", from: "guardian", to: "hound-1", amount: 40 },
        { kind: "death", to: "hound-1" },
      ],
    });

    const kills = happenings(before, after).filter((h) => h.kind === "kill");
    expect(kills).toHaveLength(1);
    // The ref, not the name: this module sees two scenes and the thing is gone
    // from both. The renderer's lexicon is what turns it into "Ash Hound".
    expect(kills[0].subject).toBe("hound-1");
    expect(kills[0].detail).toBe("elite");
  });

  it("does not mark a party member's fall as a kill", () => {
    const before = scene({ beatsTick: 1, party: [{ id: "mage", hp: 10 }], beats: [] });
    const after = scene({
      beatsTick: 2,
      party: [{ id: "mage", hp: 0, dead: true }],
      beats: [{ kind: "death", to: "mage" }],
    });
    // The party's own dead are drawn on the stage and counted in the HUD. A
    // "goes down" line in the enemy colour would read as a win.
    expect(happenings(before, after).filter((h) => h.kind === "kill")).toEqual([]);
  });

  it("reports one death once, across the five scenes a round publishes", () => {
    const before = scene({ beatsTick: 1, enemies: [{ ref: "husk-1", name: "Ash Husk" }], beats: [] });
    const after = scene({
      beatsTick: 2,
      enemies: [],
      beats: [{ kind: "death", to: "husk-1" }],
    });
    const first = happenings(before, after).filter((h) => h.kind === "kill");
    const again = happenings(after, after).filter((h) => h.kind === "kill");
    expect(first).toHaveLength(1);
    // Same tick, same key — the caller's `seen` set collapses the repeat.
    expect(again.every((h) => h.key === first[0].key || again.length === 0)).toBe(true);
  });
});
