/**
 * Five parties that play without a model, and the reason to build them first.
 *
 * A descent that scores 41,000 experience means nothing on its own. Next to a
 * random party at 2,100, a damage-only party at 14,800 and a rule-based party
 * at 38,000 it means something specific, and the gap to the oracle says how
 * much of the remaining headroom is memory rather than tactics.
 *
 * They also answer, in milliseconds, the question that would otherwise cost
 * thirty hours of model time to get wrong: does this dungeon have a gradient at
 * all? A simulation where every policy scores the same is a simulation
 * measuring noise, and the only cheap way to find that out is to play it ten
 * thousand times before a single agent is woken. Balance passes run against
 * these, not against the agents.
 *
 * ## Why they go through the same API the agents do
 *
 * Every policy below calls `useAbility`, `buyItem`, `tradeItem` — the same
 * public methods the tools wrap. A bot that reached into `sim.state` directly
 * would quietly ignore mana costs, cooldowns and phase rules, and the ladder it
 * produced would be a ladder for a different game. The cost of that discipline
 * is a lot of `try`/`catch`, because these methods refuse by throwing; the
 * benefit is that a bot cannot do anything an agent could not.
 *
 * ## The oracle is the ceiling, and it is deliberately unfair
 *
 * It reads `hidden` and `resist` straight off the enemy — knowledge no tool
 * will ever return and that a real party can only get by triggering the
 * mechanic and remembering it. That is the point: `oracle − ruleBased` is the
 * value of perfect recall in this dungeon, expressed in experience, and it is
 * the number that says whether the memory diagnostic is measuring something
 * worth measuring.
 */

import type { Policy, Simulation } from "../types.js";
import { equippableBy, itemDef, itemModifiers } from "./content.js";
import type { DescentSimulation } from "./index.js";
import {
  CLASSES,
  type ClassId,
  type DescentState,
  type Element,
  type Enemy,
  type Fighter,
  type ItemInstance,
} from "./model.js";

type Sim = DescentSimulation;

/** Every policy call is a refusal waiting to happen; none of them should stop a sweep. */
function attempt(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

const living = (s: DescentState): Fighter[] => CLASSES.map((c) => s.party[c]).filter((f) => !f.dead);
const foes = (s: DescentState): Enemy[] => s.enemies.filter((e) => e.hp > 0);
const weakest = (s: DescentState): Enemy | undefined => [...foes(s)].sort((a, b) => a.hp - b.hp)[0];
const hurtest = (s: DescentState): Fighter | undefined =>
  [...living(s)].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
const healthFraction = (s: DescentState): number => {
  const party = living(s);
  if (party.length === 0) return 0;
  return party.reduce((sum, f) => sum + f.hp / f.maxHp, 0) / party.length;
};
const usefulPaths = (s: DescentState): DescentState["paths"] => {
  if (!s.map) return s.paths;
  const fresh = s.paths.filter((path) => !s.map?.rooms.find((room) => room.id === path.id)?.visited);
  if (fresh.length > 0) return fresh;

  // At a dead end, walk the explored graph toward its nearest frontier rather
  // than oscillating between two cleared rooms. This uses only topology the
  // party has already walked plus the exits visible from those rooms.
  const rooms = new Map(s.map.rooms.map((room) => [room.id, room]));
  const seen = new Set([s.map.currentRoom]);
  const queue = s.paths.map((path) => ({ id: path.id, first: path.id }));
  for (const path of s.paths) seen.add(path.id);
  while (queue.length > 0) {
    const step = queue.shift();
    if (!step) break;
    const room = rooms.get(step.id);
    if (!room) continue;
    if (!room.visited) {
      const route = s.paths.find((path) => path.id === step.first);
      return route ? [route] : s.paths;
    }
    for (const id of room.links) {
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push({ id, first: step.first });
    }
  }
  return s.paths;
};

/** Rough worth of a piece of gear, used to decide upgrades and purchases. */
function gearScore(item: ItemInstance | string): number {
  const def = itemDef(item);
  if (!def) return 0;
  const affix = typeof item === "string" ? { power: 0, armor: 0, hp: 0, mana: 0, speed: 0 } : itemModifiers(item);
  return (
    ((def.power ?? 0) + affix.power) * 3 +
    ((def.armorBonus ?? 0) + affix.armor) * 2.5 +
    ((def.hp ?? 0) + affix.hp) * 0.35 +
    ((def.mana ?? 0) + affix.mana) * 0.25 +
    ((def.speed ?? 0) + affix.speed) * 2
  );
}

// ---------------------------------------------------------------------------
// Housekeeping shared by every policy above `random`
// ---------------------------------------------------------------------------

/**
 * Put the loot where it belongs and put it on.
 *
 * This is the resource-allocation behaviour the diagnostic watches for, written
 * out as about fifteen lines of policy. A party that never does it carries a
 * plate cuirass in the mage's bag for the rest of the run, which is worth
 * roughly a floor and a half by the twenties.
 */
function tidyPacks(sim: Sim, s: DescentState): void {
  for (const id of CLASSES) {
    const me = s.party[id];
    if (me.dead) continue;
    for (const item of [...me.inventory]) {
      const owners = equippableBy(item);
      if (owners.length === 0 || owners.includes(id)) continue;
      const taker = owners.find((o) => !s.party[o].dead && s.party[o].inventory.length < 6);
      if (taker) attempt(() => sim.tradeItem(id, taker, item.id));
    }
  }
  for (const id of CLASSES) {
    const me = s.party[id];
    if (me.dead) continue;
    for (const item of [...me.inventory]) {
      const def = itemDef(item);
      if (!def || def.kind === "consumable" || !equippableBy(item).includes(id)) continue;
      const current = me.equipped[def.kind];
      if (!current || gearScore(item) > gearScore(current)) attempt(() => sim.equipItem(id, item.id));
    }
  }
}

/** Bring somebody back if anybody is carrying the means. */
function reviveIfPossible(sim: Sim, s: DescentState): void {
  const fallen = CLASSES.find((c) => s.party[c].dead);
  if (!fallen) return;
  const bearer = CLASSES.find(
    (c) => !s.party[c].dead && s.party[c].inventory.some((item) => item.baseId === "soul_stone"),
  );
  if (bearer) attempt(() => sim.reviveAlly(bearer, fallen));
}

/**
 * Spend, pooling if that is what it takes.
 *
 * The pooling half is three lines and is the whole reason individual purses are
 * interesting: the best thing on the shelf is routinely worth more than any one
 * purse holds, and the party that works that out buys it four floors earlier
 * than the party that does not.
 */
function shop(sim: Sim, s: DescentState): void {
  const total = CLASSES.reduce((sum, c) => sum + s.party[c].gold, 0);
  // Consumables first, then the best affordable piece of gear somebody can use.
  const wantPotions =
    CLASSES.flatMap((c) => s.party[c].inventory).filter((item) => item.baseId === "healing_potion").length < 3;
  if (wantPotions) {
    const listing = s.stock.find((x) => x.item.baseId === "healing_potion");
    if (listing) {
      const buyer = CLASSES.find(
        (c) => !s.party[c].dead && s.party[c].gold >= listing.price && s.party[c].inventory.length < 6,
      );
      if (buyer) attempt(() => sim.buyItem(buyer, listing.item.id));
    }
  }

  const candidates = s.stock
    .filter((x) => {
      const def = itemDef(x.item);
      return def && def.kind !== "consumable" && x.price <= total;
    })
    .map((x) => ({ ...x, worth: gearScore(x.item) }))
    .sort((a, b) => b.worth - a.worth);

  for (const pick of candidates) {
    const owners = equippableBy(pick.item).filter((o) => !s.party[o].dead && s.party[o].inventory.length < 6);
    const kind = itemDef(pick.item)?.kind;
    if (kind !== "weapon" && kind !== "armor" && kind !== "trinket") continue;
    // Whoever gains most from it, not whoever happens to be able to afford it.
    const target = owners
      .map((o) => ({ o, gain: gearScore(pick.item) - gearScore(s.party[o].equipped[kind] ?? "") }))
      .sort((a, b) => b.gain - a.gain)[0];
    if (!target || target.gain <= 0) continue;
    const buyer = s.party[target.o];
    if (buyer.gold < pick.price) {
      let needed = pick.price - buyer.gold;
      for (const donor of CLASSES) {
        if (donor === target.o || needed <= 0) continue;
        const spare = s.party[donor].gold;
        if (spare <= 0) continue;
        const give = Math.min(spare, needed);
        if (attempt(() => sim.giveGold(donor, target.o, give))) needed -= give;
      }
    }
    if (attempt(() => sim.buyItem(target.o, pick.item.id))) break;
  }
}

/** Spend visible skill points through the same API an agent uses. */
function spendTalents(sim: Sim, s: DescentState, damageOnly = false): void {
  const balanced: Record<ClassId, string[]> = {
    guardian: damageOnly ? ["warcraft"] : ["bastion", "iron_constitution", "warcraft"],
    mage: damageOnly ? ["arcane_power"] : ["deep_reserve", "arcane_power", "quick_cast"],
    rogue: damageOnly ? ["precision"] : ["precision", "agility", "hard_to_kill"],
    cleric: damageOnly ? ["zeal"] : ["grace", "warded_faith", "zeal"],
    ranger: damageOnly ? ["deadeye"] : ["deadeye", "survivalist", "trailcraft"],
  };
  for (const id of CLASSES) {
    let guard = 0;
    while (s.party[id].talentPoints > 0 && guard++ < 12) {
      const choices = balanced[id];
      const pick = choices.find((skill) => (s.party[id].talents[skill] ?? 0) < 3);
      if (!pick || !attempt(() => sim.investTalent(id, pick))) break;
    }
  }
}

/**
 * Take the best couple of things out of a dead expedition's packs.
 *
 * The cap is what makes this interesting and what makes a baseline for it
 * worth writing: there is no purse to settle the question, so the only
 * distinguishing skill is judging which two of six are worth the most to
 * *somebody in this party*. A policy that takes the first two things it sees
 * scores strictly worse, and the ladder can tell them apart.
 */
function loot(sim: Sim, s: DescentState): void {
  let guard = 0;
  while (s.cacheTakesLeft > 0 && guard++ < 8) {
    const offers = s.cache
      .filter((entry) => !entry.taken)
      .map((entry) => {
        const def = itemDef(entry.item);
        const kind = def?.kind;
        if (!def) return { entry, taker: undefined as ClassId | undefined, gain: -1 };
        if (kind === "consumable") {
          // Worth something to anybody, and worth more when the party is thin
          // on them. Never worth more than a real upgrade.
          const held = CLASSES.flatMap((c) => s.party[c].inventory).filter(
            (item) => item.baseId === entry.item.baseId,
          ).length;
          const taker = CLASSES.find((c) => !s.party[c].dead && s.party[c].inventory.length < 6);
          return { entry, taker, gain: taker ? Math.max(1, 14 - held * 6) : -1 };
        }
        if (kind !== "weapon" && kind !== "armor" && kind !== "trinket") {
          return { entry, taker: undefined as ClassId | undefined, gain: -1 };
        }
        // Whoever gains most by wearing it, exactly as `shop` does.
        const best = equippableBy(entry.item)
          .filter((o) => !s.party[o].dead && s.party[o].inventory.length < 6)
          .map((o) => ({ o, gain: gearScore(entry.item) - gearScore(s.party[o].equipped[kind] ?? "") }))
          .sort((a, b) => b.gain - a.gain)[0];
        return { entry, taker: best?.o, gain: best?.gain ?? -1 };
      })
      .filter((c) => c.taker && c.gain > 0)
      .sort((a, b) => b.gain - a.gain);

    const pick = offers[0];
    if (!pick?.taker) break;
    if (!attempt(() => sim.takeFromCache(pick.taker, pick.entry.item.id))) break;
    attempt(() => sim.equipItem(pick.taker, pick.entry.item.id));
  }
}

// ---------------------------------------------------------------------------
// The policies
// ---------------------------------------------------------------------------

interface Brain {
  /** Spend the opening budget before taking the first stair. */
  prepare?(sim: Sim, s: DescentState): void;
  /** Optional housekeeping while standing on a persistent floor map. */
  explore?(sim: Sim, s: DescentState): boolean;
  /** Which way on. */
  path(sim: Sim, s: DescentState): string;
  /** One combat action per living member. */
  fight(sim: Sim, s: DescentState): void;
  /** Between fights. Return true to stay another round. */
  between(sim: Sim, s: DescentState): boolean;
}

function drive(name: string, brain: Brain): Policy {
  return {
    name,
    act(simulation: Simulation): void {
      const sim = simulation as Sim;
      const s = sim.view();
      switch (s.phase) {
        case "camp": {
          brain.prepare?.(sim, s);
          const speaker = CLASSES.find((c) => !s.party[c].dead);
          if (speaker) attempt(() => sim.enterDungeon(speaker));
          return;
        }
        case "explore": {
          if (s.map && brain.explore?.(sim, s)) return;
          const speaker = CLASSES.find((c) => !s.party[c].dead) ?? "guardian";
          const room = s.map?.rooms.find((candidate) => candidate.id === s.map?.currentRoom);
          if (room?.kind === "stairs") attempt(() => sim.requestDescend(speaker));
          else attempt(() => sim.choosePath(speaker, brain.path(sim, s)));
          return;
        }
        case "combat":
          brain.fight(sim, s);
          return;
        case "spoils":
        case "market":
        case "cache": {
          const stay = brain.between(sim, s);
          if (!stay) {
            const speaker = CLASSES.find((c) => !s.party[c].dead);
            if (speaker) {
              if (s.map) attempt(() => sim.continueExploring(speaker));
              else attempt(() => sim.requestDescend(speaker));
            }
          }
          return;
        }
        default:
          return;
      }
    },
  };
}

/**
 * Legal moves, chosen without a thought. The floor of the ladder.
 *
 * If anything scores below this, the scoring is wrong. If the rule-based party
 * does not clear it by a wide margin, the dungeon is not rewarding play.
 */
function randomPolicy(): Policy {
  let n = 0;
  // A counter rather than a random draw, so a sweep is reproducible: the whole
  // package forbids `Math.random()` under `sim/` for the same reason.
  const pick = <T>(xs: T[]): T | undefined => (xs.length === 0 ? undefined : xs[n++ % xs.length]);

  return drive("random", {
    path: (_sim, s) => pick(s.paths)?.id ?? "left",
    fight: (sim, s) => {
      for (const f of living(s)) {
        const target = pick(foes(s));
        if (!target) return;
        const options = ["attack", "defend", ...abilitiesFor(f.id)];
        const choice = pick(options) ?? "attack";
        if (choice === "attack") attempt(() => sim.useBasic(f.id, target.ref));
        else if (choice === "defend") attempt(() => sim.useDefend(f.id));
        else if (!attempt(() => sim.useAbility(f.id, choice, allyOrEnemy(choice, s, target)))) {
          attempt(() => sim.useBasic(f.id, target.ref));
        }
      }
    },
    between: () => false,
  });
}

const CLASS_ABILITIES: Record<ClassId, string[]> = {
  guardian: ["taunt", "shield", "shield_slam"],
  mage: ["firebolt", "frostbite", "lightning", "fireball"],
  rogue: ["backstab", "interrupt", "sleep_powder", "vanish"],
  cleric: ["heal", "cleanse", "bless", "sanctuary"],
  ranger: ["shoot", "mark", "volley"],
};

const ALLY_TARGETED = new Set(["shield", "heal", "cleanse", "bless"]);

const abilitiesFor = (id: ClassId): string[] => CLASS_ABILITIES[id];
const allyOrEnemy = (ability: string, s: DescentState, enemy: Enemy): string =>
  ALLY_TARGETED.has(ability) ? (hurtest(s)?.id ?? "guardian") : enemy.ref;

/** Everything attacks, nothing heals. Fast, and it dies around floor eight. */
function greedyPolicy(): Policy {
  return drive("greedy-dps", {
    prepare: (sim, s) => {
      spendTalents(sim, s, true);
      shop(sim, s);
    },
    explore: (sim, s) => {
      spendTalents(sim, s, true);
      tidyPacks(sim, s);
      return false;
    },
    // Greedy about damage, not suicidal about routing. Taking every elite meant
    // it never saw floor six, which made it look like a worse policy than
    // random when what it actually is is a policy with no healer.
    path: (_sim, s) => {
      const paths = usefulPaths(s);
      return (
        (healthFraction(s) > 0.7 ? paths.find((p) => p.kind === "elite") : undefined)?.id ??
        paths.find((p) => p.kind === "unknown")?.id ??
        paths[0].id
      );
    },
    fight: (sim, s) => {
      const target = weakest(s);
      if (!target) return;
      for (const f of living(s)) {
        const best = {
          guardian: "shield_slam",
          mage: "lightning",
          rogue: "backstab",
          cleric: "attack",
          ranger: "shoot",
        }[f.id];
        if (best === "attack" || !attempt(() => sim.useAbility(f.id, best, target.ref))) {
          attempt(() => sim.useBasic(f.id, target.ref));
        }
      }
    },
    between: (sim, s) => {
      spendTalents(sim, s, true);
      tidyPacks(sim, s);
      if (s.phase === "market") shop(sim, s);
      if (s.phase === "cache") loot(sim, s);
      return false;
    },
  });
}

/**
 * Plays the fight and nothing else: taunt, heal, swing.
 *
 * The rung that exists because the first ladder had a hole in it — random and
 * greedy died around floor six, rule-based reached forty, and there was nothing
 * in between, so any agent run landing in the middle could only be described as
 * "better than random". This one uses no class ability beyond the two obvious
 * ones and never opens its pack, which is roughly what a party does when nobody
 * is coordinating anything.
 */
function basicPolicy(): Policy {
  return drive("basic-tactics", {
    path: (_sim, s) => {
      const paths = usefulPaths(s);
      return (paths.find((p) => p.kind === "shrine") ?? paths.find((p) => p.kind !== "elite") ?? paths[0]).id;
    },
    fight: (sim, s) => {
      const target = weakest(s);
      const hurt = hurtest(s);
      for (const f of living(s)) {
        if (f.id === "cleric" && hurt && hurt.hp / hurt.maxHp < 0.75) {
          if (attempt(() => sim.useAbility("cleric", "heal", hurt.id))) continue;
        }
        if (f.id === "guardian" && attempt(() => sim.useAbility("guardian", "taunt"))) continue;
        if (target) attempt(() => sim.useBasic(f.id, target.ref));
      }
    },
    between: (sim, s) => {
      // Potions only, and only in an emergency. No trading, no shopping.
      const dying = hurtest(s);
      if (dying && dying.hp / dying.maxHp < 0.35) {
        const bearer = CLASSES.find(
          (c) => !s.party[c].dead && s.party[c].inventory.some((item) => item.baseId === "healing_potion"),
        );
        if (bearer) attempt(() => sim.useItem(bearer, "healing_potion", dying.id));
      }
      return false;
    },
  });
}

/**
 * The full tactical layer, and nothing outside the fight.
 *
 * Isolates what the out-of-combat organisation is worth: it fights exactly as
 * well as `rule-based` and never trades an item, pools a coin, buys an upgrade,
 * takes anything out of a cache, or revives anybody. The gap between this row
 * and the next one is the price of ignoring everything that happens between
 * fights.
 */
function tacticalPolicy(): Policy {
  const full = ruleBasedPolicy(false);
  return {
    name: "tactics-only",
    act(simulation: Simulation): void {
      const sim = simulation as Sim;
      const s = sim.view();
      if (s.phase === "camp") {
        const speaker = CLASSES.find((c) => !s.party[c].dead);
        if (speaker) attempt(() => sim.enterDungeon(speaker));
        return;
      }
      // Caches are skipped along with everything else out of combat. A
      // `tactics-only` party that stopped to loot would blur the one thing
      // this row exists to isolate.
      if (s.phase === "spoils" || s.phase === "market" || s.phase === "cache") {
        const speaker = CLASSES.find((c) => !s.party[c].dead);
        if (speaker) {
          if (s.map) attempt(() => sim.continueExploring(speaker));
          else attempt(() => sim.requestDescend(speaker));
        }
        return;
      }
      full.act(simulation);
    },
  };
}

/**
 * The bar an agent framework has to clear.
 *
 * Everything here is a rule a competent player would follow without thinking:
 * hold threat, heal the one who is dying, focus the weakest, interrupt what is
 * winding up, mark the biggest, spend on upgrades. It knows nothing that a tool
 * would not tell it — no hidden mechanics, no resistances it did not inspect —
 * which is exactly what makes it the right comparison.
 */
function ruleBasedPolicy(omniscient = false): Policy {
  const bestElement = (e: Enemy): string => {
    if (!omniscient) return "lightning";
    // The oracle picks by resistance, and never hands a reflecting family the
    // element it reflects.
    const options: Array<[string, Element]> = [
      ["lightning", "lightning"],
      ["firebolt", "fire"],
      ["frostbite", "frost"],
    ];
    const scored = options
      .filter(([, el]) => !(e.hidden.kind === "reflect" && e.hidden.element === el))
      .map(([name, el]) => ({
        name,
        factor: e.resist[el] ?? 1,
        weight: name === "lightning" ? 1.9 : name === "firebolt" ? 1.6 : 1.2,
      }))
      .sort((a, b) => b.factor * b.weight - a.factor * a.weight);
    return scored[0]?.name ?? "firebolt";
  };

  const healingIsPunished = (s: DescentState): boolean =>
    omniscient &&
    foes(s).some(
      (e) => e.hidden.kind === "punishHeal" || (e.hidden.kind === "tollHeal" && (e.age + 1) % e.hidden.period === 0),
    );

  /**
   * Something in front of us detonates when it dies, and it is nearly dead.
   *
   * The counter is a shield up before the blast rather than a heal after it,
   * which is the whole difference between a party that has met a wisp before
   * and one that has not. Only the oracle knows to look.
   */
  const burstComing = (s: DescentState): boolean =>
    omniscient &&
    healthFraction(s) < 0.85 &&
    foes(s).some((e) => e.hidden.kind === "deathburst" && e.hp / e.maxHp < 0.3);

  return drive(omniscient ? "oracle" : "rule-based", {
    prepare: (sim, s) => {
      spendTalents(sim, s);
      shop(sim, s);
      tidyPacks(sim, s);
    },
    explore: (sim, s) => {
      spendTalents(sim, s);
      tidyPacks(sim, s);
      reviveIfPossible(sim, s);
      if (healthFraction(s) < 0.6 && s.dread < 4) {
        attempt(() => sim.restParty(CLASSES.find((c) => !s.party[c].dead) ?? "guardian"));
        return true;
      }
      return false;
    },
    path: (_sim, s) => {
      const paths = usefulPaths(s);
      const cache = paths.find((p) => p.kind === "cache");
      const market = paths.find((p) => p.kind === "market");
      const elite = paths.find((p) => p.kind === "elite");
      const shrine = paths.find((p) => p.kind === "shrine");
      const room = CLASSES.some((c) => !s.party[c].dead && s.party[c].inventory.length < 6);
      const thin =
        CLASSES.flatMap((c) => s.party[c].inventory).filter((item) => item.baseId === "healing_potion").length < 2;

      // Each way on gets the band it is actually right for.
      //
      // `generatePaths` always offers all four kinds, so a flat preference list
      // makes everything below the first two entries unreachable: the market
      // branch never ran in any sweep, which is why `shop` was effectively dead
      // code and why the first cache build produced a byte-identical ladder.
      // Ordering by *party state* instead gives every path a real turn.
      const health = healthFraction(s);
      if (health < 0.5 && shrine) return shrine.id;
      // Strong enough to want the harder room, which pays the most experience.
      if (health > 0.8 && elite) return elite.id;
      // Middling: take the ordinary room that also has somebody's packs in it.
      if (cache && room) return cache.id;
      if (market && thin) return market.id;
      if (shrine) return shrine.id;
      return (paths.find((p) => p.kind === "unknown") ?? paths[0]).id;
    },

    fight: (sim, s) => {
      const enemies = foes(s);
      if (enemies.length === 0) return;
      const target = [...enemies].sort((a, b) => a.hp - b.hp)[0];
      const biggest = [...enemies].sort((a, b) => b.maxHp - a.maxHp)[0];
      const winding = enemies.find((e) => e.telegraph);
      const hurt = hurtest(s);
      const dying = hurt && hurt.hp / hurt.maxHp < 0.5 ? hurt : undefined;
      const serious = enemies.some((e) => e.boss || e.elite);

      for (const f of living(s)) {
        switch (f.id) {
          case "guardian": {
            if (enemies.length >= 2 && attempt(() => sim.useAbility("guardian", "taunt"))) continue;
            if (dying && dying.id !== "guardian" && attempt(() => sim.useAbility("guardian", "shield", dying.id)))
              continue;
            if (attempt(() => sim.useAbility("guardian", "shield_slam", target.ref))) continue;
            attempt(() => sim.useBasic("guardian", target.ref));
            continue;
          }
          case "cleric": {
            // Shield before the blast rather than heal after it.
            if (burstComing(s) && attempt(() => sim.useAbility("cleric", "sanctuary"))) continue;
            // A dying ally is worth a potion when the healing itself is a trap.
            if (dying && healingIsPunished(s)) {
              const potion =
                f.inventory.find((item) => item.baseId === "greater_potion" && serious) ??
                f.inventory.find((item) => item.baseId === "healing_potion");
              if (potion && attempt(() => sim.useItem("cleric", potion.id, dying.id))) continue;
            }
            if (dying && healingIsPunished(s) && attempt(() => sim.useDefend("cleric"))) continue;
            if (dying && attempt(() => sim.useAbility("cleric", "heal", dying.id))) continue;
            if (f.mana >= 25 && enemies.length >= 3 && attempt(() => sim.useAbility("cleric", "sanctuary"))) continue;
            if (attempt(() => sim.useAbility("cleric", "bless", "guardian"))) continue;
            attempt(() => sim.useBasic("cleric", target.ref));
            continue;
          }
          case "mage": {
            // Area damage into a group of things that detonate is a chain, and
            // the chain lands on the party. The oracle knows; nobody else does.
            const chainRisk =
              omniscient &&
              healthFraction(s) < 0.7 &&
              enemies.filter((e) => e.hidden.kind === "deathburst").length >= 2;
            if (!chainRisk && enemies.length >= 3 && f.mana >= 20 && attempt(() => sim.useAbility("mage", "fireball")))
              continue;
            const spell = bestElement(target);
            if (attempt(() => sim.useAbility("mage", spell, target.ref))) continue;
            if (attempt(() => sim.useAbility("mage", "firebolt", target.ref))) continue;
            attempt(() => sim.useBasic("mage", target.ref));
            continue;
          }
          case "rogue": {
            if (winding && attempt(() => sim.useAbility("rogue", "interrupt", winding.ref))) continue;
            if (attempt(() => sim.useAbility("rogue", "backstab", target.ref))) continue;
            attempt(() => sim.useBasic("rogue", target.ref));
            continue;
          }
          case "ranger": {
            if (
              biggest.statuses.every((x) => x.kind !== "mark") &&
              attempt(() => sim.useAbility("ranger", "mark", biggest.ref))
            )
              continue;
            if (enemies.length >= 3 && attempt(() => sim.useAbility("ranger", "volley"))) continue;
            if (attempt(() => sim.useAbility("ranger", "shoot", target.ref))) continue;
            attempt(() => sim.useBasic("ranger", target.ref));
            continue;
          }
        }
      }
    },

    between: (sim, s) => {
      spendTalents(sim, s);
      tidyPacks(sim, s);
      reviveIfPossible(sim, s);
      if (s.phase === "market") shop(sim, s);
      if (s.phase === "cache") loot(sim, s);
      // Resting costs dread; it is worth it only when the party is genuinely
      // hurt and the dungeon has not already noticed them.
      if (healthFraction(s) < 0.6 && s.dread < 4) {
        attempt(() => sim.restParty(CLASSES.find((c) => !s.party[c].dead) ?? "guardian"));
        return true;
      }
      return false;
    },
  });
}

/**
 * The ladder, in the order it should be read.
 *
 * Each rung adds one thing: aim, then support, then the full tactical layer,
 * then everything that happens between fights, then perfect recall. `bench`
 * prints them in this order and checks the means are monotonic, because a rung
 * that does not pay for itself is either a bad policy or a bad mechanic, and
 * either way it is worth knowing before a model is asked to play.
 */
export const DESCENT_POLICIES: Record<string, () => Policy> = {
  // Damage-only sits *below* random, which is a measured result rather than an
  // ordering choice: a party that never heals dies around floor eight, and one
  // that flails at least heals by accident. It is the cheapest evidence that
  // this dungeon rewards support over output.
  "greedy-dps": greedyPolicy,
  random: randomPolicy,
  "basic-tactics": basicPolicy,
  "tactics-only": tacticalPolicy,
  "rule-based": () => ruleBasedPolicy(false),
  oracle: () => ruleBasedPolicy(true),
};
