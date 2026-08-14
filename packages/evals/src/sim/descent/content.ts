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
  Element,
  Enemy,
  HiddenMechanic,
  ItemEffect,
  ItemInstance,
  ItemKind,
  ItemModifiers,
  ItemProvenance,
  ItemRarity,
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
 */
export function depthScale(floor: number): { hp: number; power: number; armor: number } {
  return {
    // ≈15× by floor 48, against the party's measured ≈16× damage growth.
    hp: 1.058 ** (floor - 1),
    // ≈13× by floor 48, against the party's measured ≈9× health growth. This
    // gap is the one that ends the run, and it is deliberately the only one.
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

export function makeEnemy(def: FamilyDef, tier: number, floor: number, index: number, elite: boolean): Enemy {
  const scale = depthScale(floor);
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

export function makeBoss(floor: number, index: number): Enemy {
  const def = BOSSES[index % BOSSES.length];
  const scale = depthScale(floor);
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
): Enemy[] {
  if (boss) return [makeBoss(floor, bossIndex)];

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
    const enemy = makeEnemy(pick.def, pick.tier, floor, i + 1, elite && i === 0);
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
    addFrom(NEGATIVE_AFFIXES, negative);
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
export function rollStock(floor: number, rng: Rng): Array<{ item: string; price: number }> {
  const available = ITEMS.filter((it) => (it.from ?? 1) <= floor);
  const picks: Array<{ item: string; price: number }> = [];
  const chosen = new Set<string>();
  // Always at least one way to heal, so a broke party is never simply stuck.
  picks.push({ item: "healing_potion", price: Math.round(90 * (1 + floor * 0.04)) });
  chosen.add("healing_potion");
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
export function rollCache(floor: number, offers: number, rng: Rng): { items: string[]; origin: string } {
  const gear = ITEMS.filter((it) => it.kind !== "consumable" && (it.from ?? 1) <= floor);
  const consumables = ITEMS.filter((it) => it.kind === "consumable" && (it.from ?? 1) <= floor);
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

export function roomHint(kind: RoomKind): string {
  return ROOM_HINTS[kind];
}

/**
 * A small connected room graph with branches and occasional loops.
 *
 * The tree guarantees every room is reachable; extra edges make backtracking
 * and alternate routes possible. Contents and geometry are independently
 * seeded, so two runs can share a zone without sharing its useful route.
 */
export function generateFloorMap(floor: number, rng: Rng): DungeonFloorMap {
  const zone = ZONES[Math.floor((floor - 1) / 3) % ZONES.length];
  const count = rng.int(5, 7);
  const kinds: RoomKind[] = ["combat", "combat", "elite", "cache", "market", "shrine", "empty"];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }

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
  for (let i = 1; i < count - 1; i++) {
    // The entrance always branches. Later rooms grow from the recent frontier,
    // keeping the drawing legible while still producing different shapes.
    const parentIndex = i === 2 ? 0 : rng.int(Math.max(0, i - 3), i - 1);
    const parent = rooms[parentIndex];
    const kind = floor % 4 === 0 && i === count - 2 ? "boss" : (kinds[(i - 1) % kinds.length] ?? "combat");
    rooms.push({
      id: `r${i}`,
      label: zone.rooms[(i - 1 + floor) % zone.rooms.length],
      kind,
      links: [parent.id],
      x: parent.x + rng.int(-1, 1),
      y: parent.y + 1,
      visited: false,
      revealed: false,
      cleared: false,
    });
    parent.links.push(`r${i}`);
  }

  const gate = floor % 4 === 0 ? rooms[count - 2] : rooms[rng.int(Math.max(1, count - 4), count - 2)];
  const stairs = {
    id: `r${count - 1}`,
    label: "stairs into the dark",
    kind: "stairs" as const,
    links: [gate.id],
    x: gate.x + rng.int(-1, 1),
    y: gate.y + 1,
    visited: false,
    revealed: false,
    cleared: true,
  };
  gate.links.push(stairs.id);
  rooms.push(stairs);

  // One or two loops turn the tree into a maze without making its small map
  // unreadable. Avoid linking the stairs around a boss gate.
  const loops = rng.int(1, 2);
  let made = 0;
  let attempts = 0;
  while (made < loops && attempts++ < 40) {
    const a = rooms[rng.int(0, rooms.length - 2)];
    const b = rooms[rng.int(0, rooms.length - 2)];
    if (a === b || a.links.includes(b.id) || Math.abs(a.y - b.y) > 2) continue;
    a.links.push(b.id);
    b.links.push(a.id);
    made += 1;
  }

  return { zone: zone.name, currentRoom: "r0", rooms };
}
