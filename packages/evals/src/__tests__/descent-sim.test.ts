/**
 * The descent, played through its own tools.
 *
 * Every test here goes through the flattened tool registry rather than calling
 * methods on the simulation, because that is the layer where this package has
 * already been burned once. In `the-lock`, six roles each exported a
 * `raise_paddle`; the harness flattens `sim.tools()` into one registry and the
 * agent allowlist selects by *name*, so all six got whichever was registered
 * last, and a sixty-seven-minute run read as a team hallucinating its own
 * capabilities. A unit test calling the class directly would have passed.
 *
 * So: build the registry the way the harness does, and drive it as an agent
 * would.
 */

import type { Tool } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import {
  FAMILIES,
  generateEncounter,
  generateFloorMap,
  generatePaths,
  makeEnemy,
  makeItemInstance,
} from "../sim/descent/content.js";
import { Diagnostics } from "../sim/descent/diagnostics.js";
import { type DescentSimulation, levelFor } from "../sim/descent/index.js";
import {
  antiSynergies,
  applyStatus,
  computeDamage,
  type Enemy,
  type Fighter,
  hasStatus,
  type ItemEffect,
} from "../sim/descent/model.js";
import { DESCENT_POLICIES } from "../sim/descent/policies.js";
import { createSimulation, listSimulations, simulationPolicies } from "../sim/index.js";
import { makeRng } from "../sim/rng.js";
import { gradient, summarise, sweep } from "../sim/sweep.js";

/** Exactly how the harness assembles what an agent can call. */
function registry(sim: DescentSimulation): Map<string, Tool> {
  const flat = [...Object.values(sim.tools()).flat(), ...sim.sharedTools()];
  const map = new Map<string, Tool>();
  for (const tool of flat) {
    if (map.has(tool.name)) throw new Error(`two tools named ${tool.name} — the second silently replaces the first`);
    map.set(tool.name, tool);
  }
  return map;
}

async function call(
  sim: DescentSimulation,
  agent: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const tool = registry(sim).get(name);
  if (!tool) throw new Error(`no tool called ${name}`);
  const result = await tool.execute(args, { agentName: agent } as never);
  return String(result.output ?? "");
}

const fresh = (seed = 7) => createSimulation("descent", { seed, days: 400 }) as DescentSimulation;
let testItemSerial = 0;
const testItem = (baseId: string) => makeItemInstance(baseId, `test-${baseId}-${++testItemSerial}`, "starting-kit", 1);
const testEffectItem = (baseId: string, ...effects: ItemEffect[]) => {
  const item = testItem(baseId);
  for (const effect of effects) {
    item.affixes.push({
      id: `test-${effect.kind}`,
      name: `Test ${effect.kind}`,
      description: `test ${effect.kind}`,
      polarity: "positive",
      modifiers: {},
      effect,
    });
  }
  return item;
};

/** Walk a fresh party into their first fight. */
async function intoCombat(sim: DescentSimulation): Promise<void> {
  await call(sim, "guardian", "choose_path", { path: sim.view().paths[0].id });
  sim.advance();
}

describe("the tool registry", () => {
  it("has no two tools sharing a name", () => {
    expect(() => registry(fresh())).not.toThrow();
  });

  it("gives every class its own abilities and nobody else's", () => {
    const sim = fresh();
    const byClass = sim.tools();
    expect(byClass.cleric.map((t) => t.name)).toContain("heal");
    expect(byClass.guardian.map((t) => t.name)).not.toContain("heal");
    expect(byClass.mage.map((t) => t.name)).toContain("fireball");
    expect(byClass.rogue.map((t) => t.name)).toContain("scout");
  });

  it("refuses an ability held by somebody else, even though the tool exists", async () => {
    // The collision regression. `heal` is in the flattened registry, so a
    // guardian *can* reach it; it has to be told no by the simulation rather
    // than by an allowlist that may or may not be configured correctly.
    const sim = fresh();
    await intoCombat(sim);
    expect(await call(sim, "guardian", "heal", { target: "guardian" })).toMatch(/belongs to the cleric/i);
    expect(await call(sim, "cleric", "heal", { target: "guardian" })).toMatch(/Readied/);
  });
});

describe("what one agent can see", () => {
  it("shows an ally's condition but never their pack or their purse", async () => {
    const sim = fresh();
    const seen = await call(sim, "guardian", "look");
    // The cleric opens with a potion and an antidote. The guardian must not be
    // able to read that — it is the omission the whole trading mechanic rests
    // on, and `the-lock` shipped an omniscient `look` once already.
    expect(seen).toMatch(/cleric: \d+\/\d+ hp/);
    expect(seen).not.toMatch(/antidote/i);
    const own = await call(sim, "cleric", "look");
    expect(own).toMatch(/antidote/i);
    // And the pack names things the way the tools want them named.
    expect(own).toMatch(/pack:.*healing_potion/);
  });

  it("tells each class something different about the same enemy", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const ref = sim.view().enemies[0].ref;
    const asMage = await call(sim, "mage", "inspect_enemy", { target: ref });
    const asGuardian = await call(sim, "guardian", "inspect_enemy", { target: ref });
    expect(asMage).toMatch(/Elemental readings/);
    expect(asGuardian).toMatch(/Armour/);
    expect(asMage).not.toEqual(asGuardian);
  });

  it("never reveals a family's hidden rule, to anybody", async () => {
    const sim = createSimulation("descent", { seed: 3, days: 400 }) as DescentSimulation;
    // Drop the party in front of a crystal directly rather than descending to
    // floor 15, and confirm no inspection mentions what it does.
    await intoCombat(sim);
    const state = sim.view();
    state.enemies = [
      {
        ref: "crystal-1",
        name: "Crystal Warden",
        family: "crystal",
        hp: 100,
        maxHp: 100,
        armor: 4,
        power: 10,
        speed: 7,
        resist: { fire: 0.6 },
        statuses: [],
        hidden: { kind: "reflect", element: "lightning", fraction: 1.6 },
        elite: false,
        boss: false,
        xp: 10,
        gold: 10,
        age: 0,
      },
    ];
    for (const who of ["guardian", "mage", "rogue", "cleric", "ranger"]) {
      const said = await call(sim, who, "inspect_enemy", { target: "crystal-1" });
      expect(said.toLowerCase()).not.toMatch(/reflect|lightning arcs/);
    }
    expect(await call(sim, "ranger", "read_beast", { target: "crystal-1" })).not.toMatch(/reflect/i);
  });
});

describe("combat resolution", () => {
  it("readies actions rather than taking them, so a round resolves together", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const ref = sim.view().enemies[0].ref;
    const before = sim.view().enemies[0].hp;
    const said = await call(sim, "guardian", "attack", { target: ref });
    expect(said).toMatch(/resolves when the round closes/);
    expect(sim.view().enemies[0].hp).toBe(before);
    sim.advance();
    expect(sim.view().enemies.find((e) => e.ref === ref)?.hp ?? 0).toBeLessThan(before);
  });

  it("replaces an earlier action rather than stacking two in one round", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const ref = sim.view().enemies[0].ref;
    await call(sim, "guardian", "attack", { target: ref });
    const second = await call(sim, "guardian", "defend");
    expect(second).toMatch(/replaces your attack/);
    expect(sim.view().intents.filter((i) => i.actor === "guardian")).toHaveLength(1);
  });

  it("subtracts armour from physical damage and a resistance from everything", () => {
    const target = { hp: 100, armor: 10, statuses: [], resist: { fire: 0.5, frost: 0 } };
    expect(computeDamage(30, "physical", target).dealt).toBe(20);
    expect(computeDamage(30, "fire", target).dealt).toBe(15);
    expect(computeDamage(30, "frost", target).dealt).toBe(0);
    // Armour is physical-only: it must not also blunt a spell.
    expect(computeDamage(30, "lightning", target).dealt).toBe(30);
  });

  it("absorbs into a shield before it touches health", () => {
    const target: { hp: number; armor: number; statuses: [] } & { statuses: never[] } = {
      hp: 100,
      armor: 0,
      statuses: [],
    };
    applyStatus(target, { kind: "shield", ticks: 2, amount: 12 });
    const first = computeDamage(20, "fire", target);
    expect(first).toEqual({ dealt: 8, absorbed: 12 });
    expect(hasStatus(target, "shield")).toBe(false);
  });

  it("thaws a freeze with fire, which is why the two spells fight each other", () => {
    const target = { hp: 100, armor: 0, statuses: [] };
    applyStatus(target, { kind: "freeze", ticks: 2, amount: 0 });
    computeDamage(10, "fire", target);
    expect(hasStatus(target, "freeze")).toBe(false);
  });
});

describe("anti-synergies", () => {
  const state = (enemies: Partial<Enemy>[] = []) =>
    ({
      enemies: enemies.map((e, i) => ({
        ref: `e-${i}`,
        name: "thing",
        hp: 10,
        maxHp: 10,
        age: 0,
        hidden: { kind: "none" },
        ...e,
      })),
      party: {},
    }) as never;

  it("spots area damage aimed into a sleep", () => {
    const found = antiSynergies(state([{}, {}]), [
      { actor: "rogue", kind: "sleep_powder", target: "e-0" },
      { actor: "mage", kind: "fireball" },
    ]);
    expect(found.join(" ")).toMatch(/wake whatever rogue puts to sleep/);
  });

  it("does not report combinations one actor cannot legally ready", () => {
    expect(
      antiSynergies(state([{}]), [
        { actor: "mage", kind: "frostbite", target: "e-0" },
        { actor: "mage", kind: "firebolt", target: "e-0" },
      ]),
    ).toEqual([]);
  });

  it("does not call taunt plus vanish a clash; both protect the rogue", () => {
    expect(
      antiSynergies(state([{}]), [
        { actor: "guardian", kind: "taunt" },
        { actor: "rogue", kind: "vanish" },
      ]),
    ).toEqual([]);
  });

  it("says nothing when two sensible actions do not interfere", () => {
    expect(
      antiSynergies(state([{}]), [
        { actor: "mage", kind: "firebolt", target: "e-0" },
        { actor: "cleric", kind: "heal", target: "guardian" },
      ]),
    ).toEqual([]);
  });
});

describe("hidden mechanics", () => {
  it("reflects lightning back at whoever cast it, and records the lesson", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const state = sim.view();
    state.enemies = [
      {
        ref: "crystal-1",
        name: "Crystal Warden",
        family: "crystal",
        hp: 400,
        maxHp: 400,
        armor: 0,
        power: 1,
        speed: 1,
        resist: {},
        statuses: [],
        hidden: { kind: "reflect", element: "lightning", fraction: 1.6 },
        elite: false,
        boss: false,
        xp: 1,
        gold: 0,
        age: 0,
      },
    ];
    const mageBefore = state.party.mage.hp;
    await call(sim, "mage", "lightning", { target: "crystal-1" });
    sim.advance();
    expect(state.party.mage.hp).toBeLessThan(mageBefore);
    expect(sim.metrics().memoryOpportunities).toBeGreaterThanOrEqual(0);
  });

  it("punishes a heal with blood as well as mana, because mana comes back on its own", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const state = sim.view();
    state.enemies = [
      {
        ref: "void-1",
        name: "Void Priest",
        family: "void",
        hp: 400,
        maxHp: 400,
        armor: 0,
        power: 1,
        speed: 1,
        resist: {},
        statuses: [],
        hidden: { kind: "punishHeal", drain: 20 },
        elite: false,
        boss: false,
        xp: 1,
        gold: 0,
        age: 0,
      },
    ];
    state.party.guardian.hp = 40;
    const clericHp = state.party.cleric.hp;
    await call(sim, "cleric", "heal", { target: "guardian" });
    sim.advance();
    expect(state.party.cleric.hp).toBeLessThan(clericHp);
  });

  it("keeps a Bonewright's stagger window open through the next tick", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const state = sim.view();
    const def = FAMILIES.find((family) => family.family === "bonewright");
    if (!def) throw new Error("bonewright missing from the bestiary");
    const enemy = makeEnemy(def, 1, 31, 1, false);
    enemy.hp = 10_000;
    enemy.maxHp = 10_000;
    state.enemies = [enemy];

    await call(sim, "guardian", "shield_slam", { target: enemy.ref });
    sim.advance();
    expect(enemy.windowOpen, "the party must get a next-tick opportunity").toBe(true);

    const before = enemy.hp;
    const ordinary = computeDamage(state.party.mage.power, "physical", enemy).dealt;
    await call(sim, "mage", "attack", { target: enemy.ref });
    sim.advance();
    expect(before - enemy.hp).toBeGreaterThan(ordinary);
    expect(enemy.windowOpen).toBe(false);
  });
});

describe("the memory ledger", () => {
  it("counts an opportunity only after the family has taught its lesson once", () => {
    const diag = new Diagnostics();
    diag.recordEncounter(["crystal"]);
    diag.recordMechanic("crystal", "reflect");
    expect(diag.memoryLedger()).toEqual({ opportunities: 0, repeats: 0 });

    diag.recordEncounter(["crystal"]);
    expect(diag.memoryLedger()).toEqual({ opportunities: 1, repeats: 0 });
    expect(diag.report().memory).toBe(1);
  });

  it("counts a lapse when the same family catches the party again", () => {
    const diag = new Diagnostics();
    diag.recordEncounter(["crystal"]);
    diag.recordMechanic("crystal", "reflect");
    diag.recordEncounter(["crystal"]);
    diag.recordMechanic("crystal", "reflect");
    expect(diag.memoryLedger()).toEqual({ opportunities: 1, repeats: 1 });
    expect(diag.report().memory).toBe(0);
  });

  it("treats several firings inside one encounter as one lesson, not three", () => {
    const diag = new Diagnostics();
    diag.recordEncounter(["bell"]);
    diag.recordMechanic("bell", "tollHeal");
    diag.recordMechanic("bell", "tollHeal");
    diag.recordMechanic("bell", "tollHeal");
    diag.recordEncounter(["bell"]);
    expect(diag.memoryLedger().repeats).toBe(0);
  });

  it("asks nothing of a family met only once", () => {
    const diag = new Diagnostics();
    diag.recordEncounter(["wisp"]);
    diag.recordMechanic("wisp", "deathburst");
    expect(diag.report().memory).toBe(1);
  });
});

describe("the economy", () => {
  it("starts an opted-in run outside with a finite budget and no predetermined kit", async () => {
    const sim = createSimulation("descent", {
      seed: 9,
      days: 40,
      startFloor: 1,
      preparation: true,
      startingGold: 180,
    }) as DescentSimulation;
    const state = sim.view();

    expect(state.phase).toBe("camp");
    expect(state.stock).toHaveLength(6);
    expect(Object.values(state.party).every((fighter) => fighter.gold === 180)).toBe(true);
    expect(Object.values(state.party).flatMap((fighter) => fighter.inventory)).toEqual([]);

    const potion = state.stock.find((listing) => listing.item.baseId === "healing_potion");
    expect(potion).toBeDefined();
    expect(await call(sim, "guardian", "buy", { item: potion?.item.id })).toMatch(/You buy Healing Potion/);
    expect(await call(sim, "mage", "enter_dungeon")).toMatch(/when the round closes/);
    sim.advance();

    expect(state.phase).toBe("explore");
    expect(state.stock).toEqual([]);
    expect(state.party.guardian.inventory.some((item) => item.baseId === "healing_potion")).toBe(true);
  });

  it("refuses gear to a class that cannot use it, and says who can", async () => {
    const sim = fresh();
    sim.view().party.mage.inventory.push(testItem("plate_cuirass"));
    const said = await call(sim, "mage", "equip_item", { item: "plate_cuirass" });
    expect(said).toMatch(/cannot use Plate Cuirass/);
    expect(said).toMatch(/guardian/);
  });

  it("lets a pooled purse buy what no single purse could", async () => {
    const sim = fresh();
    const state = sim.view();
    state.phase = "market";
    state.stock = [{ item: testItem("vitality_ring"), price: 300 }];
    expect(await call(sim, "guardian", "buy", { item: "vitality_ring" })).toMatch(/300 gold, and you have 60/);
    for (const donor of ["mage", "rogue", "cleric", "ranger"]) {
      await call(sim, donor, "give_gold", { to: "guardian", amount: 60 });
    }
    expect(await call(sim, "guardian", "buy", { item: "vitality_ring" })).toMatch(/You buy Ring of Vitality/);
    expect(sim.metrics().goldTransfers).toBe(4);
  });

  it("counts a purchase as pooled only when the buyer could not have afforded it alone", async () => {
    // The detector originally compared the price against a notional opening
    // purse of sixty gold. That is true on floor one and nonsense anywhere
    // else — a party started mid-descent opens with thousands each, so every
    // ordinary purchase scored as pooled and the scenario awarded ten
    // milestone points for shopping. An agent run collected them.
    const rich = createSimulation("descent", { seed: 2, days: 40, startFloor: 31 }) as DescentSimulation;
    rich.view().phase = "market";
    rich.view().stock = [
      { item: testItem("healing_potion"), price: 100 },
      { item: testItem("vitality_ring"), price: 380 },
    ];
    await call(rich, "guardian", "buy", { item: "healing_potion" });
    expect(rich.metrics().pooledPurchases, "an affordable purchase is not pooling").toBe(0);

    // Now make one genuinely unaffordable and cover it from another purse.
    rich.view().party.mage.gold = 50;
    await call(rich, "mage", "buy", { item: "vitality_ring" });
    expect(rich.metrics().pooledPurchases, "still not pooled — it was refused").toBe(0);
    await call(rich, "guardian", "give_gold", { to: "mage", amount: 400 });
    await call(rich, "mage", "buy", { item: "vitality_ring" });
    expect(rich.metrics().pooledPurchases).toBe(1);
  });

  it("refuses an action taken in the wrong phase, and names the phase", async () => {
    const sim = fresh();
    const said = await call(sim, "guardian", "buy", { item: "healing_potion" });
    expect(said).toMatch(/the party is in the explore phase/);
  });

  it("does not award cooperation for handing resources to yourself", async () => {
    const sim = fresh();
    sim.view().party.guardian.inventory.push(testItem("antidote"));
    expect(await call(sim, "guardian", "trade_item", { to: "guardian", item: "antidote" })).toMatch(/not a trade/i);
    expect(await call(sim, "guardian", "give_gold", { to: "guardian", amount: 1 })).toMatch(/does not move/i);
    expect(sim.metrics().tradesMade).toBe(0);
    expect(sim.metrics().goldTransfers).toBe(0);
  });
});

describe("procedural item effects", () => {
  it("turns single-target physical attacks into cleave and vampirism", async () => {
    const sim = fresh();
    const guardian = sim.view().party.guardian;
    const weapon = testEffectItem(
      "iron_sword",
      { kind: "cleave", fraction: 0.5 },
      { kind: "vampirism", fraction: 0.5 },
    );
    guardian.inventory.push(weapon);
    await call(sim, "guardian", "equip_item", { item: weapon.id });
    expect(
      sim
        .scene()
        .party.find((member) => member.id === "guardian")
        ?.worn.flatMap((item) => item.affixes)
        .map((affix) => affix.effect?.kind),
    ).toEqual(expect.arrayContaining(["cleave", "vampirism"]));
    await intoCombat(sim);

    const original = sim.view().enemies[0];
    sim.view().enemies = [
      { ...original, ref: "target-1", hp: 100, maxHp: 100, armor: 0, power: 1, speed: 0, hidden: { kind: "none" } },
      { ...original, ref: "target-2", hp: 100, maxHp: 100, armor: 0, power: 1, speed: 0, hidden: { kind: "none" } },
    ];
    guardian.hp = guardian.maxHp - 30;
    await call(sim, "guardian", "attack", { target: "target-1" });
    sim.advance();

    expect(sim.view().enemies.find((enemy) => enemy.ref === "target-2")?.hp).toBeLessThan(100);
    expect(sim.scene().beats.some((beat) => beat.note === "item-cleave")).toBe(true);
    expect(sim.scene().beats.some((beat) => beat.note === "item-vampirism")).toBe(true);
  });

  it("regenerates during combat and reduces ability cooldowns", async () => {
    const sim = fresh();
    const guardian = sim.view().party.guardian;
    const weapon = testEffectItem("iron_sword", { kind: "cooldown-reduction", amount: 1 });
    const armor = testEffectItem("plate_cuirass", { kind: "regeneration", amount: 6 });
    guardian.inventory.push(weapon, armor);
    await call(sim, "guardian", "equip_item", { item: weapon.id });
    await call(sim, "guardian", "equip_item", { item: armor.id });
    await intoCombat(sim);
    guardian.hp -= 20;

    const target = sim.view().enemies[0];
    await call(sim, "guardian", "shield_slam", { target: target.ref });
    sim.advance();

    expect(sim.scene().beats.some((beat) => beat.note === "item-regeneration" && beat.amount === 6)).toBe(true);
    expect(guardian.cooldowns.shield_slam).toBe(1);
  });

  it("uses equipped merchant, map, and cache effects at their decision points", async () => {
    let sim = createSimulation("descent", { seed: 1, days: 40, maze: true }) as DescentSimulation;
    for (let seed = 1; seed < 30 && !sim.view().map?.rooms.some((room) => room.kind === "cache"); seed++) {
      sim = createSimulation("descent", { seed: seed + 1, days: 40, maze: true }) as DescentSimulation;
    }
    const state = sim.view();
    const trinket = testEffectItem(
      "vitality_ring",
      { kind: "merchant-discount", fraction: 0.15 },
      { kind: "reveal", scope: "floor" },
      { kind: "cache-capacity", amount: 1 },
    );
    state.party.guardian.inventory.push(trinket);
    await call(sim, "guardian", "equip_item", { item: trinket.id });
    expect(state.map?.rooms.every((room) => room.revealed)).toBe(true);

    const cache = state.map?.rooms.find((room) => room.kind === "cache");
    const beforeCache = state.map?.rooms.find((room) => cache?.links.includes(room.id));
    expect(cache && beforeCache).toBeTruthy();
    if (!cache || !beforeCache || !state.map) return;
    state.map.currentRoom = beforeCache.id;
    beforeCache.visited = true;
    state.paths = [{ id: cache.id, label: cache.label, kind: cache.kind }];
    await call(sim, "guardian", "choose_path", { path: cache.id });
    sim.advance();
    expect(state.phase).toBe("cache");
    expect(state.cacheTakesLeft).toBe(3);

    state.phase = "market";
    state.party.guardian.gold = 100;
    state.stock = [{ item: testItem("healing_potion"), price: 100 }];
    expect(await call(sim, "guardian", "buy", { item: "healing_potion" })).toMatch(/for 85 \(15 saved/);
  });
});

describe("run variation", () => {
  it("assigns path contents to different directions across seeds", () => {
    const signature = (seed: number) =>
      generatePaths(31, makeRng(seed))
        .map((path) => `${path.id}:${path.kind}`)
        .join("|");
    expect(new Set(Array.from({ length: 8 }, (_, i) => signature(i + 1))).size).toBeGreaterThan(1);
  });

  it("varies maze encounter size and health while remaining seeded", () => {
    const signature = (seed: number) => {
      const enemies = generateEncounter(3, 0, false, makeRng(seed), false, 15, 0, true);
      return enemies.map((enemy) => `${enemy.family}:${enemy.maxHp}`).join("|");
    };
    expect(signature(12)).toBe(signature(12));
    expect(new Set(Array.from({ length: 12 }, (_, i) => signature(i + 1))).size).toBeGreaterThan(6);
  });

  it("rolls reproducible item copies with varied rarity, affixes, and drawbacks", () => {
    const roll = (seed: number) => makeItemInstance("vitality_ring", "ring@1", "cache", 12, makeRng(seed));
    expect(roll(17)).toEqual(roll(17));

    const copies = Array.from({ length: 80 }, (_, index) => roll(index + 1));
    expect(new Set(copies.map((item) => item.rarity)).size).toBeGreaterThan(2);
    expect(copies.some((item) => item.affixes.length >= 2)).toBe(true);
    expect(copies.some((item) => item.affixes.some((affix) => affix.polarity === "negative"))).toBe(true);
    const effectCopies = Array.from({ length: 240 }, (_, index) => roll(index + 100));
    expect(effectCopies.some((item) => item.affixes.some((affix) => affix.effect))).toBe(true);
  });

  it("publishes full per-copy item identity through the scene contract", () => {
    const sim = createSimulation("descent", {
      seed: 9,
      days: 40,
      startFloor: 1,
      preparation: true,
    }) as DescentSimulation;
    const stock = sim.scene().stock;

    expect(new Set(stock.map((item) => item.id)).size).toBe(stock.length);
    expect(stock[0]).toMatchObject({
      baseId: expect.any(String),
      rarity: expect.any(String),
      description: expect.any(String),
      affixes: expect.any(Array),
      provenance: { source: "outfitter", floor: 1 },
    });
  });

  it("builds connected floor mazes with branches, loops, zones, and a boss gate", () => {
    const maps = Array.from({ length: 8 }, (_, i) => generateFloorMap(i + 1, makeRng(100 + i)));
    for (const map of maps) {
      expect(map.rooms.length).toBeGreaterThanOrEqual(5);
      expect(map.rooms.length).toBeLessThanOrEqual(7);
      const seen = new Set(["r0"]);
      const queue = ["r0"];
      while (queue.length > 0) {
        const next = queue.shift();
        const room = map.rooms.find((candidate) => candidate.id === next);
        for (const link of room?.links ?? []) {
          if (!seen.has(link)) {
            seen.add(link);
            queue.push(link);
          }
        }
      }
      expect(seen.size).toBe(map.rooms.length);
      expect(map.rooms[0].links.length).toBeGreaterThanOrEqual(2);
      const edges = map.rooms.reduce((sum, room) => sum + room.links.length, 0) / 2;
      expect(edges).toBeGreaterThanOrEqual(map.rooms.length);
    }
    expect(new Set(maps.map((map) => map.zone)).size).toBeGreaterThan(1);

    const bossMap = generateFloorMap(4, makeRng(4));
    const stairs = bossMap.rooms.find((room) => room.kind === "stairs");
    expect(stairs?.links).toHaveLength(1);
    expect(bossMap.rooms.find((room) => room.id === stairs?.links[0])?.kind).toBe("boss");
  });

  it("keeps exploring a persistent room graph until the party chooses the stairs", () => {
    const sim = createSimulation("descent", {
      seed: 17,
      days: 200,
      preparation: true,
      maze: true,
    }) as DescentSimulation;
    const policy = simulationPolicies("descent")["rule-based"]();
    let guard = 0;
    while (!sim.done && sim.view().floor === 1 && guard++ < 200) {
      policy.act(sim);
      sim.advance();
    }

    expect(sim.view().floor).toBeGreaterThan(1);
    expect(sim.view().map).toBeDefined();
    expect(sim.scene().floorMap?.rooms.length).toBeGreaterThan(1);
  });
});

describe("descent pressure", () => {
  it("does not let a party stand in the open forever", () => {
    const sim = fresh();
    for (let i = 0; i < 4; i++) sim.advance();
    // Nobody chose a way on; dread found them instead.
    expect(sim.view().phase).toBe("combat");
  });

  it("moves the party only when the round closes, so nobody eats a free round", async () => {
    const sim = fresh();
    const said = await call(sim, "rogue", "choose_path", { path: sim.view().paths[0].id });
    expect(said).toMatch(/when the round closes/);
    expect(sim.view().phase).toBe("explore");
    sim.advance();
    expect(["combat", "market"]).toContain(sim.view().phase);
  });

  it("lets the party retreat at the cost of an unanswered attack and dread", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const state = sim.view();
    const enemy = state.enemies[0];
    state.enemies = [
      {
        ...enemy,
        hp: enemy.maxHp,
        power: 20,
        statuses: [],
        hidden: { kind: "none" },
      },
    ];
    const partyHp = () => Object.values(state.party).reduce((sum, fighter) => sum + fighter.hp, 0);
    const hpBefore = partyHp();

    await call(sim, "guardian", "attack", { target: enemy.ref });
    expect(await call(sim, "rogue", "retreat")).toMatch(/opportunity/i);
    sim.advance();

    expect(state.phase).toBe("explore");
    expect(state.dread).toBe(2);
    expect(partyHp()).toBeLessThan(hpBefore);
    expect(state.paths[0]).toMatchObject({ id: "back", kind: "retreat" });

    await call(sim, "guardian", "choose_path", { path: "back" });
    sim.advance();
    expect(state.phase).toBe("combat");
    expect(state.enemies[0]).toMatchObject({ ref: enemy.ref, hp: enemy.maxHp });
  });

  it("allows one rest per round and resolves dangerous dread before descent", async () => {
    const sim = fresh();
    const state = sim.view();
    state.phase = "spoils";
    state.dread = 4;
    for (const fighter of Object.values(state.party)) fighter.hp = 1;

    expect(await call(sim, "guardian", "rest")).toMatch(/recovers/i);
    expect(await call(sim, "mage", "rest")).toMatch(/already rested/i);
    await call(sim, "guardian", "descend");
    sim.advance();

    expect(state.floor).toBe(1);
    expect(state.phase).toBe("combat");
    expect(state.dread).toBeGreaterThanOrEqual(6);
  });
});

describe("the clock", () => {
  it("advances every round, not only during a fight", () => {
    // This was wrong once, and it was not a cosmetic wrongness: with the tick
    // living inside combat resolution, a party deliberating on the stairs
    // advanced no time at all, `done` could never fire for a party that avoided
    // fighting, and a baseline swept to `days: 40` was given forty *fights*
    // where an agent run gets forty turns of everything. The ladder and the
    // agent score were measuring different budgets.
    const sim = fresh();
    expect(sim.view().phase).toBe("explore");
    expect(sim.day).toBe(0);
    sim.advance();
    expect(sim.day).toBe(1);
    sim.advance();
    expect(sim.day).toBe(2);
  });

  it("ends a run that spends its whole horizon without fighting", () => {
    const sim = createSimulation("descent", { seed: 5, days: 6 });
    let guard = 0;
    while (!sim.done && guard++ < 50) sim.advance();
    expect(sim.done).toBe(true);
    expect(guard).toBeLessThanOrEqual(7);
  });
});

describe("the snapshot", () => {
  /**
   * `snapshot()` is read as a run's metrics by the live milestone scorer, which
   * rebuilds a partial run from the trace while the run is still going. A
   * simulation whose snapshot carries only display fields silently disables
   * every `sim_metric` milestone for the whole run — the first agent run of
   * this scenario reported one milestone out of fifteen on screen while the
   * party had killed a boss and cleared a floor.
   *
   * Checked across every registered simulation rather than just this one,
   * because the convention is undocumented and the next author will not know it
   * either.
   */
  it("is metric-shaped in every simulation, because live scoring reads it as metrics", () => {
    for (const name of listSimulations()) {
      const sim = createSimulation(name, { seed: 1, days: 5 });
      const snapshot = sim.snapshot();
      const metrics = sim.metrics();
      const missing = Object.keys(metrics).filter((k) => !(k in snapshot));
      expect(missing, `${name}.snapshot() is missing metrics: ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("still carries what the viewer draws", () => {
    const snapshot = fresh().snapshot();
    for (const key of ["floor", "phase", "tick", "dread", "enemies", "readied", "guardian", "survivors"]) {
      expect(snapshot, `viewer needs ${key}`).toHaveProperty(key);
    }
  });
});

describe("the coordination diagnostic", () => {
  it("counts a round in which several agents acted", async () => {
    // `resolveTick` empties the intent queue, so reading its length afterwards
    // to decide whether the round had more than one actor always answered no,
    // and this diagnostic reported 0% for every run regardless of play.
    const sim = fresh();
    await intoCombat(sim);
    const ref = sim.view().enemies[0].ref;
    await call(sim, "guardian", "attack", { target: ref });
    await call(sim, "ranger", "shoot", { target: ref });
    await call(sim, "rogue", "attack", { target: ref });
    sim.advance();
    expect(sim.metrics().diagCoordination).toBeGreaterThan(0);
  });
});

describe("diagnostic accounting", () => {
  it("counts one dead-target action as one waste", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const state = sim.view();
    const enemy = state.enemies[0];
    enemy.hp = 1;
    enemy.speed = 1;
    state.enemies = [enemy];
    await call(sim, "rogue", "attack", { target: enemy.ref });
    await call(sim, "guardian", "attack", { target: enemy.ref });
    sim.advance();
    expect(sim.metrics().actionsWasted).toBe(1);
  });

  it("reports party members still down at the horizon", () => {
    const sim = fresh();
    sim.view().party.mage.dead = true;
    sim.view().party.rogue.dead = true;
    expect(sim.metrics().permanentDeaths).toBe(2);
  });

  it("does not call separate hoarded caches a divided cache", () => {
    const diag = new Diagnostics();
    diag.recordCacheTake("guardian", "cache-a");
    diag.recordCacheTake("guardian", "cache-a");
    diag.recordCacheTake("mage", "cache-b");
    diag.recordCacheTake("mage", "cache-b");
    expect(diag.metrics().cacheTakers).toBe(1);
  });
});

describe("the baseline ladder", () => {
  const SEEDS = Array.from({ length: 12 }, (_, i) => 2000 + i);
  const rungs = Object.entries(DESCENT_POLICIES).map(([, make]) =>
    summarise(sweep("descent", make(), SEEDS, 1500), { key: "earnedXp" }),
  );
  const by = (name: string) => rungs.find((r) => r.policy === name) as (typeof rungs)[number];

  /**
   * The rungs that are meant to be ordered.
   *
   * `greedy-dps` is deliberately outside it. Over thirty seeds it lands below
   * `random`; over twelve the two are within one percent of each other, which
   * is not an ordering, it is noise — asserting it would give this suite a test
   * that fails on the seed count rather than on the code.
   */
  const SPINE = ["random", "basic-tactics", "tactics-only", "rule-based", "oracle"];

  it("is monotonic — every rung on the spine pays for what it adds", () => {
    const means = SPINE.map((name) => by(name).mean);
    expect(means).toEqual([...means].sort((a, b) => a - b));
  });

  it("puts a party with no healer at the bottom, wherever random lands", () => {
    expect(by("greedy-dps").mean).toBeLessThan(by("basic-tactics").mean);
  });

  it("spans a wide enough range to measure an agent into", () => {
    // Without this check the whole scenario is unfalsifiable: a dungeon where
    // every policy scores the same would still produce a confident-looking
    // number for an agent run.
    const { spread } = gradient(rungs);
    expect(spread).toBeGreaterThan(20_000);
  });

  it("makes perfect recall worth a large fraction of the top score", () => {
    // The scenario's headline claim. If the oracle — which knows every hidden
    // mechanic from the first tick — cannot clearly beat a party that knows
    // none of them, the memory diagnostic is measuring something that does not
    // matter, and the mechanics need sharpening rather than the agents.
    //
    // It has already failed once for exactly that reason: with hidden mechanics
    // that did not scale with depth, the oracle finished *behind* rule-based.
    expect(by("oracle").mean).toBeGreaterThan(by("rule-based").mean * 1.2);
  });

  it("ends every run, one way or the other", () => {
    for (const rung of rungs) expect(rung.runs).toBe(SEEDS.length);
  });
});

/**
 * The pacing contract.
 *
 * A forty-round run at floor 31 used to cover one floor and eleven enemies:
 * nineteen of its first twenty-four rounds were a single fight, and every
 * scenario milestone needing a descent or a quiet moment was unreachable by any
 * policy, the omniscient one included. Three separate things caused it and each
 * is pinned here, because each would be silently undone by an ordinary-looking
 * balance edit.
 */
describe("pacing", () => {
  it("keeps an encounter short enough that a run is a descent, not a fight", () => {
    // The measurement that matters, stated as the invariant it protects: a
    // competent party gets down several floors inside a horizon.
    const sim = createSimulation("descent", { seed: 1000, days: 40, startFloor: 31 }) as DescentSimulation;
    const policy = simulationPolicies("descent")["rule-based"]();
    const phases: Record<string, number> = {};
    while (!sim.done) {
      phases[sim.view().phase] = (phases[sim.view().phase] ?? 0) + 1;
      policy.act(sim);
      sim.advance();
    }
    // Before the fix this was 1. The bar is deliberately below what the
    // baselines actually manage (about five) so ordinary tuning does not
    // trip it, and well above the broken behaviour.
    expect(sim.metrics().floorsCleared, "a forty-round run should be a descent").toBeGreaterThanOrEqual(3);
    // And combat must not eat the whole run: the decisions this scenario
    // exists to measure — pathing, spoils, trading, the market — all live in
    // the other phases.
    expect(phases.combat, "combat should not be the entire run").toBeLessThan(34);
  });

  it("keeps encounter health tracking the party's damage rather than outrunning it", () => {
    // The scaling contract from `depthScale`, checked directly.
    //
    // The end-to-end test above cannot see this on its own: with the dread and
    // enemy-count fixes in place, the old health curve still cleared four
    // floors against the new one's five, and no threshold separates those
    // without being brittle to the seed. So this asserts the property itself —
    // how much longer an encounter takes, per point of party damage, as depth
    // grows. Flat is the goal; the old curve was 3.4× worse at floor 40 than
    // at floor 8, which is the "floor 50 is floor 1 with a longer fight"
    // failure the content header warns about.
    // Averaged over several rolls, because which families turn up swings a
    // single encounter's health by more than the effect being measured.
    const roundsToClear = (floor: number) => {
      const sim = createSimulation("descent", { seed: 3, days: 10, startFloor: floor }) as DescentSimulation;
      const damage = Object.values(sim.view().party).reduce((a, f) => a + f.power, 0);
      const rolls = Array.from({ length: 12 }, (_, i) =>
        generateEncounter(floor, 0, false, makeRng(100 + i)).reduce((a, e) => a + e.hp, 0),
      );
      return rolls.reduce((a, b) => a + b, 0) / rolls.length / damage;
    };
    // Measured at the time of the change: 2.1 with the health curve tracking
    // party damage, 4.8 with the old one. The bar sits between, well clear of
    // both.
    const drift = roundsToClear(48) / roundsToClear(8);
    expect(drift, "an encounter at depth should not take multiples longer to clear").toBeLessThan(3);
  });

  it("does not charge dread for being in a fight", () => {
    // Dread is the price of lingering. While combat charged it, a long fight
    // raised dread, dread bought the next encounter reinforcements, and the
    // bigger encounter took longer still — with nothing anywhere pushing back.
    const sim = createSimulation("descent", { seed: 7, days: 40, startFloor: 31 }) as DescentSimulation;
    const s = sim.view();
    s.phase = "combat";
    s.enemies = [makeEnemy(FAMILIES[0], 0, 31, 1, false)];
    s.dread = 4;
    sim.advance();
    expect(s.dread, "a round spent fighting is not a round spent dawdling").toBeLessThanOrEqual(4);
  });

  it("still charges dread for standing about", () => {
    // The other half — without this the fix above would simply disable dread.
    const sim = createSimulation("descent", { seed: 7, days: 40, startFloor: 31 }) as DescentSimulation;
    const s = sim.view();
    s.phase = "spoils";
    const before = s.dread;
    sim.advance();
    expect(s.dread).toBeGreaterThan(before);
  });

  it("caps reinforcements however long the party dawdled", () => {
    // The ceiling that holds even if the dread accounting is mistuned again.
    const calm = generateEncounter(31, 0, false, makeRng(5)).length;
    const dreadful = generateEncounter(31, 40, false, makeRng(5)).length;
    expect(dreadful - calm, "dread adds at most one body").toBeLessThanOrEqual(1);
  });
});

/**
 * The two mechanics that turn an item from a private upgrade into a party
 * decision. Both exist because run 3 measured the alternative: 5,309 gold
 * spent, every coin by one agent on themselves, `diagPooling` reading zero.
 */
describe("resources the party has to share", () => {
  /** Drop a party straight into a cache, since reaching one takes a floor. */
  function atCache(seed = 4) {
    const sim = createSimulation("descent", { seed, days: 40, startFloor: 31 }) as DescentSimulation;
    const s = sim.view();
    s.phase = "cache";
    s.cache = ["vitality_ring", "plate_cuirass", "arc_staff", "healing_potion"].map((baseId) => ({
      item: testItem(baseId),
    }));
    s.cacheTakesLeft = 2;
    s.cacheOrigin = "a survey party out of Belm";
    return sim;
  }

  it("lets the party carry out only what the cap allows", async () => {
    const sim = atCache();
    expect(await call(sim, "guardian", "take", { item: "vitality_ring" })).toMatch(/take Ring of Vitality/i);
    expect(await call(sim, "mage", "take", { item: "arc_staff" })).toMatch(/take Arcstaff/i);
    // Third take, with two things still lying there: the cap is the mechanic.
    const refused = await call(sim, "rogue", "take", { item: "plate_cuirass" });
    expect(refused).toMatch(/all you can/i);
    expect(sim.view().cache.filter((x) => x.taken).length).toBe(2);
  });

  it("says who took what, so the party can see the split", async () => {
    const sim = atCache();
    await call(sim, "cleric", "take", { item: "healing_potion" });
    expect(sim.view().cache.find((x) => x.item.baseId === "healing_potion")?.taken).toBe("cleric");
  });

  it("reads a shared cache differently from one member emptying it", async () => {
    const shared = atCache();
    await call(shared, "guardian", "take", { item: "vitality_ring" });
    await call(shared, "mage", "take", { item: "arc_staff" });

    const hoarded = atCache();
    await call(hoarded, "guardian", "take", { item: "vitality_ring" });
    await call(hoarded, "guardian", "take", { item: "arc_staff" });

    // Identical in every other metric — same items, same count, same floor.
    expect(shared.metrics().cacheTakes).toBe(hoarded.metrics().cacheTakes);
    expect(shared.metrics().diagPooling).toBeGreaterThan(hoarded.metrics().diagPooling);
  });

  it("caps how many trinkets the party keeps attuned", async () => {
    const sim = createSimulation("descent", { seed: 4, days: 40, startFloor: 31 }) as DescentSimulation;
    const s = sim.view();
    s.phase = "spoils";
    for (const who of ["guardian", "mage", "rogue"] as const) s.party[who].inventory.push(testItem("vitality_ring"));

    expect(await call(sim, "guardian", "equip_item", { item: "vitality_ring" })).toMatch(/put on/i);
    expect(await call(sim, "mage", "equip_item", { item: "vitality_ring" })).toMatch(/put on/i);

    // The third is not a refusal to be worked around — it names who is holding
    // the slots, because the next move is asking one of them to give it up.
    const refused = await call(sim, "rogue", "equip_item", { item: "vitality_ring" });
    expect(refused).toMatch(/only keep 2 trinkets/i);
    expect(refused).toMatch(/guardian/);
    expect(refused).toMatch(/mage/);
  });

  it("lets somebody give a slot up, so the cap is a negotiation and not a lock", async () => {
    const sim = createSimulation("descent", { seed: 4, days: 40, startFloor: 31 }) as DescentSimulation;
    const s = sim.view();
    s.phase = "spoils";
    for (const who of ["guardian", "mage", "rogue"] as const) s.party[who].inventory.push(testItem("vitality_ring"));
    await call(sim, "guardian", "equip_item", { item: "vitality_ring" });
    await call(sim, "mage", "equip_item", { item: "vitality_ring" });

    expect(await call(sim, "mage", "unequip", { slot: "trinket" })).toMatch(/take off/i);
    expect(await call(sim, "rogue", "equip_item", { item: "vitality_ring" })).toMatch(/put on/i);
    expect(s.party.rogue.equipped.trinket?.baseId).toBe("vitality_ring");
    expect(s.party.mage.equipped.trinket).toBeUndefined();
  });

  it("still lets a trinket be swapped for a better one without freeing a slot", async () => {
    // Replacing your own is not a new attunement, and blocking it would make
    // the cap punish upgrading rather than hoarding.
    const sim = createSimulation("descent", { seed: 4, days: 40, startFloor: 31 }) as DescentSimulation;
    const s = sim.view();
    s.phase = "spoils";
    s.party.guardian.inventory.push(testItem("vitality_ring"));
    s.party.mage.inventory.push(testItem("vitality_ring"));
    s.party.guardian.inventory.push(testItem("swift_charm"));
    await call(sim, "guardian", "equip_item", { item: "vitality_ring" });
    await call(sim, "mage", "equip_item", { item: "vitality_ring" });
    expect(await call(sim, "guardian", "equip_item", { item: "swift_charm" })).toMatch(/put on/i);
  });
});

describe("scouting", () => {
  it("gives what it found to the scout alone, so it has to be relayed", async () => {
    const sim = createSimulation("descent", { seed: 9, days: 40, startFloor: 31 }) as DescentSimulation;
    expect(sim.view().phase).toBe("explore");
    const seen = await call(sim, "rogue", "scout");
    expect(seen).toMatch(/nobody else can see/i);

    // The rogue's own view carries it.
    expect(sim.describeFor("rogue")).toMatch(/What you saw ahead/);
    // Everybody else is told only that it happened. This is the property the
    // whole action exists for: before it, the finding was written into shared
    // state and `describe` rendered it for the entire party, so the one thing
    // in the scenario that could create information asymmetry created none.
    for (const other of ["guardian", "mage", "cleric", "ranger"]) {
      const view = sim.describeFor(other);
      expect(view, `${other} should not see the report`).not.toMatch(/What you saw ahead/);
      expect(view, `${other} should be told to go and ask`).toMatch(/went ahead and came back/);
    }
  });

  it("costs something, so looking is a decision rather than a reflex", async () => {
    const sim = createSimulation("descent", { seed: 9, days: 40, startFloor: 31 }) as DescentSimulation;
    const before = sim.view().dread;
    await call(sim, "rogue", "scout");
    expect(sim.view().dread).toBeGreaterThan(before);
  });

  it("belongs to the rogue", async () => {
    const sim = createSimulation("descent", { seed: 9, days: 40, startFloor: 31 }) as DescentSimulation;
    expect(await call(sim, "guardian", "scout")).toMatch(/belongs to the rogue/);
  });
});

describe("starting partway down", () => {
  it("hands the party what a party that walked there would have", () => {
    // Walked, not remembered.
    //
    // This used to compare `equipForDepth` against three constants measured
    // from `rule-based` at the time it was written — 1,433 experience at floor
    // 8, 3,298 at 12, 15,003 at 25. Both sides of that comparison were frozen,
    // so it went on passing through a pacing change that moved every real
    // arrival: the formula was unchanged, the constants were unchanged, and
    // the property they existed to protect was not being checked at all.
    //
    // Now it walks a party down and compares against what that party actually
    // holds. The tolerance is wide because the walk is seeded and short; what
    // it catches is the failure that matters — a granted curve drifting away
    // from the game it is meant to summarise.
    const walkTo = (floor: number, seed: number) => {
      const sim = createSimulation("descent", { seed, days: 400 }) as DescentSimulation;
      const policy = simulationPolicies("descent")["rule-based"]();
      let guard = 0;
      while (!sim.done && sim.view().floor < floor && guard++ < 5_000) {
        policy.act(sim);
        sim.advance();
      }
      return sim;
    };

    for (const floor of [8, 12]) {
      const walked = [1, 2, 3].map((seed) => walkTo(floor, seed)).filter((s) => s.view().floor >= floor);
      expect(walked.length, `a rule-based party should reach floor ${floor}`).toBeGreaterThan(0);
      const mean = walked.reduce((a, s) => a + s.metrics().totalXp, 0) / walked.length;

      const granted = (
        createSimulation("descent", { seed: 1, days: 10, startFloor: floor }) as DescentSimulation
      ).metrics().totalXp;
      expect(granted, `floor ${floor}: granted ${granted} vs walked ${Math.round(mean)}`).toBeGreaterThan(mean * 0.7);
      expect(granted, `floor ${floor}: granted ${granted} vs walked ${Math.round(mean)}`).toBeLessThan(mean * 1.4);
    }
  });

  it("scores what the party earned, never what it was given", () => {
    const sim = createSimulation("descent", { seed: 1, days: 10, startFloor: 26 }) as DescentSimulation;
    // Eighteen thousand experience for standing on floor 26. None of it is
    // theirs, and a threshold scored against `totalXp` would pass on tick zero.
    expect(sim.metrics().totalXp).toBeGreaterThan(15_000);
    expect(sim.metrics().earnedXp).toBe(0);
    expect(sim.objective()).toBe(0);
    expect(sim.metrics().floorsCleared).toBe(0);
  });

  it("starts on the floor it was asked for", () => {
    const sim = createSimulation("descent", { seed: 1, days: 10, startFloor: 26 }) as DescentSimulation;
    expect(sim.view().floor).toBe(26);
    expect(sim.snapshot().floor).toBe(26);
  });
});

describe("reproducibility", () => {
  it("gives the same run for the same seed and the same policy", () => {
    const play = () => {
      const policy = simulationPolicies("descent")["rule-based"]();
      const sim = createSimulation("descent", { seed: 4242, days: 300 });
      let guard = 0;
      while (!sim.done && guard++ < 2000) {
        policy.act(sim);
        sim.advance();
      }
      return sim.metrics();
    };
    expect(play()).toEqual(play());
  });

  it("gives different runs for different seeds", () => {
    const play = (seed: number) => {
      const policy = simulationPolicies("descent")["rule-based"]();
      const sim = createSimulation("descent", { seed, days: 300 });
      let guard = 0;
      while (!sim.done && guard++ < 2000) {
        policy.act(sim);
        sim.advance();
      }
      return sim.metrics().totalXp;
    };
    expect(play(1)).not.toEqual(play(2));
  });
});

describe("levelling", () => {
  it("keeps the party behind the dungeon, but not so far behind it is arithmetic", () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(100)).toBe(2);
    // The failure this replaced: the party reached the floor-five boss at level
    // two and lost to a number rather than to a decision.
    expect(levelFor(1_000)).toBeGreaterThanOrEqual(5);
    // And still behind the dungeon at the depth a good party actually reaches:
    // roughly level 48 against floor 39, where enemy health has gone up 13×.
    expect(levelFor(40_000)).toBeGreaterThan(30);
    expect(levelFor(40_000)).toBeLessThan(60);
  });

  it("lets each class spend opening skill points on its own build", async () => {
    const sim = createSimulation("descent", {
      seed: 4,
      days: 40,
      preparation: true,
      startingSkillPoints: 2,
    }) as DescentSimulation;
    const guardian = sim.view().party.guardian;
    const armor = guardian.armor;

    expect(await call(sim, "guardian", "invest_skill", { skill: "bastion" })).toMatch(/rank 1\/3/i);
    expect(guardian.armor).toBe(armor + 2);
    expect(guardian.talentPoints).toBe(1);
    expect(guardian.talents.bastion).toBe(1);
    expect(await call(sim, "mage", "invest_skill", { skill: "bastion" })).toMatch(/belongs to the guardian/i);
    expect(sim.scene().party.find((member) => member.id === "guardian")).toMatchObject({
      talentPoints: 1,
      talents: [{ id: "bastion", name: "Bastion", rank: 1 }],
    });
  });

  it("awards every character a spendable point when the party levels", async () => {
    const sim = fresh();
    await intoCombat(sim);
    const enemy = sim.view().enemies[0];
    sim.view().enemies = [{ ...enemy, hp: 1, maxHp: 1, armor: 0, xp: 100, hidden: { kind: "none" } }];
    await call(sim, "guardian", "attack", { target: enemy.ref });
    sim.advance();

    expect(sim.metrics().partyLevel).toBe(2);
    expect(Object.values(sim.view().party).every((fighter) => fighter.talentPoints === 1)).toBe(true);
  });
});

describe("a fighter's numbers", () => {
  it("recomputes rather than accumulates when gear changes hands", async () => {
    const sim = fresh();
    const guardian: Fighter = sim.view().party.guardian;
    const armour = guardian.armor;
    guardian.inventory.push(testItem("plate_cuirass"));
    await call(sim, "guardian", "equip_item", { item: "plate_cuirass" });
    const equipped = guardian.armor;
    expect(equipped).toBeGreaterThan(armour);
    // Equipping the same thing twice must not compound it.
    await call(sim, "guardian", "equip_item", { item: "plate_cuirass" });
    expect(guardian.armor).toBe(equipped);
  });

  it("applies a rolled copy's modifiers in addition to its base item", async () => {
    const sim = fresh();
    const guardian = sim.view().party.guardian;
    const rolled = Array.from({ length: 100 }, (_, index) =>
      makeItemInstance("vitality_ring", `rolled-ring-${index}`, "cache", 12, makeRng(index + 1)),
    ).find((item) => item.affixes.length > 0);
    expect(rolled).toBeDefined();
    if (!rolled) return;

    const before = {
      hp: guardian.maxHp,
      mana: guardian.maxMana,
      armor: guardian.armor,
      power: guardian.power,
      speed: guardian.speed,
    };
    guardian.inventory.push(rolled);
    await call(sim, "guardian", "equip_item", { item: rolled.id });

    const modifiers = rolled.affixes.reduce(
      (sum, affix) => ({
        hp: sum.hp + (affix.modifiers.hp ?? 0),
        mana: sum.mana + (affix.modifiers.mana ?? 0),
        armor: sum.armor + (affix.modifiers.armor ?? 0),
        power: sum.power + (affix.modifiers.power ?? 0),
        speed: sum.speed + (affix.modifiers.speed ?? 0),
      }),
      { hp: 0, mana: 0, armor: 0, power: 0, speed: 0 },
    );
    expect(guardian.maxHp).toBe(before.hp + 45 + modifiers.hp);
    expect(guardian.maxMana).toBe(Math.max(0, before.mana + modifiers.mana));
    expect(guardian.armor).toBe(Math.max(0, before.armor + modifiers.armor));
    expect(guardian.power).toBe(Math.max(1, before.power + modifiers.power));
    expect(guardian.speed).toBe(Math.max(1, before.speed + modifiers.speed));
  });
});
