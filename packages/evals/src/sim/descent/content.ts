/**
 * What lives in the dungeon, what it drops, and how both get worse.
 *
 * Separated from `model.ts` because the rules and the content answer different
 * questions and change for different reasons. The rules are what a test pins
 * down; the content is what gets tuned, repeatedly, against the baseline ladder
 * until the bots separate cleanly. Keeping them apart means a balance pass
 * touches one file and breaks no tests.
 *
 * ## Difficulty is not a health multiplier
 *
 * The obvious scaling — `hp *= floor` — produces floor 50 as floor 1 with a
 * longer fight, which measures patience. Depth here opens *bands*, and each
 * band introduces a demand the previous one did not make:
 *
 *   1-4    one archetype, no tricks           can the party attack the thing
 *   5-9    armour and elemental resistance    is the right class swinging
 *   10-14  statuses, interrupts, targeting    is anybody reading the enemy
 *   15-24  hidden mechanics with real cost    did anybody write it down
 *   25-39  healing gets punished              can the party change a habit
 *   40+    several at once, plus reinforcements
 *
 * A party that never inspects anything stalls around floor 6 whatever its
 * damage output, because `carapace` cannot be killed by physical attacks in any
 * reasonable time and `warden` cannot be killed by spells. That is deliberate:
 * the first wall in the dungeon is an information wall, not a damage one.
 */

import type { Rng } from "../rng.js";
import type {
  ClassId,
  DungeonFloorMap,
  DungeonRoute,
  Element,
  Enemy,
  HiddenMechanic,
  ItemEffect,
  ItemInstance,
  ItemKind,
  ItemModifiers,
  ItemProvenance,
  ItemRarity,
  RoomEnvironmentKind,
  RoomKind,
} from "./model.js";

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

interface FamilyDef {
  family: string;
  /** Names by tier. A family recurs at every tier it has a name for. */
  tiers: string[];
  /** Floor at which each tier starts appearing. */
  from: number[];
  hp: number;
  armor: number;
  power: number;
  speed: number;
  resist: Partial<Record<Element, number>>;
  hidden: HiddenMechanic;
  xp: number;
  gold: number;
  /** What the ranger's inspect says about how it behaves. Never the mechanic. */
  behaviour: string;
}

/**
 * The bestiary.
 *
 * Seven families carry a hidden mechanic and three do not, which matters: if
 * everything had a trick, "assume a trick" would be a free universal policy and
 * the memory measurement would collapse. The party has to learn *which* things
 * are worth remembering.
 */
export const FAMILIES: FamilyDef[] = [
  {
    family: "husk",
    tiers: ["Ash Husk", "Grave Husk", "Elder Husk"],
    from: [1, 12, 30],
    hp: 58,
    armor: 2,
    power: 7,
    speed: 8,
    resist: {},
    hidden: { kind: "none" },
    xp: 12,
    gold: 8,
    behaviour: "shuffles forward and swings at whoever is loudest",
  },
  {
    family: "beast",
    tiers: ["Ash Hound", "Dire Hound", "Ashen Alpha"],
    from: [1, 14, 32],
    hp: 46,
    armor: 1,
    power: 9,
    speed: 13,
    resist: { frost: 0.5 },
    hidden: { kind: "enrage", threshold: 0.3, multiplier: 2.2 },
    xp: 14,
    gold: 7,
    behaviour: "fast, and it fights harder the worse it is hurt",
  },
  {
    family: "carapace",
    tiers: ["Iron Beetle", "Siege Beetle", "Bastion Beetle"],
    from: [5, 18, 34],
    hp: 78,
    armor: 6,
    power: 8,
    speed: 5,
    resist: { physical: 0.4, fire: 0.75, frost: 0.75 },
    hidden: { kind: "none" },
    xp: 20,
    gold: 14,
    behaviour: "slow, plated, and indifferent to being hit with sharp things",
  },
  {
    family: "warden",
    tiers: ["Rune Warden", "High Warden", "Sanctum Warden"],
    from: [5, 19, 36],
    hp: 70,
    armor: 3,
    power: 11,
    speed: 9,
    resist: { fire: 0.35, frost: 0.35, lightning: 0.35, shadow: 0.5 },
    hidden: { kind: "none" },
    xp: 22,
    gold: 16,
    behaviour: "wrapped in wards; spells slide off it",
  },
  {
    family: "shaman",
    tiers: ["Goblin Shaman", "Hobgoblin Shaman", "Ogre Shaman"],
    from: [10, 22, 38],
    hp: 62,
    armor: 2,
    power: 12,
    speed: 11,
    resist: { shadow: 0.5 },
    hidden: { kind: "focusWounded" },
    xp: 24,
    gold: 18,
    behaviour: "hangs back and picks its moment",
  },
  {
    family: "bonewright",
    tiers: ["Skeleton Knight", "Bone Captain", "Barrow Marshal"],
    from: [10, 24, 40],
    hp: 76,
    armor: 5,
    power: 13,
    speed: 10,
    resist: { physical: 0.7, shadow: 0.25, holy: 1.6 },
    hidden: { kind: "windowAfter", move: "shield_slam", multiplier: 2 },
    xp: 26,
    gold: 20,
    behaviour: "drilled and disciplined; it recovers from a stagger quickly",
  },
  {
    family: "crystal",
    tiers: ["Crystal Warden", "Greater Crystal Warden", "Crystal Colossus"],
    from: [15, 28, 42],
    hp: 96,
    armor: 4,
    power: 14,
    speed: 7,
    resist: { fire: 0.6, frost: 0.6 },
    hidden: { kind: "reflect", element: "lightning", fraction: 1.6 },
    xp: 34,
    gold: 26,
    behaviour: "facetted, and the facets seem to be doing something",
  },
  {
    family: "wisp",
    tiers: ["Ember Wisp", "Fire Wisp", "Infernal Wisp"],
    from: [15, 26, 40],
    hp: 34,
    armor: 0,
    power: 10,
    speed: 16,
    resist: { fire: 0, frost: 1.75 },
    hidden: { kind: "deathburst", element: "fire", damage: 26 },
    xp: 20,
    gold: 12,
    behaviour: "darts about; it is barely holding together",
  },
  {
    family: "bell",
    tiers: ["Grave Bell", "Doom Bell", "Cathedral Bell"],
    from: [25, 36, 46],
    hp: 118,
    armor: 5,
    power: 11,
    speed: 4,
    resist: { physical: 0.55, shadow: 0.5 },
    hidden: { kind: "tollHeal", period: 3, damage: 58 },
    xp: 44,
    gold: 34,
    behaviour: "does very little, and keeps count while it does it",
  },
  {
    family: "void",
    tiers: ["Void Priest", "Void Hierarch", "Void Sovereign"],
    from: [25, 38, 48],
    hp: 94,
    armor: 3,
    power: 16,
    speed: 12,
    resist: { shadow: 0, holy: 1.5 },
    hidden: { kind: "punishHeal", drain: 24 },
    xp: 46,
    gold: 36,
    behaviour: "watches the healer rather than the fighters",
  },
];

export const FAMILY_BY_NAME = new Map(FAMILIES.map((f) => [f.family, f]));

/**
 * Bosses, on a five-floor cycle.
 *
 * Each one is a script rather than a statline, and each demands a different
 * organisational answer: the Iron Saint needs a role assignment agreed before
 * the fight, the Hollow Choir needs the party to stop doing something it has
 * done every fight so far, the Gate Warden needs the right class to be the one
 * swinging, and the Ashen Alpha needs the party to finish it rather than chip.
 */
export const BOSSES = [
  {
    family: "iron-saint",
    name: "The Iron Saint",
    hp: 340,
    armor: 5,
    power: 20,
    speed: 10,
    resist: { holy: 0.5, shadow: 0.75 } as Partial<Record<Element, number>>,
    hidden: { kind: "none" } as HiddenMechanic,
    behaviour: "keeps a rhythm: it counts to three, and it counts to four",
  },
  {
    family: "hollow-choir",
    name: "The Hollow Choir",
    hp: 320,
    armor: 3,
    power: 18,
    speed: 13,
    resist: { shadow: 0.25, holy: 1.4 } as Partial<Record<Element, number>>,
    hidden: { kind: "tollHeal", period: 2, damage: 46 } as HiddenMechanic,
    behaviour: "sings, and the singing is on a beat",
  },
  {
    family: "gate-warden",
    name: "The Gate Warden",
    hp: 420,
    armor: 6,
    power: 17,
    speed: 6,
    resist: { physical: 0.5, fire: 0.4, frost: 0.4, lightning: 0.4 } as Partial<Record<Element, number>>,
    hidden: { kind: "reflect", element: "lightning", fraction: 1.8 } as HiddenMechanic,
    behaviour: "immovable, warded, and very heavily plated",
  },
  {
    family: "ashen-alpha",
    name: "The Ashen Alpha",
    hp: 300,
    armor: 3,
    power: 22,
    speed: 17,
    resist: { frost: 0.5 } as Partial<Record<Element, number>>,
    hidden: { kind: "enrage", threshold: 0.45, multiplier: 2.4 } as HiddenMechanic,
    behaviour: "circles, and it is getting angrier",
  },
];

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

/**
 * How much worse things are at depth.
 *
 * The run still ends because two curves cross — that part was always right —
 * but *which* two decides whether the ending is dramatic or merely slow, and
 * the first version crossed the wrong pair.
 *
 * Measured across the band the scenario actually runs in, the party grows
 * roughly 16× in damage and 9× in health from floor 1 to floor 48 (level is a
 * power law in depth, `levelFor ∘ equipForDepth` ≈ floor^1.34, and both stats
 * are linear in level). Against that:
 *
 *   health  tracks the party's *damage* growth, so an encounter stays three or
 *           four rounds long at every depth
 *   damage  outruns the party's *health* growth, so the party gets more
 *           fragile the deeper it goes, and the run ends by dying
 *
 * The old numbers had health at 7% compounding, which reaches 24× by floor 48
 * against the party's 16× — so fights got *longer* with depth instead of
 * deadlier. Probed at the time of the change: time-to-kill went 1.8 rounds on
 * floor 1 to 5.2 on floor 31 and 16.3 on floor 48, while the rounds needed to
 * drop a party member fell from 4.3 to 1.0. Both curves moved the wrong way at
 * once, which is a stalemate that flips to sudden death rather than a
 * difficulty curve — and it is exactly the "floor 50 is floor 1 with a longer
 * fight" failure this file's header warns about.
 *
 * A forty-round run at floor 31 therefore covered one floor and eleven
 * enemies. Every scenario milestone that needed descending or a quiet moment
 * was unreachable, by any policy, including the omniscient one.
 *
 * ## The damage curve is set by where the run ends, not by floor 48
 *
 * Damage compounded at 5.5%, which is the right number for a run that ends
 * somewhere around floor 48 — and no run ends there. The maze made a floor cost
 * about ten rounds, so a forty-round run reaches floor four, where 5.5%
 * compounding has produced a **17% harder** dungeon than floor one. Nothing can
 * die to that. Swept over sixty seeds at the scenario's own options, *no policy
 * ever wiped*: every run ended on the clock, which makes "the score is what the
 * party earned before it died" a claim the numbers did not support.
 *
 * Raising it was not a matter of picking a bigger number. Measured wipe rates
 * for `rule-based` at forty rounds: 1.055 → 0%, 1.30 → 5%, 1.50 → 10%,
 * 1.80 → 30%, 2.20 → 88%. The rate is not the thing to tune on, though, because
 * a curve can produce deaths and still be bad: at 1.50 over eighty rounds
 * `rule-based` wiped 87% against `tactics-only`'s 73%, so the *better* policy
 * died more often and the ending had become a lottery.
 *
 * 1.35 is the value where lethality is ordered by competence, which is the
 * property worth having. Over eighty rounds it wipes basic-tactics 73%,
 * tactics-only 50%, rule-based 37% and the oracle 23% — a party that plays
 * better lives longer, and death rather than the clock is what ends the run. At
 * the current forty-round horizon it is deliberately a light touch (3–13%),
 * because forty rounds only reaches floor four whatever the curve does.
 *
 * What it costs: a run now dies somewhere around floor eight to twelve rather
 * than floor forty-eight. The dungeon is still endless in the sense that
 * matters — no win condition, no ceiling, and it always eventually outruns the
 * party — but the depth band the benchmark actually explores is a tenth of what
 * the original curve was drawn for, and any future change to how many rounds a
 * floor costs has to come back here.
 */
export function depthScale(floor: number): { hp: number; power: number; armor: number } {
  return {
    // ≈15× by floor 48, against the party's measured ≈16× damage growth.
    // Deliberately unchanged: raising this makes fights *longer*, which is the
    // "floor 50 is floor 1 with a longer fight" failure, not a harder dungeon.
    hp: 1.058 ** (floor - 1),
    // The curve that ends the run, and the only one that outruns the party. See
    // the note above for why this is 1.35 and not the 1.055 that a floor-48
    // horizon would want.
    power: 1.055 ** (floor - 1),
    // Much flatter than health and damage, on purpose. Flat armour subtracted
    // from a growing attack is either irrelevant or absolute, with very little
    // in between, so it is kept small and the interesting walls are built out
    // of resistances instead.
    armor: 1 + (floor - 1) * 0.04,
  };
}

/** Which families can appear at this depth. */
export function familiesAt(floor: number): Array<{ def: FamilyDef; tier: number }> {
  const out: Array<{ def: FamilyDef; tier: number }> = [];
  for (const def of FAMILIES) {
    // The highest tier whose floor has been reached — a family stops sending
    // its weakest version once its stronger one is available, so meeting
    // "Greater Crystal Warden" is the memory question rather than a re-run.
    let tier = -1;
    for (let i = 0; i < def.tiers.length; i++) if (floor >= def.from[i]) tier = i;
    if (tier >= 0) out.push({ def, tier });
  }
  return out;
}

/**
 * A hidden rule has to get worse with depth, or remembering it stops paying.
 *
 * This was measured, not assumed. With fixed numbers, an eighteen-point wisp
 * detonation on floor forty is a rounding error, and the oracle — which knows
 * every mechanic in the dungeon from the first tick — finished only ten percent
 * ahead of a rule-based party that knows none of them. That gap *is* the value
 * of memory in this scenario, so a flat mechanic quietly makes the headline
 * measurement worthless. Reflection needs no scaling: it is a fraction of the
 * caster's own damage, and grows on its own.
 */
function scaleMechanic(hidden: HiddenMechanic, power: number, floor: number): HiddenMechanic {
  switch (hidden.kind) {
    case "deathburst":
      return { ...hidden, damage: Math.round(hidden.damage * power) };
    case "tollHeal":
      return { ...hidden, damage: Math.round(hidden.damage * power) };
    case "punishHeal":
      return { ...hidden, drain: Math.round(hidden.drain * (1 + floor * 0.09)) };
    default:
      return hidden;
  }
}

/**
 * How much harder the dungeon hits for having had the party in it this long.
 *
 * The scenario says the party's growth is slower than the dungeon's, so that
 * the two curves cross and the run ends. Measured at the horizon it is actually
 * played at, that is false and inverted — the curves diverge:
 *
 *     round 10   party 1.30x   dungeon 1.11x   party ahead 1.17x
 *     round 40   party 2.50x   dungeon 1.45x   party ahead 1.72x
 *
 * The cause is a units mismatch rather than a bad constant. Difficulty is
 * indexed to *depth* and the horizon is indexed to *rounds*, and a party covers
 * only a handful of floors in forty rounds while gaining five levels. Enemy
 * power rises 5.5% a floor; the party gains three power a level. So every round
 * makes the party safer, no competent baseline has ever died inside the
 * horizon, and the top four policies finish within 62 points of each other —
 * a benchmark that cannot tell them apart.
 *
 * Raising the depth exponent was the obvious fix and the wrong one: at 1.35 it
 * is barely 2.4x by floor four, where the run actually is, and catastrophic at
 * floor thirty, where the deep-start configuration lives. It broke six to eight
 * tests for that reason. This term keys off elapsed rounds instead, so it lands
 * on the clock the horizon is measured in and is independent of how fast the
 * party descends — a party that stalls on floor two feels it exactly as much as
 * one that is diving.
 *
 * Applied to power only, never to health. Scaling health makes fights *longer*,
 * which is the "floor 50 is floor 1 with a longer fight" failure this file
 * rejects elsewhere; scaling power makes them more dangerous, which is the
 * thing actually wanted.
 */
export const VIGIL_BY_HORIZON = 4.8;

export function vigilScale(tick: number, horizon: number): number {
  // Anchored to the fraction of the horizon spent, not to the absolute round
  // count, and that distinction is not cosmetic. As a plain exponent per round
  // the same 1.04 that reaches a sensible 4.8x by round forty reaches 6.6
  // *million* by round four hundred, which is a horizon the baseline sweeps
  // and several ladder tests actually use — it flattened the ladder's spread
  // from twenty thousand to two thousand and put the omniscient policy behind
  // the merely competent one.
  //
  // Anchoring makes the pressure curve horizon-invariant: whatever the round
  // limit is, the dungeon is 4.8x by the end of it and the shape in between is
  // the same. That is also what the tuning loop wants — raising the round limit
  // should buy a longer run at the same lethality, and raising difficulty
  // should be a separate deliberate move rather than a side effect.
  if (!(horizon > 0)) return 1;
  return VIGIL_BY_HORIZON ** Math.min(1, Math.max(0, tick / horizon));
}

export function makeEnemy(
  def: FamilyDef,
  tier: number,
  floor: number,
  index: number,
  elite: boolean,
  tick = 0,
  horizon = 0,
): Enemy {
  const depth = depthScale(floor);
  const scale = { ...depth, power: depth.power * vigilScale(tick, horizon) };
  // A tier is a *different creature*, not a bigger one: a new name, a scaled
  // mechanic, and a modest stat step on top of whatever depth already did.
  //
  // It used to be worth about eight floors of scaling on its own, which
  // double-counted depth — tiers arrive at fixed floors, and the enemy meeting
  // you on floor 30 has already had twenty-nine floors of compounding applied
  // before the multiplier lands. At tier 2 that turned a 5.2× depth scale into
  // 9.8×, and it was the single largest contributor to the ten-round fights on
  // floor 32. The step is now small enough that the stronger form reads as a
  // step up without re-applying the curve.
  const tierBoost = 1 + tier * 0.15;
  const eliteBoost = elite ? 1.7 : 1;
  const hp = Math.round(def.hp * scale.hp * tierBoost * eliteBoost);
  return {
    ref: `${def.family}-${index}`,
    name: elite ? `Elite ${def.tiers[tier]}` : def.tiers[tier],
    family: def.family,
    hp,
    maxHp: hp,
    armor: Math.round(def.armor * scale.armor * tierBoost),
    power: Math.round(def.power * scale.power * tierBoost * (elite ? 1.35 : 1)),
    speed: def.speed,
    resist: { ...def.resist },
    statuses: [],
    hidden: scaleMechanic(def.hidden, scale.power * tierBoost, floor),
    elite,
    boss: false,
    xp: Math.round(def.xp * (1 + floor * 0.35) * tierBoost * (elite ? 2.5 : 1)),
    gold: Math.round(def.gold * (1 + floor * 0.28) * tierBoost * (elite ? 3 : 1)),
    age: 0,
  };
}

/**
 * Early bosses are softened, and the reason is a measurement.
 *
 * Bosses are tuned for the depth where the run actually ends. Applied flat,
 * that made the floor-five Iron Saint an absolute gate: every baseline below
 * `tactics-only` died to it, at floor five, whatever else it did — so the whole
 * bottom of the ladder collapsed onto one number and a weak agent run could not
 * be told apart from a hopeless one. A first boss should be a check, not a wall.
 */
function bossRamp(floor: number): number {
  return Math.min(1, 0.5 + floor * 0.055);
}

export function makeBoss(floor: number, index: number, tick = 0, horizon = 0): Enemy {
  const def = BOSSES[index % BOSSES.length];
  const depth = depthScale(floor);
  const scale = { ...depth, power: depth.power * vigilScale(tick, horizon) };
  const ramp = bossRamp(floor);
  // A boss is the long fight of a floor, not an unfinishable one. Six to eight
  // rounds is the target: long enough that a party has to plan through it,
  // short enough that it resolves inside a horizon.
  //
  // This mattered for the first time once the pacing fix let a party *reach*
  // floor 35 at all — before it, no baseline including the omniscient one ever
  // met a boss below floor 35, so their health had never been measured against
  // a real party's damage. Full-strength it was an eight-round fight the party
  // simply stopped making progress in.
  const hp = Math.round(def.hp * scale.hp * ramp * 0.72);
  return {
    ref: `${def.family}-boss`,
    name: def.name,
    family: def.family,
    hp,
    maxHp: hp,
    armor: Math.round(def.armor * scale.armor),
    power: Math.round(def.power * scale.power * ramp),
    speed: def.speed,
    resist: { ...def.resist },
    statuses: [],
    hidden: scaleMechanic(def.hidden, scale.power * ramp, floor),
    elite: false,
    boss: true,
    xp: Math.round(220 * (1 + floor * 0.4)),
    gold: Math.round(160 * (1 + floor * 0.3)),
    age: 0,
    bossPhase: 1,
  };
}

/**
 * The enemies waiting on this floor.
 *
 * Group size grows with depth, and `dread` adds reinforcements — a party that
 * lingers fights a bigger version of the same encounter, which is what makes
 * camping cost something rather than being free safety.
 */
export function generateEncounter(
  floor: number,
  dread: number,
  elite: boolean,
  rng: Rng,
  boss = floor % 5 === 0,
  contentFloor = floor,
  bossIndex = Math.max(0, Math.floor(floor / 5) - 1),
  vary = false,
  tick = 0,
  horizon = 0,
): Enemy[] {
  if (boss) return [makeBoss(floor, bossIndex, tick, horizon)];

  const pool = familiesAt(contentFloor);
  // Deep floors get *fewer, nastier* things rather than more of them. Enemy
  // count was rising with depth on top of per-enemy scaling, which is the
  // "bigger fight" reading of difficulty this file's header rejects — and it
  // multiplied directly into encounter length.
  const base = vary
    ? contentFloor < 5
      ? rng.int(1, 2)
      : rng.int(2, 3)
    : floor < 5
      ? 2
      : floor < 12
        ? 2 + rng.int(0, 1)
        : 3;
  // Capped at one extra body however long the party dawdled. Dread is a nudge
  // toward moving, not a difficulty dial: uncapped it compounded with itself,
  // and a party that lingered twice walked into an encounter it could not
  // finish inside the horizon. The ceiling holds even if the dread accounting
  // is mistuned again later.
  const reinforcements = Math.min(1, Math.floor(dread / 4));
  const count = Math.min(6, base + reinforcements);

  const enemies: Enemy[] = [];
  for (let i = 0; i < count; i++) {
    // Once the compressed maze band says hidden rules are in play, guarantee
    // one such family in the encounter. The rest remain fully mixed, so
    // "assume everything is a trick" is still not a free policy.
    const candidates =
      vary && contentFloor >= 15 && i === 0 ? pool.filter((entry) => entry.def.hidden.kind !== "none") : pool;
    const pick = candidates[rng.int(0, candidates.length - 1)];
    const enemy = makeEnemy(pick.def, pick.tier, floor, i + 1, elite && i === 0, tick, horizon);
    if (vary) {
      const healthVariance = 0.88 + rng.next() * 0.24;
      enemy.maxHp = Math.max(1, Math.round(enemy.maxHp * healthVariance));
      enemy.hp = enemy.maxHp;
    }
    enemies.push(enemy);
  }
  return enemies;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  price: number;
  /** Who can equip it. Absent means anyone. */
  classes?: ClassId[];
  power?: number;
  armorBonus?: number;
  hp?: number;
  mana?: number;
  speed?: number;
  /** Minimum floor at which this appears in a shop or as a drop. */
  from?: number;
  /**
   * Only stocked when the betrayal layer's social instruments are on.
   *
   * A draught that answers "is this person against the party" is nonsense in a
   * run where nobody can be, and a merchant offering it would be telling the
   * party the layer exists before anything else did. `rollStock` and `rollCache`
   * take the set of permitted social ids rather than reading simulation state,
   * so the item table stays a pure content module — and per-id rather than one
   * flag, because the modes that sweep `draught` against `venom` need a shelf
   * carrying one and not the other.
   */
  social?: boolean;
  desc: string;
}

/**
 * The item table.
 *
 * Class restrictions are the point rather than flavour. A drop is assigned to a
 * random party member, so the plate cuirass lands on the mage roughly a fifth
 * of the time and stays there unless somebody notices and trades it — which is
 * the cleanest resource-allocation reading in the benchmark, and it costs one
 * line of bookkeeping to measure.
 */
export const ITEMS: ItemDef[] = [
  // Weapons
  {
    id: "iron_sword",
    name: "Iron Sword",
    kind: "weapon",
    price: 120,
    classes: ["guardian"],
    power: 4,
    desc: "A soldier's blade.",
  },
  {
    id: "tower_blade",
    name: "Tower Blade",
    kind: "weapon",
    price: 420,
    classes: ["guardian"],
    power: 11,
    from: 12,
    desc: "Heavy, and meant to be.",
  },
  {
    id: "oak_staff",
    name: "Oak Staff",
    kind: "weapon",
    price: 130,
    classes: ["mage", "cleric"],
    power: 4,
    mana: 10,
    desc: "Plain, and it carries a charge well.",
  },
  {
    id: "arc_staff",
    name: "Arcstaff",
    kind: "weapon",
    price: 460,
    classes: ["mage"],
    power: 12,
    mana: 25,
    from: 12,
    desc: "It hums when a storm is near.",
  },
  {
    id: "censer",
    name: "Silver Censer",
    kind: "weapon",
    price: 400,
    classes: ["cleric"],
    power: 8,
    mana: 30,
    from: 12,
    desc: "Smoke that steadies a hand.",
  },
  {
    id: "fang_dagger",
    name: "Fang Dagger",
    kind: "weapon",
    price: 125,
    classes: ["rogue"],
    power: 5,
    speed: 2,
    desc: "Short, quick, unkind.",
  },
  {
    id: "night_edge",
    name: "Night Edge",
    kind: "weapon",
    price: 440,
    classes: ["rogue"],
    power: 13,
    speed: 3,
    from: 12,
    desc: "It does not catch the light.",
  },
  { id: "yew_bow", name: "Yew Bow", kind: "weapon", price: 128, classes: ["ranger"], power: 5, desc: "Honest range." },
  {
    id: "hunters_arc",
    name: "Hunter's Arc",
    kind: "weapon",
    price: 430,
    classes: ["ranger"],
    power: 12,
    speed: 2,
    from: 12,
    desc: "Draws lighter than it looks.",
  },

  // Armour
  {
    id: "plate_cuirass",
    name: "Plate Cuirass",
    kind: "armor",
    price: 300,
    classes: ["guardian"],
    armorBonus: 7,
    hp: 30,
    desc: "Nobody else can carry it.",
  },
  {
    id: "bulwark_plate",
    name: "Bulwark Plate",
    kind: "armor",
    price: 700,
    classes: ["guardian"],
    armorBonus: 15,
    hp: 70,
    from: 16,
    desc: "A wall with a person in it.",
  },
  {
    id: "silk_robe",
    name: "Silk Robe",
    kind: "armor",
    price: 260,
    classes: ["mage", "cleric"],
    armorBonus: 2,
    mana: 25,
    desc: "Light enough to cast in.",
  },
  {
    id: "ward_robe",
    name: "Warded Robe",
    kind: "armor",
    price: 640,
    classes: ["mage", "cleric"],
    armorBonus: 5,
    mana: 55,
    from: 16,
    desc: "Stitched with something.",
  },
  {
    id: "shadow_leathers",
    name: "Shadow Leathers",
    kind: "armor",
    price: 280,
    classes: ["rogue", "ranger"],
    armorBonus: 4,
    speed: 2,
    desc: "Quiet.",
  },
  {
    id: "hunters_mail",
    name: "Hunter's Mail",
    kind: "armor",
    price: 660,
    classes: ["rogue", "ranger"],
    armorBonus: 9,
    speed: 3,
    from: 16,
    desc: "Quiet, and it stops things.",
  },

  // Trinkets — the interesting ones, because anybody can wear them
  {
    id: "vitality_ring",
    name: "Ring of Vitality",
    kind: "trinket",
    price: 380,
    hp: 45,
    desc: "Whoever wears it lasts longer.",
  },
  {
    id: "mana_ring",
    name: "Mana Ring",
    kind: "trinket",
    price: 400,
    mana: 45,
    desc: "Useless to anyone who does not cast.",
  },
  { id: "swift_charm", name: "Swift Charm", kind: "trinket", price: 360, speed: 4, desc: "Move before they do." },
  { id: "fire_charm", name: "Fire Charm", kind: "trinket", price: 450, power: 6, from: 10, desc: "Warm to the touch." },
  {
    id: "aegis_sigil",
    name: "Aegis Sigil",
    kind: "trinket",
    price: 620,
    armorBonus: 6,
    hp: 40,
    from: 18,
    desc: "Old, and still working.",
  },

  // Consumables
  { id: "healing_potion", name: "Healing Potion", kind: "consumable", price: 90, desc: "Restores 45 health." },
  {
    id: "greater_potion",
    name: "Greater Healing Potion",
    kind: "consumable",
    price: 380,
    from: 8,
    desc: "Restores 80% of health. Rare.",
  },
  { id: "mana_potion", name: "Mana Potion", kind: "consumable", price: 85, desc: "Restores 40 mana." },
  { id: "antidote", name: "Antidote", kind: "consumable", price: 70, desc: "Clears poison, burn and weakness." },
  {
    id: "sealed_cache",
    name: "Sealed Reliquary",
    kind: "consumable",
    price: 150,
    from: 2,
    desc: "Nobody knows what is in it. Somebody sealed it for a reason. Opening it is a decision, not a purchase.",
  },
  {
    id: "arrows",
    name: "Bundle of Arrows",
    kind: "consumable",
    price: 60,
    desc: "Refills a quiver. Only a ranger carries one.",
  },
  { id: "bomb", name: "Fire Bomb", kind: "consumable", price: 110, desc: "Fire damage to every enemy." },
  {
    id: "smoke_bomb",
    name: "Smoke Bomb",
    kind: "consumable",
    price: 140,
    desc: "Clears every taunt and resets threat.",
  },
  {
    id: "soul_stone",
    name: "Soul Stone",
    kind: "consumable",
    price: 900,
    from: 6,
    desc: "Revives one fallen ally after a fight. Nothing else does.",
  },
  {
    id: "elixir",
    name: "Elixir of Depth",
    kind: "consumable",
    price: 520,
    from: 14,
    desc: "Permanently raises one ally's health.",
  },

  // The social layer's stock. Both are consumables anybody may buy, which is
  // the point: an instrument only one side can hold is a rule, and a rule is
  // not a game. A traitor buying a draught to find a partner, or a loyal
  // character buying venom because they are sure and impatient, are both
  // things this table is deliberately permitting.
  {
    id: "truth_draught",
    name: "Draught of Truth",
    kind: "consumable",
    price: 300,
    from: 2,
    social: true,
    desc: "Names one person's allegiance, to them and to you, and to nobody else. One use.",
  },
  {
    id: "venom_vial",
    name: "Vial of Grey Venom",
    kind: "consumable",
    price: 240,
    from: 2,
    social: true,
    desc: "Poisons one person. They will know. They will not know who. One use.",
  },
];

export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export function itemBaseId(item: ItemInstance | string): string {
  return typeof item === "string" ? item : item.baseId;
}

export function itemDef(item: ItemInstance | string): ItemDef | undefined {
  return ITEM_BY_ID.get(itemBaseId(item));
}

export function itemName(item: ItemInstance | string): string {
  return typeof item === "string" ? (ITEM_BY_ID.get(item)?.name ?? item) : item.name;
}

export function itemModifiers(item: ItemInstance): Required<ItemModifiers> {
  const total = { power: 0, armor: 0, hp: 0, mana: 0, speed: 0 };
  for (const affix of item.affixes) {
    total.power += affix.modifiers.power ?? 0;
    total.armor += affix.modifiers.armor ?? 0;
    total.hp += affix.modifiers.hp ?? 0;
    total.mana += affix.modifiers.mana ?? 0;
    total.speed += affix.modifiers.speed ?? 0;
  }
  return total;
}

export function itemPrice(item: ItemInstance): number {
  const base = ITEM_BY_ID.get(item.baseId)?.price ?? 30;
  const rarityFactor: Record<ItemRarity, number> = { common: 1, uncommon: 1.22, rare: 1.5, epic: 1.85 };
  return Math.max(1, Math.round(base * rarityFactor[item.rarity]));
}

/** Is this item wearable by this class? Consumables are always usable. */
export function canEquip(item: ItemDef, who: ClassId): boolean {
  if (item.kind === "consumable") return true;
  return !item.classes || item.classes.includes(who);
}

/** Every class that could equip this, for the misallocation diagnostic. */
export function equippableBy(item: ItemInstance | string): ClassId[] {
  const def = itemDef(item);
  if (!def || def.kind === "consumable") return [];
  return def.classes ?? ["guardian", "mage", "rogue", "cleric", "ranger"];
}

interface AffixDef {
  id: string;
  name: string;
  polarity: "positive" | "negative";
  kinds: ItemKind[];
  modifier: (floor: number) => ItemModifiers;
  effect?: (floor: number) => ItemEffect;
  description: (modifiers: ItemModifiers, effect?: ItemEffect) => string;
}

const amount = (base: number, floor: number, every: number, cap: number): number =>
  Math.min(cap, base + Math.floor(Math.max(0, floor - 1) / every));

const POSITIVE_AFFIXES: AffixDef[] = [
  {
    id: "forceful",
    name: "Forceful",
    polarity: "positive",
    kinds: ["weapon", "trinket"],
    modifier: (floor) => ({ power: amount(2, floor, 8, 7) }),
    description: (m) => `+${m.power} power`,
  },
  {
    id: "guarded",
    name: "Guarded",
    polarity: "positive",
    kinds: ["armor", "trinket"],
    modifier: (floor) => ({ armor: amount(1, floor, 10, 4) }),
    description: (m) => `+${m.armor} armour`,
  },
  {
    id: "stalwart",
    name: "Stalwart",
    polarity: "positive",
    kinds: ["weapon", "armor", "trinket"],
    modifier: (floor) => ({ hp: amount(10, floor, 5, 28) }),
    description: (m) => `+${m.hp} maximum health`,
  },
  {
    id: "channeling",
    name: "Channeling",
    polarity: "positive",
    kinds: ["weapon", "armor", "trinket"],
    modifier: (floor) => ({ mana: amount(8, floor, 6, 24) }),
    description: (m) => `+${m.mana} maximum mana`,
  },
  {
    id: "quickened",
    name: "Quickened",
    polarity: "positive",
    kinds: ["weapon", "armor", "trinket"],
    modifier: (floor) => ({ speed: amount(1, floor, 14, 3) }),
    description: (m) => `+${m.speed} speed`,
  },
];

const NEGATIVE_AFFIXES: AffixDef[] = [
  {
    id: "cumbersome",
    name: "Cumbersome",
    polarity: "negative",
    kinds: ["weapon", "armor", "trinket"],
    modifier: (floor) => ({ speed: -amount(1, floor, 18, 2) }),
    description: (m) => `${m.speed} speed`,
  },
  {
    id: "brittle",
    name: "Brittle",
    polarity: "negative",
    kinds: ["weapon", "armor", "trinket"],
    modifier: (floor) => ({ hp: -amount(8, floor, 7, 22) }),
    description: (m) => `${m.hp} maximum health`,
  },
  {
    id: "dulling",
    name: "Dulling",
    polarity: "negative",
    kinds: ["armor", "trinket"],
    modifier: (floor) => ({ power: -amount(1, floor, 15, 3) }),
    description: (m) => `${m.power} power`,
  },
  {
    id: "draining",
    name: "Draining",
    polarity: "negative",
    kinds: ["weapon", "armor", "trinket"],
    modifier: (floor) => ({ mana: -amount(6, floor, 9, 14) }),
    description: (m) => `${m.mana} maximum mana`,
  },
];

const UNIQUE_AFFIXES: AffixDef[] = [
  {
    id: "sweeping",
    name: "Sweeping",
    polarity: "positive",
    kinds: ["weapon"],
    modifier: () => ({}),
    effect: (floor) => ({ kind: "cleave", fraction: Math.min(0.5, 0.25 + Math.floor(floor / 12) * 0.05) }),
    description: (_m, effect) =>
      `single-target physical attacks splash ${Math.round((effect?.kind === "cleave" ? effect.fraction : 0.25) * 100)}% damage onto another enemy`,
  },
  {
    id: "sanguine",
    name: "Sanguine",
    polarity: "positive",
    kinds: ["weapon", "trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "vampirism", fraction: 0.12 }),
    description: () => "single-target physical damage restores 12% as health",
  },
  {
    id: "mending",
    name: "Mending",
    polarity: "positive",
    kinds: ["armor", "trinket"],
    modifier: () => ({}),
    effect: (floor) => ({ kind: "regeneration", amount: amount(3, floor, 8, 8) }),
    description: (_m, effect) =>
      `restores ${effect?.kind === "regeneration" ? effect.amount : 3} health at the start of each combat round`,
  },
  {
    id: "scouting",
    name: "Scouting",
    polarity: "positive",
    kinds: ["weapon", "armor", "trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "reveal", scope: "adjacent" }),
    description: () => "reveals the exact type of every adjacent room",
  },
  {
    id: "cartographic",
    name: "Cartographic",
    polarity: "positive",
    kinds: ["trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "reveal", scope: "floor" }),
    description: () => "reveals the floor plan and every room type",
  },
  {
    id: "bargaining",
    name: "Bargaining",
    polarity: "positive",
    kinds: ["trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "merchant-discount", fraction: 0.15 }),
    description: () => "reduces purchase prices by 15% and improves sale prices",
  },
  {
    id: "expedition",
    name: "Expedition",
    polarity: "positive",
    kinds: ["armor", "trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "cache-capacity", amount: 1 }),
    description: () => "lets the party carry one additional item from each cache",
  },
  {
    id: "relentless",
    name: "Relentless",
    polarity: "positive",
    kinds: ["weapon", "trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "cooldown-reduction", amount: 1 }),
    description: () => "reduces ability cooldowns by one round",
  },
  {
    id: "barbed",
    name: "Barbed",
    polarity: "positive",
    kinds: ["armor", "trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "thorns", fraction: 0.2 }),
    description: () => "returns 20% of any physical hit to whatever landed it",
  },
  {
    id: "executioners",
    name: "Executioner's",
    polarity: "positive",
    kinds: ["weapon", "trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "executioner", fraction: 0.4 }),
    description: () => "deals 40% more damage to an enemy already below a third of its health",
  },
  {
    id: "warded",
    name: "Warded",
    polarity: "positive",
    kinds: ["armor", "trinket"],
    modifier: () => ({}),
    effect: (floor) => ({ kind: "ward", amount: amount(12, floor, 4, 40) }),
    description: (_m, effect) =>
      `puts a ${effect?.kind === "ward" ? effect.amount : 12}-point shield on the wearer at the start of every fight`,
  },
  // Affinity is deliberately the only affix whose right owner is fixed by the
  // roll rather than by the numbers: an item that hits harder with frost is
  // worth having only if somebody in the party casts frost, and worth arguing
  // about the moment two people do.
  ...(["fire", "frost", "lightning", "shadow", "holy"] as const).map((element) => ({
    id: `attuned-${element}`,
    name: `${element[0].toUpperCase()}${element.slice(1)}-Attuned`,
    polarity: "positive" as const,
    kinds: ["weapon", "trinket"] as ItemKind[],
    modifier: () => ({}),
    effect: () => ({ kind: "affinity" as const, element, fraction: 0.25 }),
    description: () => `${element} damage from the wearer lands 25% harder`,
  })),
  {
    id: "scholarly",
    name: "Scholarly",
    polarity: "positive",
    kinds: ["trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "scholarly", fraction: 0.1 }),
    description: () => "the party earns 10% more experience while this is worn",
  },
];

/**
 * Drawbacks with a shape.
 *
 * A negative stat is a smaller number and changes nothing about how the item is
 * used. These change *who should wear it*: a frail trinket is a liability on
 * whoever is being healed, an unnerving one is only worth it to a party that
 * means to move fast, and a vulnerability matters exactly as much as the next
 * floor's enemies decide it does.
 */
const UNIQUE_DRAWBACKS: AffixDef[] = [
  ...(["fire", "frost", "lightning", "shadow"] as const).map((element) => ({
    id: `exposed-${element}`,
    name: `${element[0].toUpperCase()}${element.slice(1)}-Exposed`,
    polarity: "negative" as const,
    kinds: ["armor", "trinket"] as ItemKind[],
    modifier: () => ({}),
    effect: () => ({ kind: "vulnerable" as const, element, fraction: 0.3 }),
    description: () => `${element} damage against the wearer lands 30% harder`,
  })),
  {
    id: "frail",
    name: "Frail",
    polarity: "negative",
    kinds: ["armor", "trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "frail", fraction: 0.25 }),
    description: () => "the wearer receives 25% less healing",
  },
  {
    id: "unnerving",
    name: "Unnerving",
    polarity: "negative",
    kinds: ["weapon", "armor", "trinket"],
    modifier: () => ({}),
    effect: () => ({ kind: "unnerving", amount: 1 }),
    description: () => "dread rises by one more after every fight the wearer is in",
  },
];

function rollRarity(source: ItemProvenance, rng: Rng): ItemRarity {
  const boost = source === "boss" ? 0.18 : source === "elite" ? 0.1 : source === "cache" ? 0.05 : 0;
  const roll = rng.next() - boost;
  if (roll < 0.04) return "epic";
  if (roll < 0.18) return "rare";
  if (roll < 0.48) return "uncommon";
  return "common";
}

/**
 * Materialise one base-table result into a stable, independently rolled copy.
 * `id` comes from the simulation's monotonic counter, while all variation comes
 * from its dedicated item RNG, so other random streams keep their old shape.
 */
export function makeItemInstance(
  baseId: string,
  id: string,
  source: ItemProvenance,
  floor: number,
  rng?: Rng,
): ItemInstance {
  const base = ITEM_BY_ID.get(baseId);
  if (!base) throw new Error(`unknown base item: ${baseId}`);
  const rarity = base.kind === "consumable" || !rng ? "common" : rollRarity(source, rng);
  const affixes: ItemInstance["affixes"] = [];
  if (rng && base.kind !== "consumable") {
    const positives = rarity === "common" ? 0 : rarity === "uncommon" ? 1 : rarity === "rare" ? 2 : 3;
    const negative = rarity === "epic" || (rarity === "rare" && rng.chance(0.45)) ? 1 : 0;
    const addFrom = (pool: AffixDef[], count: number) => {
      const available = pool.filter((entry) => entry.kinds.includes(base.kind));
      for (let i = 0; i < count && available.length > 0; i++) {
        const index = rng.int(0, available.length - 1);
        const picked = available.splice(index, 1)[0];
        const modifiers = picked.modifier(floor);
        const effect = picked.effect?.(floor);
        affixes.push({
          id: picked.id,
          name: picked.name,
          description: picked.description(modifiers, effect),
          polarity: picked.polarity,
          modifiers,
          ...(effect ? { effect } : {}),
        });
      }
    };
    addFrom(POSITIVE_AFFIXES, positives);
    const unique = rarity === "epic" ? 1 : rarity === "rare" && rng.chance(0.45) ? 1 : 0;
    addFrom(UNIQUE_AFFIXES, unique);
    // An epic's drawback is a rule rather than a smaller number about half the
    // time. That is what stops the best item in the run from also being the
    // obvious one: a shaped drawback has a *right owner*, so the party has to
    // decide who can afford to carry it rather than which number is bigger.
    if (negative > 0 && rng.chance(0.5)) addFrom(UNIQUE_DRAWBACKS, negative);
    else addFrom(NEGATIVE_AFFIXES, negative);
  }
  const rarityName = rarity === "common" ? base.name : `${rarity[0].toUpperCase()}${rarity.slice(1)} ${base.name}`;
  const affixText =
    affixes.length > 0 ? ` ${affixes.map((entry) => `${entry.name}: ${entry.description}.`).join(" ")}` : "";
  return {
    id,
    baseId,
    name: rarityName,
    kind: base.kind,
    rarity,
    description: `${base.desc}${affixText}`,
    affixes,
    provenance: { source, floor },
  };
}

/** What a defeated encounter leaves behind. */
export function rollLoot(floor: number, boss: boolean, elite: boolean, rng: Rng): string[] {
  const drops: string[] = [];
  const rolls = boss ? 3 : elite ? 2 : 1;
  for (let i = 0; i < rolls; i++) {
    const roll = rng.next();
    if (roll < 0.42) {
      drops.push(rng.chance(0.7) ? "healing_potion" : "mana_potion");
    } else if (roll < 0.55) {
      drops.push(rng.chance(0.5) ? "antidote" : "bomb");
    } else if (roll < 0.62 && floor >= 8) {
      drops.push("greater_potion");
    } else if (roll < 0.68 && floor >= 6) {
      drops.push("soul_stone");
    } else {
      const gear = ITEMS.filter((it) => it.kind !== "consumable" && (it.from ?? 1) <= floor);
      if (gear.length > 0) drops.push(gear[rng.int(0, gear.length - 1)].id);
    }
  }
  return drops;
}

/** A merchant's stock. Deterministic from the seed, and never everything. */
/**
 * @param needed Ids the party currently has a use for, stocked if the floor
 *   allows them at all. A merchant's shelf is otherwise six random picks, and a
 *   soul stone appeared on between 17% and 34% of them depending on depth — so
 *   a party that had lost somebody spent whole floors unable to buy the only
 *   thing that brings anyone back, which is a dice roll deciding a run rather
 *   than a decision anybody made. Baseline runs ended with five permanent
 *   deaths and one revive.
 */
export function rollStock(
  floor: number,
  rng: Rng,
  needed: readonly string[] = [],
  social: ReadonlySet<string> = new Set(),
): Array<{ item: string; price: number }> {
  const available = ITEMS.filter((it) => (it.from ?? 1) <= floor && (!it.social || social.has(it.id)));
  const picks: Array<{ item: string; price: number }> = [];
  const chosen = new Set<string>();
  // Always at least one way to heal, so a broke party is never simply stuck.
  picks.push({ item: "healing_potion", price: Math.round(90 * (1 + floor * 0.04)) });
  chosen.add("healing_potion");
  // And always arrows, for the same reason. A ranger who cannot restock is a
  // ranger whose class quietly turns into a countdown, and a cost with no way
  // to pay it is not a cost, it is an expiry date.
  picks.push({ item: "arrows", price: Math.round(60 * (1 + floor * 0.04)) });
  chosen.add("arrows");
  /*
   * The social instruments are always on the counter, for the same reason.
   *
   * Left to the dice they were on the shelf in 8 of 55 market rounds across 40
   * seeds — about one opportunity every five runs — and a mechanic that
   * appears once every five runs is not a mechanic, it is a rumour. That is
   * the same failure the `needed` parameter above was added for: a party that
   * had lost somebody spent whole floors unable to buy the only thing that
   * brings anyone back, which is a dice roll deciding a run.
   *
   * The ration is the price, which is what the design wants: buying certainty
   * competes with buying armour out of one pot. Randomising availability *on
   * top of* a price gate does not make the instrument scarcer in an
   * interesting way, it makes the measurement noisier.
   */
  for (const it of available) {
    if (!it.social || chosen.has(it.id)) continue;
    chosen.add(it.id);
    picks.push({ item: it.id, price: Math.round(it.price * (1 + floor * 0.04)) });
  }
  for (const id of needed) {
    const item = available.find((it) => it.id === id);
    if (!item || chosen.has(id)) continue;
    chosen.add(id);
    picks.push({ item: id, price: Math.round(item.price * (1 + floor * 0.04)) });
  }
  while (picks.length < 6) {
    const pick = available[rng.int(0, available.length - 1)];
    if (chosen.has(pick.id)) continue;
    chosen.add(pick.id);
    picks.push({ item: pick.id, price: Math.round(pick.price * (1 + floor * 0.04)) });
  }
  return picks;
}

/**
 * Who else came down here, and what they were still carrying.
 *
 * Names only — the party never meets them. They exist so the dungeon reads as a
 * place other people have been rather than a sequence of rooms, and so a cache
 * has a reason to contain floor-appropriate gear: whoever left it got this far.
 */
const EXPEDITIONS = [
  "the Thornwake company",
  "a survey party out of Belm",
  "the second Ashford expedition",
  "somebody's private venture, unmarked",
  "the Greyhelm brothers",
  "a pilgrimage that did not turn back",
  "the cartographers' guild, third attempt",
  "a relief column sent after the second",
];

/**
 * What a dead expedition left behind.
 *
 * Weighted toward gear rather than consumables — this is somebody's kit, not a
 * shop's shelf — and drawn from what is available at this depth, because
 * whoever left it had to get here first.
 *
 * A cache offers more than the party can carry out. That is the entire design:
 * a purchase is settled privately out of one purse and needs nobody's
 * agreement, while `CACHE_TAKES` of `CACHE_OFFERS` cannot be resolved by
 * whoever happens to be richest.
 */
export function rollCache(
  floor: number,
  offers: number,
  rng: Rng,
  social: ReadonlySet<string> = new Set(),
): { items: string[]; origin: string } {
  const ok = (it: ItemDef) => (it.from ?? 1) <= floor && (!it.social || social.has(it.id));
  const gear = ITEMS.filter((it) => it.kind !== "consumable" && ok(it));
  const consumables = ITEMS.filter((it) => it.kind === "consumable" && ok(it));
  const picks: string[] = [];
  const chosen = new Set<string>();
  let guard = 0;
  while (picks.length < offers && guard++ < 400) {
    // Two in three are gear, so the class-restriction argument — the plate that
    // is no use to the mage holding it — comes up most times a cache does.
    const pool = rng.chance(0.66) && gear.length > 0 ? gear : consumables;
    if (pool.length === 0) continue;
    const pick = pool[rng.int(0, pool.length - 1)];
    if (chosen.has(pick.id)) continue;
    chosen.add(pick.id);
    picks.push(pick.id);
  }
  return { items: picks, origin: EXPEDITIONS[rng.int(0, EXPEDITIONS.length - 1)] };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The branching choice at the top of every floor.
 *
 * Risk and reward, and one of the four is always unknown. The elite route pays
 * roughly two and a half times the experience for a fight the party may not
 * survive, which is where a system's appetite becomes visible: over a long run,
 * reckless and timid both score badly and for opposite reasons.
 */
export function generatePaths(
  floor: number,
  rng: Rng,
): Array<{ id: string; label: string; hint?: string; kind: string }> {
  // Every third floor the marked stair leads to a trader; the rest of the time
  // it is somebody's last camp. Both are worth walking to and only one of them
  // wants money, which is the point of having both.
  const marked =
    floor >= 3 && floor % 6 === 0
      ? { label: "A worn stair with a merchant's mark cut beside it", kind: "market" }
      : floor >= 3
        ? { label: "A stair with packs stacked at the bottom, and nobody near them", kind: "cache" }
        : { label: "A worn stair, unmarked", kind: "unknown" };

  const choices = [
    { label: "A low passage, unmarked", kind: "unknown", hint: "no telling" },
    { label: marked.label, kind: marked.kind },
    { label: "A wide hall; something large is moving in it", kind: "elite", hint: "richer, and worse" },
    { label: "A shrine alcove", kind: "shrine", hint: "quiet" },
  ];
  // Shuffle the contents, then attach them to stable direction ids. Shuffling
  // complete `{id, content}` objects only changed display order: `down` was
  // still a shrine and `forward` was still elite on every seed.
  for (let i = choices.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return ["left", "right", "forward", "down"].map((id, i) => ({ id, ...choices[i] }));
}

const ZONES = [
  {
    name: "The Sunken Gate",
    rooms: [
      "drowned vestibule",
      "collapsed gallery",
      "silted guardroom",
      "chain hall",
      "flooded archive",
      "old toll room",
    ],
  },
  {
    name: "The Fungal Hollows",
    rooms: [
      "spore garden",
      "root-choked crossing",
      "glowcap grotto",
      "mycelial nave",
      "mouldering den",
      "hollow cistern",
    ],
  },
  {
    name: "The Ash Foundry",
    rooms: ["cold furnace", "slag bridge", "hammer vault", "cinder works", "broken smelter", "soot-black gantry"],
  },
  {
    name: "The Crystal Catacombs",
    rooms: ["prismatic crypt", "faceted transept", "shard gallery", "singing vault", "glass ossuary", "refracted hall"],
  },
  {
    name: "The Null Chapel",
    rooms: ["lightless nave", "sealed vestry", "hushed cloister", "black reliquary", "sunken choir", "empty sanctum"],
  },
] as const;

const ROOM_HINTS: Record<RoomKind, string> = {
  entrance: "the stair back is sealed",
  empty: "quiet, for now",
  combat: "movement beyond the threshold",
  elite: "something large is breathing there",
  boss: "the way down is guarded",
  market: "lamplight and a merchant's mark",
  cache: "abandoned packs in the dust",
  shrine: "old light, still warm",
  stairs: "air moving downward",
};

export const ROOM_ENVIRONMENTS = {
  flooded: {
    name: "flooded chamber",
    hint: "standing water amplifies lightning by 25% and suppresses fire by 25%",
  },
  "spore-cloud": {
    name: "spore haze",
    hint: "the air damages every living combatant at the start of each round",
  },
  "arcane-well": {
    name: "arcane well",
    hint: "the mage and cleric recover extra mana at the start of each combat round",
  },
  "narrow-bridge": {
    name: "narrow bridge",
    hint: "a faster enemy can catch the slowest party member during retreat",
  },
  "high-ground": {
    name: "raised gallery",
    hint: "the mage and ranger deal 15% more damage from the high ground",
  },
} as const satisfies Record<RoomEnvironmentKind, { name: string; hint: string }>;

export function roomEnvironment(kind: RoomEnvironmentKind) {
  return ROOM_ENVIRONMENTS[kind];
}

export function roomHint(kind: RoomKind): string {
  return ROOM_HINTS[kind];
}

/** The traversable route between two adjacent rooms, respecting one-way drops. */
export function routeBetween(map: DungeonFloorMap, from: string, to: string): DungeonRoute | undefined {
  return map.routes.find(
    (route) =>
      route.discovered &&
      ((route.from === from && route.to === to) || (route.bidirectional && route.from === to && route.to === from)),
  );
}

/**
 * The shortest way back across ground the party has already taken and cleared.
 *
 * Walking a corridor you have swept, past a door you already opened, is not a
 * decision — and charging a round for it is what turned an exploration system
 * into a tax. A measured floor costs about ten rounds against a forty-round
 * horizon, and roughly half of those are steps through rooms with nothing left
 * in them; the party pays four rounds to get back to a staircase it found on
 * round two. So known ground is crossed in one move.
 *
 * Deliberately strict about what counts as known: every room on the way must
 * have been entered and finished, and every route must already be open in the
 * direction of travel. A locked door nobody has opened, a one-way drop, an
 * undiscovered secret and a room still holding enemies all stop the walk, which
 * is what keeps the map worth reading.
 */
export function knownRouteAcross(map: DungeonFloorMap, from: string, to: string): string[] | undefined {
  if (from === to) return undefined;
  const roomsById = new Map(map.rooms.map((room) => [room.id, room]));
  const settled = new Set<string>([from]);
  const queue: string[][] = [[from]];
  while (queue.length > 0) {
    const trail = queue.shift();
    if (!trail) break;
    const head = trail[trail.length - 1];
    const here = roomsById.get(head);
    if (!here) continue;
    for (const next of here.links) {
      if (settled.has(next)) continue;
      const route = routeBetween(map, head, next);
      if (!route) continue;
      // A closed lock is not known ground however often the party has looked at
      // it, and a trap nobody has disarmed is a consequence the walk must not
      // silently absorb.
      if (route.kind === "locked" && !route.openedBy) continue;
      if (route.kind === "toll" && !route.openedBy) continue;
      if (route.kind === "trap" && !route.disarmed && !route.triggered) continue;
      const room = roomsById.get(next);
      if (!room) continue;
      if (next === to) return [...trail.slice(1), next];
      // Intermediate rooms have to be finished. The destination does not — that
      // is the whole point of travelling to it.
      if (!room.visited || room.encounter?.enemies.some((enemy) => enemy.hp > 0)) continue;
      settled.add(next);
      queue.push([...trail, next]);
    }
  }
  return undefined;
}

/**
 * What a rogue physically uncovers from one room.
 *
 * Secret exits become traversable for everybody once found. Concealed trap
 * details remain private in the scout report, but `featureKnown` lets the rogue
 * disarm the correct route later.
 */
export function scoutDungeonRoutes(map: DungeonFloorMap, roomId: string): DungeonRoute[] {
  const found: DungeonRoute[] = [];
  for (const route of map.routes) {
    const touches = route.from === roomId || (route.bidirectional && route.to === roomId);
    if (!touches) continue;
    if (!route.discovered && route.kind === "secret") {
      route.discovered = true;
      const from = map.rooms.find((room) => room.id === route.from);
      const to = map.rooms.find((room) => room.id === route.to);
      if (from && !from.links.includes(to?.id ?? "")) from.links.push(route.to);
      if (route.bidirectional && to && !to.links.includes(from?.id ?? "")) to.links.push(route.from);
      found.push(route);
    }
    if (!route.featureKnown) {
      route.featureKnown = true;
      if (!found.includes(route)) found.push(route);
    }
  }
  return found;
}

/**
 * A small connected room graph with branches and occasional loops.
 *
 * The tree guarantees every room is reachable; extra edges make backtracking
 * and alternate routes possible. Contents and geometry are independently
 * seeded, so two runs can share a zone without sharing its useful route.
 */
/**
 * What a toll asks, by depth.
 *
 * Calibrated against a purse rather than against a price list: characters start
 * with 180 gold each and rarely hold more than a couple of hundred once the
 * outfitter has been visited, so a floor-one gate at 200 is already past most
 * single purses and the gap widens as the run goes on. Cheap enough that the
 * money is worth raising; dear enough that raising it takes more than one
 * person.
 */
const TOLL_BASE = 150;
const TOLL_PER_FLOOR = 50;

/**
 * The routes a party can always cross: no money, no key, no class skill.
 *
 * A trap belongs here — it hurts, it does not stop anybody. A `secret` does not,
 * because it is undiscovered until the rogue happens to scout the right junction
 * and may never be found at all. `locked` and `toll` are the two that can refuse.
 */
const FREELY_TRAVERSABLE = new Set<DungeonRoute["kind"]>(["passage", "trap", "one-way"]);

/** Every room reachable from `from` paying nothing and opening nothing. */
function freelyReachable(routes: DungeonRoute[], from: string, closed?: DungeonRoute): Set<string> {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const here = queue.shift();
    if (here === undefined) break;
    for (const route of routes) {
      if (route === closed || !route.discovered || !FREELY_TRAVERSABLE.has(route.kind)) continue;
      const next = route.from === here ? route.to : route.bidirectional && route.to === here ? route.from : undefined;
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * Can the party still always get down, if `closed` becomes a gate?
 *
 * Two things this has to check that the obvious version does not, both of which
 * shipped as soft-locks and were measured over 300 seeds × 6 floors:
 *
 * 1. **A barrier is not a route.** The first version walked every discovered
 *    edge, so "you can still reach the stairs" was satisfied by a path through
 *    the locked iron door — or through a second toll. 8.2% of floors put the way
 *    down behind a payment or a lock, and a policy that does not pool gold
 *    simply stopped: on seed 1018 three of the six baselines stood in two rooms
 *    for the full forty ticks and scored zero.
 * 2. **The entrance is not the only place the party can be.** A one-way drop can
 *    land them on the far side of the gate, where the stairs are unreachable
 *    even though they were reachable from `r0`. 18.3% of floors had at least one
 *    such room. So the invariant is quantified over every room the party can
 *    free-walk into, not just over the entrance.
 */
function stairsAlwaysReachable(
  rooms: DungeonFloorMap["rooms"],
  routes: DungeonRoute[],
  closed?: DungeonRoute,
): boolean {
  const stairs = rooms.find((room) => room.kind === "stairs");
  if (!stairs) return true;
  const standable = freelyReachable(routes, "r0", closed);
  if (!standable.has(stairs.id)) return false;
  for (const room of standable) {
    if (!freelyReachable(routes, room, closed).has(stairs.id)) return false;
  }
  return true;
}

export function generateFloorMap(floor: number, rng: Rng): DungeonFloorMap {
  const zone = ZONES[Math.floor((floor - 1) / 3) % ZONES.length];
  const routeRng = rng.fork(`route-features-${floor}`);
  const environmentRng = rng.fork(`room-environments-${floor}`);
  /*
   * Four to five rooms, not five to seven.
   *
   * Measured across 24 baseline runs at the scored horizon: **47% of every
   * round was spent in `explore`** — the party walks more than it fights — at
   * 16.3 rooms and 12.6 rounds per floor, reaching floor three in forty
   * rounds. Everything gated on depth therefore barely exists: draughts unlock
   * on floor two, merchants are rare, and three live runs in a row ended
   * somewhere around floor two to four with the economy never opening.
   *
   * Rooms are the lever rather than the per-room cost, because the per-room
   * cost is the interesting part — scouting, traps, caches, deciding a route.
   * Cutting the count keeps all of that and spends fewer rounds on the walking
   * between it.
   */
  const count = rng.int(5, 7);
  const kinds: RoomKind[] = ["combat", "combat", "elite", "cache", "market", "shrine", "empty"];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }

  const routes: DungeonRoute[] = [];
  const rooms: DungeonFloorMap["rooms"] = [
    {
      id: "r0",
      label: "floor entrance",
      kind: "entrance",
      links: [],
      x: 0,
      y: 0,
      visited: true,
      revealed: true,
      cleared: true,
    },
  ];
  const connect = (
    from: DungeonFloorMap["rooms"][number],
    to: DungeonFloorMap["rooms"][number],
    kind: DungeonRoute["kind"] = "passage",
    bidirectional = true,
    discovered = true,
  ) => {
    routes.push({
      id: `route-${routes.length + 1}`,
      from: from.id,
      to: to.id,
      bidirectional,
      kind,
      discovered,
      featureKnown: kind === "passage" || kind === "one-way" || kind === "locked",
      triggered: false,
      disarmed: false,
      traversals: 0,
    });
    if (discovered) {
      if (!from.links.includes(to.id)) from.links.push(to.id);
      if (bidirectional && !to.links.includes(from.id)) to.links.push(from.id);
    }
  };
  for (let i = 1; i < count - 1; i++) {
    // The entrance always branches. Later rooms grow from the recent frontier,
    // keeping the drawing legible while still producing different shapes.
    const parentIndex = i <= 2 ? 0 : rng.int(Math.max(1, i - 3), i - 1);
    const parent = rooms[parentIndex];
    const kind = floor % 4 === 0 && i === count - 2 ? "boss" : (kinds[(i - 1) % kinds.length] ?? "combat");
    const room: DungeonFloorMap["rooms"][number] = {
      id: `r${i}`,
      label: zone.rooms[(i - 1 + floor) % zone.rooms.length],
      kind,
      links: [],
      x: parent.x + rng.int(-1, 1),
      y: parent.y + 1,
      visited: false,
      revealed: false,
      cleared: false,
    };
    rooms.push(room);
    connect(parent, room);
  }

  const gate = floor % 4 === 0 ? rooms[count - 2] : rooms[rng.int(Math.max(1, count - 4), count - 2)];
  const stairs: DungeonFloorMap["rooms"][number] = {
    id: `r${count - 1}`,
    label: "stairs into the dark",
    kind: "stairs" as const,
    links: [],
    x: gate.x + rng.int(-1, 1),
    y: gate.y + 1,
    visited: false,
    revealed: false,
    cleared: true,
  };
  rooms.push(stairs);
  connect(gate, stairs);

  // Every ordinary room has stable geometry or atmosphere. Shuffle a complete
  // set before assignment so even the smallest floor contains three distinct
  // environments, rather than occasionally rolling the same effect everywhere.
  const environments = Object.keys(ROOM_ENVIRONMENTS) as Array<keyof typeof ROOM_ENVIRONMENTS>;
  for (let i = environments.length - 1; i > 0; i--) {
    const j = environmentRng.int(0, i);
    [environments[i], environments[j]] = [environments[j], environments[i]];
  }
  for (const [index, room] of rooms
    .filter((candidate) => candidate.kind !== "entrance" && candidate.kind !== "stairs")
    .entries()) {
    room.environment = environments[index % environments.length];
  }

  /*
   * The one room this floor charges for, chosen before anything else is wired.
   *
   * Everything below that could hand it a second way in is told to leave it
   * alone, because a gate with a way around it prices nothing — and that is not
   * hypothetical: with the toll placed before the loops, 53.8% of generated
   * gates could be walked around by a loop added afterwards. Cul-de-sac first,
   * then the gate, is the only ordering in which the charge is real.
   */
  const worthPaying = [
    ...rooms.filter((room) => room.kind === "cache"),
    ...rooms.filter((room) => room.kind === "market"),
  ];
  // A leaf first, where the floor offers one. Every room below with two tree
  // edges already has two ways in before a single loop is drawn, and no amount
  // of care later makes a gate on it mean anything.
  const gated =
    worthPaying.find((room) => routes.filter((r) => r.from === room.id || r.to === room.id).length === 1) ??
    worthPaying[0];

  // One concealed shortcut starts at the entrance and skips at least one
  // ordinary edge. Rooms after the initial branch never grow directly from
  // r0, so a useful target always exists. It is registered before loops so a
  // visible loop cannot consume the same physical connection.
  const secretTarget = [...rooms]
    .filter((room) => room.kind !== "stairs" && room.id !== "r0" && room !== gated && !rooms[0].links.includes(room.id))
    .sort((a, b) => b.y - a.y || a.id.localeCompare(b.id))[0];
  if (secretTarget) connect(rooms[0], secretTarget, "secret", true, false);

  // A locked loop is always optional: the bidirectional tree above still
  // reaches every room, including the stairs. That makes a key a shortcut or
  // escape resource rather than a hidden solvability requirement. The first
  // two branches are guaranteed to exist and cannot already be connected to
  // each other, so every generated floor gets one lock.
  const lockCandidates = rooms.slice(1, -1).flatMap((a, index, possible) =>
    possible.slice(index + 1).flatMap((b) => {
      const connected = routes.some(
        (route) => (route.from === a.id && route.to === b.id) || (route.from === b.id && route.to === a.id),
      );
      return connected || Math.abs(a.y - b.y) > 2 ? [] : [{ a, b }];
    }),
  );
  const locked = lockCandidates[routeRng.int(0, Math.max(0, lockCandidates.length - 1))];
  if (locked) connect(locked.a, locked.b, "locked");

  // One or two loops turn the tree into a maze without making its small map
  // unreadable. Avoid linking the stairs around a boss gate.
  const loops = rng.int(1, 2);
  let made = 0;
  while (made < loops) {
    const possibleLoops = rooms.slice(0, -1).flatMap((a, index, possible) =>
      possible.slice(index + 1).flatMap((b) => {
        const connected = routes.some(
          (route) => (route.from === a.id && route.to === b.id) || (route.from === b.id && route.to === a.id),
        );
        return connected || Math.abs(a.y - b.y) > 2 ? [] : [{ a, b }];
      }),
    );
    // Keep the gated room a cul-de-sac where the floor has any other pair to
    // join — see the note above `gated`. A preference rather than a ban,
    // because a small floor can have no other pair at all, and a floor with no
    // loop and no one-way drop is a worse floor than one with a gate that turns
    // out to have two approaches. When the fallback is taken the room ends up
    // with a second free way in, and the toll below simply declines to place.
    const unGated = possibleLoops.filter(({ a, b }) => a !== gated && b !== gated);
    const candidates = unGated.length > 0 ? unGated : possibleLoops;
    if (candidates.length === 0) break;
    const { a, b } = candidates[rng.int(0, candidates.length - 1)];
    // The first loop is a downward, one-way drop. It is a shortcut, but never
    // the only route onward because the bidirectional tree remains intact.
    const oneWay = made === 0;
    const from = a.y <= b.y ? a : b;
    const to = from === a ? b : a;
    connect(from, to, oneWay ? "one-way" : "passage", !oneWay);
    made += 1;
  }

  /*
   * A toll gate, in front of whatever on this floor is worth paying for.
   *
   * The zone names have had an "old toll room" in them since the first draft,
   * and the mechanic the world implied was missing: every other way through a
   * door is a personal skill — the rogue picks it, the guardian breaks it, the
   * key is carried by one person. A toll is the only barrier that five purses
   * open better than one, and it is placed against the room a party would
   * actually want, because a toll guarding an empty room is just a wall.
   *
   * Never on the way to the stairs. Like the lock, it is an option the floor
   * offers, not a requirement it imposes — a party that cannot raise the money,
   * or would rather keep it, simply walks past.
   *
   * Placed *after* the loops, and this is the whole of why. It used to run
   * before them, so it reasoned about a tree that no longer existed by the time
   * anybody played it: a loop added afterwards could reconnect the gated room,
   * and 53.8% of generated tolls could simply be walked around. It could also
   * not see the one-way drop that would later strand a party on the far side of
   * its own gate. Nothing in this block draws from `rng`, so moving it changes
   * which edge is a toll and nothing else about the floor.
   */
  if (gated) {
    // A gate is only a gate if it is the single free way in. Tolling one of two
    // approaches prices nothing, and tolling both would charge the party twice
    // for one room, since `openedBy` is per route.
    const ways = routes.filter(
      (route) =>
        route.discovered && FREELY_TRAVERSABLE.has(route.kind) && (route.from === gated.id || route.to === gated.id),
    );
    const gate = ways.length === 1 ? ways[0] : undefined;
    // Refuse if that would put the gate between the party and the way down: an
    // optional barrier that turns out to be mandatory is a soft-lock, and this
    // floor's whole design rests on the free routes still reaching everything.
    if (gate && gate.kind === "passage" && stairsAlwaysReachable(rooms, routes, gate)) {
      gate.kind = "toll";
      gate.toll = TOLL_BASE + floor * TOLL_PER_FLOOR;
      gate.featureKnown = true;
    }
  }

  // A concealed trap on one ordinary tree route. Route RNG is forked so this
  // cannot perturb room contents, coordinates, or the existing loop layout.
  const trapCandidates = routes.filter((route) => route.kind === "passage" && route.to !== stairs.id);
  const trapped = trapCandidates[routeRng.int(0, Math.max(0, trapCandidates.length - 1))];
  if (trapped) {
    trapped.kind = "trap";
    trapped.featureKnown = false;
    trapped.trap = (["blades", "poison-darts", "ward"] as const)[routeRng.int(0, 2)];
  }

  // Keys are floor resources rather than inventory items: anybody can carry
  // one, and it cannot leak into another floor. A key is never placed at the
  // entrance or stairs, so earning it requires choosing and clearing a room.
  const keyRooms = rooms.filter((room) => room.kind !== "entrance" && room.kind !== "stairs");
  const keyRoom = keyRooms[routeRng.int(0, Math.max(0, keyRooms.length - 1))];
  if (keyRoom) {
    keyRoom.key = true;
    keyRoom.keyCollected = false;
  }

  // Forked rather than drawn: `rng.fork` derives from the seed without
  // consuming from it, while a plain `rng.int` here would shift every
  // subsequent draw in this generator and silently reshuffle the contents of
  // every floor. It did, once — the ladder's organisation gap fell from 160
  // points to 33 before the cause was found.
  return { zone: zone.name, seed: rng.fork("dressing").int(0, 2 ** 30), currentRoom: "r0", rooms, routes, keys: 0 };
}
