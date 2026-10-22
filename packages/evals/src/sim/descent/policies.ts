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
import { equippableBy, itemDef, itemModifiers, routeBetween } from "./content.js";
import type { DescentSimulation } from "./index.js";
import {
  CLASSES,
  type ClassId,
  type DescentState,
  type Element,
  type Enemy,
  equippedItemEffects,
  type Fighter,
  type ItemEffect,
  type ItemInstance,
  type PersonalGoalEvent,
  type RoomEnvironmentKind,
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
const merchantPrice = (fighter: Fighter, listed: number): number => {
  const discount = Math.min(
    0.35,
    equippedItemEffects(fighter)
      .filter(
        (effect): effect is Extract<ItemEffect, { kind: "merchant-discount" }> => effect.kind === "merchant-discount",
      )
      .reduce((sum, effect) => sum + effect.fraction, 0),
  );
  return Math.round(listed * (1 - discount));
};
const usefulPaths = (s: DescentState, includeClosedLocks = false): DescentState["paths"] => {
  if (!s.map) return s.paths;
  const canTraverse = (from: string, to: string): boolean => {
    const route = s.map ? routeBetween(s.map, from, to) : undefined;
    if (route?.kind === "toll" && !route.openedBy) return false;
    return includeClosedLocks || route?.kind !== "locked" || route.openedBy !== undefined;
  };
  const available = s.paths.filter((path) => canTraverse(s.map?.currentRoom ?? "", path.id));
  const fresh = available.filter((path) => !s.map?.rooms.find((room) => room.id === path.id)?.visited);
  if (fresh.length > 0) return fresh;

  // At a dead end, walk the explored graph toward its nearest frontier rather
  // than oscillating between two cleared rooms. This uses only topology the
  // party has already walked plus the exits visible from those rooms.
  const rooms = new Map(s.map.rooms.map((room) => [room.id, room]));
  const seen = new Set([s.map.currentRoom]);
  const queue = available.map((path) => ({ id: path.id, first: path.id }));
  for (const path of available) seen.add(path.id);
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
      if (!canTraverse(room.id, id)) continue;
      seen.add(id);
      queue.push({ id, first: step.first });
    }
  }
  return available;
};

const pathHasEscapedEncounter = (s: DescentState, path: DescentState["paths"][number]): boolean => {
  if (!s.map) return path.kind === "retreat";
  const room =
    path.kind === "retreat"
      ? s.map.rooms.find((candidate) => candidate.id === s.map?.currentRoom)
      : s.map.rooms.find((candidate) => candidate.id === path.id);
  return room?.encounter?.enemies.some((enemy) => enemy.hp > 0) ?? false;
};

/** Prefer the owner of a matching unfinished motive when several agents can make the same legal call. */
const motivatedActor = (s: DescentState, event: PersonalGoalEvent): ClassId | undefined =>
  CLASSES.find((id) => {
    const fighter = s.party[id];
    return !fighter.dead && !fighter.identity.secretGoal.completed && fighter.identity.secretGoal.event === event;
  });

/** Rough worth of a piece of gear, used to decide upgrades and purchases. */
function gearScore(item: ItemInstance | string, owner?: ClassId): number {
  const def = itemDef(item);
  if (!def) return 0;
  const affix = typeof item === "string" ? { power: 0, armor: 0, hp: 0, mana: 0, speed: 0 } : itemModifiers(item);
  const manaWeight = owner === "mage" || owner === "cleric" || owner === undefined ? 0.25 : 0;
  const effectScore =
    typeof item === "string"
      ? 0
      : item.affixes.reduce((sum, entry) => {
          switch (entry.effect?.kind) {
            case "cleave":
              return sum + 22 * entry.effect.fraction;
            case "vampirism":
              return sum + 90 * entry.effect.fraction;
            case "regeneration":
              return sum + entry.effect.amount * 2.5;
            case "reveal":
              return sum + (entry.effect.scope === "floor" ? 18 : 7);
            case "merchant-discount":
              return sum + entry.effect.fraction * 70;
            case "cache-capacity":
              return sum + entry.effect.amount * 22;
            case "cooldown-reduction":
              return sum + entry.effect.amount * 16;
            default:
              return sum;
          }
        }, 0);
  return (
    ((def.power ?? 0) + affix.power) * 3 +
    ((def.armorBonus ?? 0) + affix.armor) * 2.5 +
    ((def.hp ?? 0) + affix.hp) * 0.35 +
    ((def.mana ?? 0) + affix.mana) * manaWeight +
    ((def.speed ?? 0) + affix.speed) * 2 +
    effectScore
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
      if (!current || gearScore(item, id) > gearScore(current, id)) attempt(() => sim.equipItem(id, item.id));
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
      const buyer = CLASSES.find((c) => {
        const fighter = s.party[c];
        return !fighter.dead && fighter.gold >= merchantPrice(fighter, listing.price) && fighter.inventory.length < 6;
      });
      if (buyer) attempt(() => sim.buyItem(buyer, listing.item.id));
    }
  }

  const candidates = s.stock
    .filter((x) => {
      const def = itemDef(x.item);
      return def && def.kind !== "consumable" && x.price <= total;
    })
    .map((x) => ({
      ...x,
      worth: Math.max(...equippableBy(x.item).map((owner) => gearScore(x.item, owner))),
    }))
    .sort((a, b) => b.worth - a.worth);

  for (const pick of candidates) {
    const owners = equippableBy(pick.item).filter((o) => !s.party[o].dead && s.party[o].inventory.length < 6);
    const kind = itemDef(pick.item)?.kind;
    if (kind !== "weapon" && kind !== "armor" && kind !== "trinket") continue;
    // Whoever gains most from it, not whoever happens to be able to afford it.
    const target = owners
      .map((o) => ({ o, gain: gearScore(pick.item, o) - gearScore(s.party[o].equipped[kind] ?? "", o) }))
      .sort((a, b) => b.gain - a.gain)[0];
    if (!target || target.gain <= 0) continue;
    const buyer = s.party[target.o];
    const price = merchantPrice(buyer, pick.price);
    if (buyer.gold < price) {
      let needed = price - buyer.gold;
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
          .map((o) => ({ o, gain: gearScore(entry.item, o) - gearScore(s.party[o].equipped[kind] ?? "", o) }))
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
          const speaker = motivatedActor(s, "new-room-led") ?? CLASSES.find((c) => !s.party[c].dead) ?? "guardian";
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
      const wounded = paths.find((path) => pathHasEscapedEncounter(s, path));
      if (healthFraction(s) > 0.72 && wounded) return wounded.id;
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
      const wounded = paths.find((path) => pathHasEscapedEncounter(s, path));
      return (
        (healthFraction(s) > 0.7 ? wounded : undefined) ??
        paths.find((p) => p.kind === "shrine") ??
        paths.find((p) => p.kind !== "elite") ??
        paths[0]
      ).id;
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
  const full = ruleBasedPolicy(false, false, false);
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
/**
 * @param organise Whether this row is allowed to do anything five people do
 * together. `tactics-only` sets it false: it inherits every combat rule and
 * none of the organisation, which is the entire reason that row exists. Toll
 * gates made this explicit — before them the distinction was maintained by
 * `tacticalPolicy` intercepting phases, and a gate is paid during `explore`,
 * so the pooling leaked straight through and the row started pooling gold in
 * 93% of runs.
 */
function ruleBasedPolicy(omniscient = false, navigateHazards = true, organise = true): Policy {
  const scoutedByRun = new WeakMap<Sim, Set<number>>();
  const bestElement = (e: Enemy, environment?: RoomEnvironmentKind, caster?: Fighter): string => {
    /*
     * Gear changes what you cast, and that is the point of an attuned item.
     *
     * Without this the affinity affix is worth nothing to any policy below the
     * oracle: `rule-based` casts lightning unconditionally, so a frost-attuned
     * staff is a trinket slot spent on a bonus that never fires. Measured, an
     * unusable affix does not read as a neutral item — it reads as a *worse*
     * one, because it displaced a stat affix that would have done something.
     */
    const attuned = caster
      ? equippedItemEffects(caster)
          .filter((effect): effect is Extract<ItemEffect, { kind: "affinity" }> => effect.kind === "affinity")
          .map((effect) => effect.element)
      : [];
    const spellFor: Partial<Record<Element, string>> = { lightning: "lightning", fire: "firebolt", frost: "frostbite" };
    const usable = attuned
      .map((element) => ({ element, spell: spellFor[element] }))
      .filter(
        (entry): entry is { element: Element; spell: string } =>
          entry.spell !== undefined && !(e.hidden.kind === "reflect" && e.hidden.element === entry.element),
      );
    if (!omniscient) {
      // Cast what the gear favours if the gear favours anything castable; the
      // 25% affinity comfortably beats the small default preference.
      return usable[0]?.spell ?? "lightning";
    }
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
        factor:
          (e.resist[el] ?? 1) *
          (environment === "flooded" ? (el === "lightning" ? 1.25 : el === "fire" ? 0.75 : 1) : 1),
        weight: (name === "lightning" ? 1.9 : name === "firebolt" ? 1.6 : 1.2) * (attuned.includes(el) ? 1.25 : 1),
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
      const current = s.map?.rooms.find((room) => room.id === s.map?.currentRoom);
      let scoutedFloors = scoutedByRun.get(sim);
      if (!scoutedFloors) {
        scoutedFloors = new Set<number>();
        scoutedByRun.set(sim, scoutedFloors);
      }
      const scoutingWorthTime = healthFraction(s) < 0.7;
      if (
        navigateHazards &&
        scoutingWorthTime &&
        s.map &&
        current?.kind === "entrance" &&
        !scoutedFloors.has(s.floor)
      ) {
        if (attempt(() => sim.scoutPaths("rogue"))) scoutedFloors.add(s.floor);
      }
      if (healthFraction(s) < 0.6 && s.dread < 4) {
        attempt(() => sim.restParty(CLASSES.find((c) => !s.party[c].dead) ?? "guardian"));
        return true;
      }
      return false;
    },
    path: (sim, s) => {
      const navigable = usefulPaths(s, navigateHazards);
      const paths = navigable.filter((path) => {
        const map = s.map;
        const current = map?.rooms.find((room) => room.id === map.currentRoom);
        const route = map && current ? routeBetween(map, current.id, path.id) : undefined;
        return (
          route?.kind !== "locked" ||
          route.openedBy !== undefined ||
          (map?.keys ?? 0) > 0 ||
          !s.party.rogue.dead ||
          !s.party.guardian.dead
        );
      });
      const wounded = paths.find((path) => pathHasEscapedEncounter(s, path));
      const cache = paths.find((p) => p.kind === "cache");
      const market = paths.find((p) => p.kind === "market");
      const elite = paths.find((p) => p.kind === "elite");
      const shrine = paths.find((p) => p.kind === "shrine");
      const shortcut = paths.find((p) => p.route === "secret");
      const roomFor = (path: DescentState["paths"][number]) =>
        s.map?.rooms.find((candidate) => candidate.id === path.id);
      const leadsToFight = (path: DescentState["paths"][number]) =>
        path.kind === "combat" || path.kind === "elite" || path.kind === "boss";
      const arcaneWell = paths.find((path) => roomFor(path)?.environment === "arcane-well" && leadsToFight(path));
      const highGround = paths.find((path) => roomFor(path)?.environment === "high-ground" && leadsToFight(path));
      const room = CLASSES.some((c) => !s.party[c].dead && s.party[c].inventory.length < 6);
      const thin =
        CLASSES.flatMap((c) => s.party[c].inventory).filter((item) => item.baseId === "healing_potion").length < 2;
      const take = (path: DescentState["paths"][number]) => {
        const map = s.map;
        const current = map?.rooms.find((candidate) => candidate.id === map.currentRoom);
        const route = map && current ? routeBetween(map, current.id, path.id) : undefined;
        if (route?.kind === "locked" && !route.openedBy) {
          const speaker = motivatedActor(s, "lock-opened") ?? CLASSES.find((id) => !s.party[id].dead) ?? "guardian";
          if (map && map.keys > 0) attempt(() => sim.unlockRoute(speaker, path.id));
          else if (!s.party.rogue.dead) attempt(() => sim.pickLock("rogue", path.id));
          else if (!s.party.guardian.dead) attempt(() => sim.breachRoute("guardian", path.id));
        }
        if (route?.kind === "trap" && route.featureKnown && !route.triggered && !route.disarmed) {
          attempt(() => sim.disarmTrap("rogue", path.id));
        }
        return path.id;
      };

      /*
       * Raise a toll between the five purses, then pay it.
       *
       * A baseline has to be able to do this or the mechanic never appears in
       * the ladder, and a milestone nothing on the ladder reaches is not a
       * measurement. The two steps are the point: the gate is priced above one
       * purse, so the richest character collects from the others first and only
       * then opens the gate — which is `give_gold` and `pay_toll` in the order
       * a party would have to discover for itself.
       */
      const openToll = (path: DescentState["paths"][number]): boolean => {
        const map = s.map;
        const current = map?.rooms.find((candidate) => candidate.id === map.currentRoom);
        const route = map && current ? routeBetween(map, current.id, path.id) : undefined;
        if (route?.kind !== "toll" || route.openedBy) return false;
        const price = route.toll ?? 0;
        const living = CLASSES.filter((id) => !s.party[id].dead);
        const together = living.reduce((sum, id) => sum + s.party[id].gold, 0);
        // Leave enough behind that paying does not empty the party before a
        // merchant. A toll is a purchase, and it competes with the other ones.
        if (together < price + 60) return false;
        const payer = living.reduce((best, id) => (s.party[id].gold > s.party[best].gold ? id : best), living[0]);
        for (const id of living) {
          if (s.party[payer].gold >= price) break;
          if (id === payer || s.party[id].gold <= 0) continue;
          const short = price - s.party[payer].gold;
          attempt(() => sim.giveGold(id, payer, Math.min(short, s.party[id].gold)));
        }
        attempt(() => sim.payToll(payer, path.id));
        return route.openedBy !== undefined;
      };

      // Each way on gets the band it is actually right for.
      //
      // `generatePaths` always offers all four kinds, so a flat preference list
      // makes everything below the first two entries unreachable: the market
      // branch never ran in any sweep, which is why `shop` was effectively dead
      // code and why the first cache build produced a byte-identical ladder.
      // A gate is worth opening before the preferences are weighed, because
      // whatever is behind it is why the floor put it there. `usefulPaths`
      // filters an unpaid toll out, so the candidate has to come off the raw
      // list; once it opens it competes with everything else on its merits.
      const gated = s.paths.find((path) => {
        const map = s.map;
        const current = map?.rooms.find((candidate) => candidate.id === map.currentRoom);
        const route = map && current ? routeBetween(map, current.id, path.id) : undefined;
        return route?.kind === "toll" && !route.openedBy && (path.kind === "cache" || path.kind === "market");
      });
      if (organise && gated && openToll(gated)) return gated.id;

      // Ordering by *party state* instead gives every path a real turn.
      const health = healthFraction(s);
      const casters = [s.party.mage, s.party.cleric].filter((fighter) => !fighter.dead && fighter.maxMana > 0);
      const mana =
        casters.length > 0
          ? casters.reduce((sum, fighter) => sum + fighter.mana / fighter.maxMana, 0) / casters.length
          : 1;
      if (mana < 0.45 && arcaneWell) return take(arcaneWell);
      if (health < 0.5 && shrine) return take(shrine);
      if (health > 0.65 && wounded) return take(wounded);
      if (
        shortcut &&
        ((shortcut.kind === "shrine" && health < 0.75) ||
          (shortcut.kind === "cache" && room) ||
          (shortcut.kind === "market" && thin) ||
          shortcut.kind === "stairs")
      ) {
        return take(shortcut);
      }
      // Strong enough to want the harder room, which pays the most experience.
      if (health > 0.8 && elite) return take(elite);
      if (health > 0.68 && highGround) return take(highGround);
      // Middling: take the ordinary room that also has somebody's packs in it.
      if (cache && room) return take(cache);
      if (market && thin) return take(market);
      if (shrine) return take(shrine);
      const safer = paths.filter((path) => {
        const room = roomFor(path);
        return (
          health >= 0.7 ||
          room?.environment !== "spore-cloud" ||
          (path.kind !== "combat" && path.kind !== "elite" && path.kind !== "boss")
        );
      });
      return take(safer.find((p) => p.kind === "unknown") ?? safer[0] ?? paths[0]);
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
            /*
             * A body on the floor overrides the anti-heal rule.
             *
             * `healingIsPunished` exists because some families punish a heal,
             * and defending instead is the right answer for somebody merely
             * hurt. It became the wrong answer the moment a heal was also the
             * way to pick somebody up: the oracle — which is the only policy
             * that can *see* the punishment — started defending while its
             * people bled out, and finished 15% **below** `rule-based` at the
             * 400-day horizon on a guard that requires it to be 20% above.
             *
             * Taking a punishment is strictly better than a permanent death,
             * so a downed ally is raised whatever the enemy does about it. The
             * third time in one day that a baseline had to be taught a mechanic
             * before its number meant anything.
             */
            /*
             * The anti-heal rule does not apply to a body on the floor.
             *
             * `healingIsPunished` exists because some families punish a heal,
             * and defending instead is right for somebody merely hurt. It
             * became wrong the moment a heal was also how you pick somebody up:
             * the oracle — the only policy that can *see* the punishment —
             * defended while its own people bled out.
             *
             * The first attempt at this put a raise ahead of everything, which
             * fixed the symptom and broke the measurement: with four to five
             * deaths a run somebody is nearly always down, so the raise branch
             * fired every round and short-circuited every omniscient decision
             * below it. The oracle and `rule-based` then produced *identical*
             * outcomes — same deaths, same wipe rate, same floor, XP within 1%
             * — which is not an oracle at all.
             *
             * Excluding the downed from the anti-heal branch is the whole fix.
             * `dying` is already the most-hurt ally, and somebody at zero is
             * the most hurt there is, so they are picked up by the ordinary
             * heal on the next line without a special case.
             */
            if (dying && dying.downedAt === null && healingIsPunished(s) && attempt(() => sim.useDefend("cleric"))) {
              continue;
            }
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
            const environment = s.map?.rooms.find((room) => room.id === s.map?.currentRoom)?.environment;
            const spell = bestElement(target, environment, f);
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
/**
 * A rule-based party with one or two members quietly contributing nothing.
 *
 * The scripted floor for what sabotage is worth, and it is deliberately built
 * from omission alone: the traitors take no hostile action, say nothing false
 * and never break a rule. They simply guard, every round, forever — which
 * replaces whatever useful thing the rule-based brain had readied, because
 * `ready()` overwrites a character's queued intent.
 *
 * That is the whole traitor toolkit that needs no new code, and stating it as a
 * baseline is what makes a model run's number readable: a party is only being
 * *deceived* to the extent it does worse than this. What no scripted policy can
 * do is lie or notice a lie, so this brackets the mechanics and says nothing
 * about the social play — that gap is measurable only between model arms.
 */
function saboteurPolicy(): Policy {
  const base = ruleBasedPolicy(false);
  return {
    name: "saboteur",
    act(simulation: Simulation): void {
      base.act(simulation);
      const sim = simulation as Sim;
      const s = sim.view();
      // The loyal half of this party answers a poison, so that `poisoner` is
      // measured against counter-play rather than against nobody. Without it
      // the first vial sweep read +22 points of traitor win from a single free
      // consumable, which was a number about an absent antidote.
      cure(sim, s as DescentState);
      if (s.phase !== "combat") return;
      for (const id of sim.traitorRoles()) {
        if (!s.party[id].dead) attempt(() => sim.useDefend(id));
      }
    },
  };
}

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

/**
 * The ladder for `descent-betrayed`, which is a different game and needs its
 * own.
 *
 * `loyal-party` is `rule-based` with the roll simply ignored — the ceiling for
 * what a party scores when the traitor never acts on it — and `saboteur` is the
 * same party with the traitor withdrawn. The distance between those two rows is
 * what the mechanic costs before anybody has said a word, and any model run
 * should be read against it rather than against `descent`'s numbers.
 *
 * `paranoid-party` — a party that binds the wrong person and pays for it — is
 * missing on purpose. There is nothing to bind with yet.
 */
/**
 * A party that uses the social instruments, honestly, and acts on what they say.
 *
 * The number this exists to produce: **what the instruments are worth before
 * anybody lies.** Every reading is pooled truthfully, every flag is remembered
 * perfectly, and the party binds and executes on the arithmetic. Nothing in
 * here is deception and nothing in here is detection of deception — it is the
 * mechanical ceiling, and a model party that beats it is not playing better,
 * it is playing a different game.
 *
 * That makes the *gap* the interesting quantity in both directions. Below it,
 * a model party is failing to use instruments it was told about. Above it —
 * which is possible — a model party is reading behaviour rather than dice.
 *
 * It deliberately does **not** read `traitorRoles()`. A policy that did would
 * measure nothing at all: the point is what four honest readers can conclude
 * from noisy readings, which is a question with a real answer.
 */
/**
 * Clear a poison, which no baseline party has ever done.
 *
 * Found while sweeping the vial: not one policy in the ladder uses an antidote,
 * ever, so the first measurement of what poison is worth was taken against a
 * party with no counter-play at all and read as a balance number. It is an
 * upper bound, and a fairly meaningless one.
 *
 * Deliberately **not** added to `ruleBasedPolicy`. That policy is one rung of
 * the six-rung ladder `descent` publishes over sixty seeds, and quietly making
 * it better would move every number in `docs/endless-descent.md` with nothing
 * failing to say so. The gap is real and worth closing there too — a party that
 * carries antidotes from drops and never drinks one is leaving damage on the
 * floor — but that is a re-measurement, not a side effect of this file.
 */
function cure(sim: Sim, s: DescentState): void {
  for (const id of CLASSES) {
    const f = s.party[id];
    if (f.dead || !f.statuses.some((st) => st.kind === "poison")) continue;
    const holder = CLASSES.find(
      (c) => !s.party[c].dead && s.party[c].inventory.some((item) => item.baseId === "antidote"),
    );
    if (holder) attempt(() => sim.useItem(holder, "antidote", id));
  }
}

function investigatorPolicy(): Policy {
  const base = ruleBasedPolicy(false);
  /** subject → (dirty readings, clean readings), pooled across every reader. */
  const flags = new Map<ClassId, { dirty: number; clean: number }>();
  /** Who a draught has cleared or damned. A draught does not lie, so this ends the argument. */
  const certain = new Map<ClassId, boolean>();
  let boundTarget: ClassId | undefined;

  const note = (who: ClassId, dirty: boolean) => {
    const cur = flags.get(who) ?? { dirty: 0, clean: 0 };
    if (dirty) cur.dirty += 1;
    else cur.clean += 1;
    flags.set(who, cur);
  };

  return {
    name: "investigator",
    act(simulation: Simulation): void {
      const sim = simulation as Sim;
      const s = sim.view() as DescentState;
      const living = CLASSES.filter((c) => !s.party[c].dead);
      const tools = new Set(sim.sharedTools().map((t) => t.name));

      // Shopping happens *before* the tactical brain, and that ordering is the
      // finding rather than a detail. Run after it, this block bought a draught
      // zero times in forty seeds: `shop()` had already spent the party down on
      // gear, and the median richest purse across floors 1–5 is 150–185 against
      // a shelf price near 350. So 5A was silently untested by its own sweep,
      // and the number that looked like "a party does not value truth" was
      // "a party is asked whether it values truth only after it is broke".
      //
      // Pooled through `give_gold`, which is the same instrument `shop()` uses
      // to reach the best piece of gear. Truth against armour, out of one pot,
      // is precisely the trade this phase exists to measure.
      if (tools.has("drink_draught") && (s.phase === "market" || s.phase === "camp")) {
        const listing = s.stock.find((x) => x.item.baseId === "truth_draught");
        const holding = living.some((c) => s.party[c].inventory.some((i) => i.baseId === "truth_draught"));
        if (listing && !holding) {
          const buyer = living
            .filter((c) => s.party[c].inventory.length < 6)
            .sort((a, b) => s.party[b].gold - s.party[a].gold)[0];
          const pooled = living.reduce((sum, c) => sum + s.party[c].gold, 0);
          if (buyer && pooled >= listing.price) {
            for (const donor of living) {
              if (donor === buyer || s.party[buyer].gold >= listing.price) continue;
              attempt(() =>
                sim.giveGold(donor, buyer, Math.min(s.party[donor].gold, listing.price - s.party[buyer].gold)),
              );
            }
            attempt(() => sim.buyItem(buyer, listing.item.id));
          }
        }
      }

      base.act(simulation);

      // Everybody reads somebody, once a round, cycling the subject. Reading is
      // free and cached per floor, so the party's whole strategy is to cover the
      // matrix and let the noise average across *readers* rather than repeats.
      if (tools.has("size_up")) {
        for (const reader of living) {
          for (const subject of living) {
            if (subject === reader) continue;
            let said = "";
            const ok = attempt(() => {
              said = sim.readFor(reader, subject);
            });
            if (!ok || said.includes("already taken")) continue;
            note(subject, said.includes("hiding something"));
            break;
          }
        }
      }

      // A draught is spent on the current leader in the tally, which is the
      // decision a real party has to make and the one worth measuring: three
      // hundred gold buys certainty about *one* person, and picking the wrong
      // one buys nothing.
      if (tools.has("drink_draught")) {
        // With `reveal=draught` there is no tally to lead, so a strict
        // "score > 0" gate meant the draught arm of the sweep could never fire
        // its own instrument. Falling back to anybody not yet settled is what a
        // party with one certain answer and no evidence would actually do.
        const untested = living.filter((c) => !certain.has(c));
        const ranked = untested
          .map((c) => ({ c, score: (flags.get(c)?.dirty ?? 0) - (flags.get(c)?.clean ?? 0) }))
          .sort((a, b) => b.score - a.score);
        const suspect = ranked.find((r) => r.score > 0) ?? ranked[0];
        if (suspect) {
          for (const drinker of living) {
            if (drinker === suspect.c) continue;
            let said = "";
            if (
              attempt(() => {
                said = sim.drinkDraught(drinker, suspect.c);
              })
            ) {
              certain.set(suspect.c, said.includes("ARE against"));
              break;
            }
          }
        }
      }

      // Acting on it. A draught result is acted on immediately; a tally is acted
      // on only at a margin, because the false-positive rate on a loyal
      // character is real and executing one is the headline error.
      const damned = living.find((c) => certain.get(c) === true);
      const tallied = living
        .filter((c) => certain.get(c) !== false)
        .map((c) => ({ c, score: (flags.get(c)?.dirty ?? 0) - (flags.get(c)?.clean ?? 0) }))
        .sort((a, b) => b.score - a.score);
      const leader = tallied[0];
      const runnerUp = tallied[1];
      const suspect =
        damned ??
        (leader && runnerUp && leader.score >= 4 && leader.score - runnerUp.score >= 3 ? leader.c : undefined);
      if (!suspect || !tools.has("bind")) return;

      if (boundTarget === suspect && s.party[suspect].bound) {
        for (const voter of living) if (voter !== suspect) attempt(() => sim.execute(voter, suspect));
        return;
      }
      for (const voter of living) if (voter !== suspect) attempt(() => sim.bind(voter, suspect));
      if (s.party[suspect].bound) boundTarget = suspect;
    },
  };
}

/**
 * `saboteur`, plus the one move a traitor can make on round one.
 *
 * The distance between this row and `saboteur` is what a vial is worth in
 * experience, which is the question phase 5C was built to answer and the only
 * one a scripted policy can answer at all. It buys more whenever a merchant has
 * them, because the interesting version of the mechanic is the one where a
 * traitor is spending its share of the party's gold on the party.
 */
function poisonerPolicy(): Policy {
  const base = saboteurPolicy();
  return {
    name: "poisoner",
    act(simulation: Simulation): void {
      base.act(simulation);
      const sim = simulation as Sim;
      const s = sim.view() as DescentState;
      const traitors = sim.traitorRoles();
      const marks = CLASSES.filter((c) => !traitors.has(c) && !s.party[c].dead);
      if (marks.length === 0) return;
      for (const id of traitors) {
        if (s.party[id].dead) continue;
        // The healthiest mark, not the weakest: poison is a flow and the cleric
        // will simply undo it on somebody already hurt.
        const mark = marks.slice().sort((a, b) => s.party[b].hp - s.party[a].hp)[0];
        attempt(() => sim.poison(id, mark));
        if (s.phase === "market" || s.phase === "camp") {
          const listing = s.stock.find((x) => x.item.baseId === "venom_vial");
          if (listing && s.party[id].gold >= listing.price) attempt(() => sim.buyItem(id, listing.item.id));
        }
      }
    },
  };
}

export const BETRAYAL_POLICIES: Record<string, () => Policy> = {
  random: randomPolicy,
  "basic-tactics": basicPolicy,
  "greedy-dps": greedyPolicy,
  "tactics-only": tacticalPolicy,
  saboteur: saboteurPolicy,
  poisoner: poisonerPolicy,
  investigator: investigatorPolicy,
  // Renamed rather than reused under its own name: the sweep table labels a row
  // from `policy.name`, so registering `ruleBasedPolicy` here unchanged printed
  // a row called `rule-based` under a key called `loyal-party`, and the two
  // ladders looked like they shared a rung when they do not.
  "loyal-party": () => {
    // `rule-based` plus the one thing it never does, because this ladder has to
    // be able to see what a vial is worth *against a party that answers it*.
    // See `cure` for why the change stops here and does not reach `descent`.
    const base = ruleBasedPolicy(false);
    return {
      name: "loyal-party",
      act(simulation: Simulation): void {
        base.act(simulation);
        cure(simulation as Sim, (simulation as Sim).view() as DescentState);
      },
    };
  },
  oracle: () => ruleBasedPolicy(true),
};
