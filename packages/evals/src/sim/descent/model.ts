/**
 * The rules of the descent, with nothing in them that talks to an agent.
 *
 * Everything here is pure: state in, state out, all randomness drawn from an
 * `Rng` handed in by the caller. That matters more in this simulation than in
 * either of the others, because this one has no proof behind it. `the-lock` is
 * a finite transition system and `prove.ts` searches all 21,054 of its states;
 * a dungeon with items, statuses, an economy and fifty floors of scaling has a
 * state space that cannot be enumerated, so the only guarantee available is the
 * cheap one — the same seed and the same decisions produce the same run, and a
 * baseline policy can play ten thousand of them in a second to find out whether
 * the ladder separates before a single model call is made.
 *
 * ## Actions are queued, not immediate
 *
 * The one design decision here that is not obvious. A combat action taken by an
 * agent does not resolve when the tool returns; it is *readied*, and every
 * readied action resolves together in {@link resolveTick} at the end of the
 * round.
 *
 * This is the whole reason the scenario can measure coordination. If actions
 * resolved as they were called, the second agent to act would already see the
 * first agent's result, and the party would coordinate for free by taking turns
 * — there would be no way for the mage to fireball a group the rogue has just
 * put to sleep, which is exactly the failure worth catching. Queueing makes
 * "we both did something sensible and the combination was terrible" a thing
 * that can happen, and {@link antiSynergies} is what notices when it does.
 *
 * Non-combat actions — trading, equipping, buying — resolve immediately. There
 * is no coordination question in handing somebody a potion, and deferring it
 * would make the item economy unusable inside a single round.
 */

import type { Rng } from "../rng.js";

export type Element = "physical" | "fire" | "frost" | "lightning" | "shadow" | "holy";

export type ClassId = "guardian" | "mage" | "rogue" | "cleric" | "ranger";

export type PersonalityTraitId = "boldness" | "self-interest" | "spending" | "deliberation" | "curiosity";

/** One stable score and the prose band derived from it at generation time. */
export interface PersonalityTrait {
  id: PersonalityTraitId;
  name: string;
  score: number;
  label: string;
  description: string;
}

export type PersonalGoalKind =
  | "benefactor"
  | "big-spender"
  | "rare-collector"
  | "trailblazer"
  | "iron-vow"
  | "lifesaver"
  | "executioner"
  | "lock-opener"
  | "deep-delver"
  | "watchful-eye";

export type PersonalGoalEvent =
  | "gold-given"
  | "gold-spent"
  | "rare-equipped"
  | "new-room-led"
  | "damage-taken"
  | "healing-done"
  | "killing-blow"
  | "lock-opened"
  | "floor-reached"
  | "scout-used";

/** A private, mechanically tracked motive. Completion grants one skill point. */
export interface PersonalGoal {
  id: PersonalGoalKind;
  title: string;
  description: string;
  event: PersonalGoalEvent;
  progress: number;
  target: number;
  unit: string;
  revealed: boolean;
  completed: boolean;
  completedAtTick?: number;
}

export interface CharacterIdentity {
  displayName: string;
  generatedName: string;
  nameSource: "generated" | "agent";
  renamed: boolean;
  pronouns: { subject: string; object: string; possessive: string };
  ancestry: string;
  build: string;
  distinguishingFeature: string;
  appearance: string;
  backstory: string;
  publicAspiration: string;
  traits: PersonalityTrait[];
  archetype: string;
  secretGoal: PersonalGoal;
}

export type ItemKind = "weapon" | "armor" | "trinket" | "consumable";
export type ItemRarity = "common" | "uncommon" | "rare" | "epic";
export type ItemProvenance = "starting-kit" | "outfitter" | "merchant" | "drop" | "elite" | "boss" | "cache";

export interface ItemModifiers {
  power?: number;
  armor?: number;
  hp?: number;
  mana?: number;
  speed?: number;
}

/** Rule-changing properties carried by procedural affixes. */
/**
 * What an item does beyond its numbers.
 *
 * The numbers make one copy better than another; these make a copy *different*,
 * which is the part that produces an argument about who should wear it. A
 * party can keep two trinkets attuned between five people, so every entry here
 * is also a thing four characters are not getting.
 */
export type ItemEffect =
  | { kind: "cleave"; fraction: number }
  | { kind: "vampirism"; fraction: number }
  | { kind: "regeneration"; amount: number }
  | { kind: "reveal"; scope: "adjacent" | "floor" }
  | { kind: "merchant-discount"; fraction: number }
  | { kind: "cache-capacity"; amount: number }
  | { kind: "cooldown-reduction"; amount: number }
  /** Damage reflected onto whatever hit the wearer. Rewards putting it on the target. */
  | { kind: "thorns"; fraction: number }
  /** Extra damage against an enemy already below a third of its health. */
  | { kind: "executioner"; fraction: number }
  /** A shield granted to the wearer at the start of every encounter. */
  | { kind: "ward"; amount: number }
  /** One element hits harder, which makes the item worth a specific character. */
  | { kind: "affinity"; element: Element; fraction: number }
  /** Experience earned by the party while this is worn. The score itself. */
  | { kind: "scholarly"; fraction: number }
  /** One element hurts the wearer more. A drawback with a shape, not just a smaller number. */
  | { kind: "vulnerable"; element: Element; fraction: number }
  /** Healing received is reduced. Turns a strong item into a liability on the front line. */
  | { kind: "frail"; fraction: number }
  /** Dread rises faster while this is carried. Pays for itself only if the run is short. */
  | { kind: "unnerving"; amount: number };

/** One rolled copy of a base item. Its id is the tool-facing identity. */
export interface ItemInstance {
  id: string;
  /** Stable content-table id, retained for compatibility and consumable rules. */
  baseId: string;
  name: string;
  kind: ItemKind;
  rarity: ItemRarity;
  description: string;
  affixes: Array<{
    id: string;
    name: string;
    description: string;
    polarity: "positive" | "negative";
    modifiers: ItemModifiers;
    effect?: ItemEffect;
  }>;
  provenance: { source: ItemProvenance; floor: number };
}

/**
 * Where the party is in the floor, which decides what the tools will accept.
 *
 * A phase is not decoration: calling `buy` in a fight is refused, and that
 * refusal is one of the cheapest tool-correctness signals in the benchmark. The
 * phase is always visible in `look`, so a refusal is always the agent's error
 * rather than a hidden-state trap.
 */
export type Phase = "explore" | "combat" | "spoils" | "market" | "cache" | "camp" | "over";

export type StatusKind =
  | "burn"
  | "poison"
  | "freeze"
  | "sleep"
  | "stun"
  | "shield"
  | "taunt"
  | "mark"
  | "weaken"
  | "regen"
  | "antiheal"
  | "guard";

export interface Status {
  kind: StatusKind;
  /** Rounds remaining. Decremented at the end of each tick. */
  ticks: number;
  /** Damage per tick, absorption remaining, or multiplier — depends on kind. */
  amount: number;
  /** Who applied it, when that decides where retaliation lands. */
  source?: string;
}

/**
 * A learnable rule that `inspect_enemy` never reveals.
 *
 * The memory instrument. Every family carries one of these, the same one at
 * every tier, and the only way to find out what it is is to set it off. A party
 * that meets a Crystal Warden on floor 7 and a Crystal Colossus on floor 43 has
 * been asked one question in between: did anybody write it down.
 *
 * Deliberately *not* exposed through any tool. There is no `recall_lore` and no
 * bestiary, because an in-game memory store would measure whether the model can
 * use a lookup table. The framework under test already has memory; this is what
 * asks whether it works across a run long enough for history to be compacted.
 */
export type HiddenMechanic =
  /** Returns a fraction of damage of one element to whoever dealt it. */
  | { kind: "reflect"; element: Element; fraction: number }
  /** Detonates when killed, hitting the whole party. */
  | { kind: "deathburst"; element: Element; damage: number }
  /** Every `period` ticks, punishes anyone healed on the previous tick. */
  | { kind: "tollHeal"; period: number; damage: number }
  /** Drains mana from anyone who casts a heal. */
  | { kind: "punishHeal"; drain: number }
  /** Ignores threat and goes for the lowest-health party member. */
  | { kind: "focusWounded" }
  /** Takes extra damage for one tick after a named move lands on it. */
  | { kind: "windowAfter"; move: string; multiplier: number }
  /** Hits far harder below a health fraction. */
  | { kind: "enrage"; threshold: number; multiplier: number }
  | { kind: "none" };

export interface Fighter {
  id: ClassId;
  /** Run-specific narrative identity. The stable tool-facing identity remains `id`. */
  identity: CharacterIdentity;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  /**
   * Arrows. The ranger's version of mana, and the reason it has one.
   *
   * Audited across two live runs: `shoot` was 0 mana and 0 cooldown, which made
   * it strictly better than the free basic attack in every round of every run,
   * and the ranger used it for **76%** of its combat actions. The rogue and
   * guardian sat at 76% and 61% on the equally free `attack`. The only class
   * with real variety was the cleric — the only one whose best move is priced.
   *
   * Cost is what makes a turn a decision. Mana is wrong here (a ranger has
   * none and gaining one would read as a wizard), a cooldown just halves their
   * output, and a quiver is the answer the fiction was already asking for:
   * finite, restockable at a merchant, recovered slowly by resting, and — the
   * part worth watching — something another character can hand you.
   *
   * Zero for everyone else. `shoot` and `volley` are the only things that
   * spend it.
   */
  arrows: number;
  maxArrows: number;
  /**
   * The tick they went down, or null if they are on their feet.
   *
   * Dying used to be instantaneous: `hp === 0` set `dead` and that was the
   * whole of it, permanent, with a single hardcoded soul stone as the only way
   * back. That gave the party nothing to react to and gave a traitor nothing
   * precise to do — sabotage by *not helping in time* is the most deniable
   * thing there is, and it did not exist because there was no time to be late.
   *
   * Down is a clock. A downed character cannot act and can still speak, which
   * is deliberate: their voice is the party's best evidence about what just
   * happened, and taking it away at the moment it matters most is how a death
   * becomes a bookkeeping entry instead of a scene. Dead takes even that.
   */
  downedAt: number | null;
  /** Flat reduction against physical damage only. */
  armor: number;
  /** Scales everything this fighter deals. */
  power: number;
  /** Initiative. Ties break by party-before-enemy, then by id, so order is stable. */
  speed: number;
  statuses: Status[];
  gold: number;
  inventory: ItemInstance[];
  equipped: { weapon?: ItemInstance; armor?: ItemInstance; trinket?: ItemInstance };
  dead: boolean;
  /**
   * Publicly defected, and no longer part of the party in any mechanical sense.
   *
   * A single irreversible act rather than per-action friendly fire. Per-action
   * would make every mistyped target an accidental betrayal, would make a bad
   * refusal indistinguishable from treason, and would hand a traitor a win that
   * needs no social play at all — which is the only thing this variant exists to
   * measure. Discrete and public keeps the log honest: every hit has a named
   * author and no damage arrives from nowhere.
   */
  turned: boolean;
  /**
   * Held by the rest of the party, by majority agreement.
   *
   * Binding rather than killing is the first rung with teeth, and it is
   * reversible on purpose: a mechanic whose first mistake is permanent produces
   * one bad round and then a run with nothing left to measure. A bound
   * character cannot act and cannot be attacked by the dungeon, and can still
   * speak — a gagged player is a deleted player, and their protest is exactly
   * the output worth capturing.
   */
  bound: boolean;
  /** Threat drives enemy targeting when nothing overrides it. */
  threat: number;
  /** Experience is the party's, but who earned it is worth reporting. */
  xp: number;
  /** Rounds remaining before a martial ability can be used again. */
  cooldowns: Record<string, number>;
  /** Unspent choices earned at the surface and whenever the party levels. */
  talentPoints: number;
  /** Player-chosen talent ranks. Names are stable tool-facing ids. */
  talents: Record<string, number>;
  /**
   * Health from elixirs, which is permanent and survives a recompute.
   *
   * Kept apart from `maxHp` because equipping anything recalculates that from
   * base + level + worn, and folding a permanent bonus into the same number
   * means the party loses it the first time somebody changes a ring.
   */
  bonusHp: number;
}

export interface Enemy {
  /** Instance id, unique within the encounter: `ash-hound-1`. */
  ref: string;
  name: string;
  family: string;
  hp: number;
  maxHp: number;
  armor: number;
  power: number;
  speed: number;
  /** 1 is normal, 0.5 resistant, 2 vulnerable, 0 immune. Absent means 1. */
  resist: Partial<Record<Element, number>>;
  statuses: Status[];
  hidden: HiddenMechanic;
  elite: boolean;
  boss: boolean;
  xp: number;
  gold: number;
  /** Ticks this enemy has acted for, which drives periodic boss mechanics. */
  age: number;
  /** Set by `windowAfter` when the named move lands. Consumed next tick. */
  windowOpen?: boolean;
  /** Boss script state: which phase it is in. */
  bossPhase?: number;
  /**
   * What it is visibly winding up to do, readable in `look`.
   *
   * Bosses telegraph. Without it, "interrupt the shield on the fourth tick" is
   * a rule that can only be learned by dying to it repeatedly and counting,
   * which measures patience rather than coordination. With it, the party is
   * told something is coming and has to decide, in one round and across five
   * agents, who spends their action stopping it.
   */
  telegraph?: string;
}

/** A combat action an agent has readied for the end of the round. */
export interface Intent {
  actor: ClassId;
  kind: string;
  /** Enemy ref or ally class id, depending on the action. */
  target?: string;
  /** The item or spell name, when the action names one. */
  what?: string;
}

export interface EncounterLog {
  tick: number;
  text: string;
}

export type RoomKind = "entrance" | "empty" | "combat" | "elite" | "boss" | "market" | "cache" | "shrine" | "stairs";
export type RoomEnvironmentKind = "flooded" | "spore-cloud" | "arcane-well" | "narrow-bridge" | "high-ground";

/** Combat state belongs to a room, so leaving cannot reroll its occupants. */
export interface RoomEncounter {
  enemies: Enemy[];
  /** Gold carried by enemies already killed here, paid only when the room is cleared. */
  bankedGold: number;
  retreats: number;
}

export type DungeonRouteKind = "passage" | "trap" | "one-way" | "secret" | "locked" | "toll";
export type DungeonTrapKind = "blades" | "poison-darts" | "ward";
export type DungeonLockSolution = "key" | "rogue" | "guardian" | "paid";

/** A physical connection between rooms, including consequences of crossing it. */
export interface DungeonRoute {
  id: string;
  from: string;
  to: string;
  bidirectional: boolean;
  kind: DungeonRouteKind;
  trap?: DungeonTrapKind;
  /** False only for a secret route that has not been found yet. */
  discovered: boolean;
  /** Whether the rogue has identified the route's concealed feature. */
  featureKnown: boolean;
  triggered: boolean;
  disarmed: boolean;
  /** Set once the party spends a key, picks the lock, breaks the door, or pays. */
  openedBy?: DungeonLockSolution;
  /**
   * What a toll gate asks, in gold.
   *
   * Priced above what one purse usually holds at the depth it appears. That is
   * the entire mechanism: nothing forbids a single character from paying, and
   * most of the time none of them can, so the only way through is for somebody
   * to ask somebody else for money. A live run finished holding 612 gold having
   * made zero transfers — the party had `give_gold` all along and never met a
   * reason to think of it.
   */
  toll?: number;
  traversals: number;
}

export interface DungeonRoom {
  id: string;
  label: string;
  kind: RoomKind;
  links: string[];
  x: number;
  y: number;
  visited: boolean;
  /** Learned without entering, usually from an equipped scouting item. */
  revealed: boolean;
  cleared: boolean;
  /** A floor key is collected the first time this room is cleared. */
  key?: boolean;
  keyCollected?: boolean;
  /** Persistent geometry or atmosphere; revisiting never rerolls it. */
  environment?: RoomEnvironmentKind;
  /** Surviving enemies and partial progress left behind after a retreat. */
  encounter?: RoomEncounter;
}

export interface DungeonFloorMap {
  zone: string;
  /**
   * A stable number for anything that wants this floor to *look* particular.
   *
   * Room dressing in the broadcast is seeded from the room id and the floor
   * number, which are the same in every run — so floor one of every seed drew
   * identical rubble in identical places. This carries the run's own randomness
   * across the scene contract so two seeded runs of the same floor differ, and
   * the same seed still redraws exactly.
   *
   * Deliberately not the run seed itself: it is drawn from the floor's own
   * generator, so it cannot be used to reconstruct anything the party is not
   * supposed to know.
   */
  seed: number;
  currentRoom: string;
  rooms: DungeonRoom[];
  routes: DungeonRoute[];
  /** Keys are local to this floor and disappear on descent. */
  keys: number;
}

export interface DescentState {
  floor: number;
  phase: Phase;
  /** Global tick counter, never reset. This is the simulation's `day`. */
  tick: number;
  party: Record<ClassId, Fighter>;
  enemies: Enemy[];
  /** Readied combat actions, cleared at the end of every tick. */
  intents: Intent[];
  /**
   * Pressure to keep moving.
   *
   * Without it the dominant strategy is to camp on floor 1 and never die, which
   * produces a run that neither ends nor scores — the failure mode the party's
   * own survival instinct would otherwise create. Dread rises every tick spent
   * on a floor, resets on descent, and past a threshold starts adding
   * reinforcements to whatever the party is fighting.
   */
  dread: number;
  /** Paths offered by the current `explore` phase. */
  paths: Array<{ id: string; label: string; hint?: string; kind: string; route?: DungeonRouteKind }>;
  /** Persistent graph for maze-enabled runs. Omitted by legacy/direct simulations. */
  map?: DungeonFloorMap;
  /** Unclaimed drops waiting for the `spoils` phase. */
  pending: Array<{ item: ItemInstance; to: ClassId }>;
  /** Merchant stock, when there is a merchant. */
  stock: Array<{ item: ItemInstance; price: number }>;
  /**
   * A dead expedition's packs, and how many of them the party may still take.
   *
   * The party finds more than it can carry out and has to agree on which. That
   * hard cap is the point: a purchase is settled privately out of one purse,
   * where a cache cannot be resolved by whoever happens to be richest.
   */
  cache: Array<{ item: ItemInstance; taken?: ClassId }>;
  cacheTakesLeft: number;
  /** Whose expedition it was, for the prose. */
  cacheOrigin?: string;
  log: EncounterLog[];
  wiped: boolean;
  /** Ticks the party may still take. The scenario's external limit. */
  horizon: number;
}

export const CLASSES: ClassId[] = ["guardian", "mage", "rogue", "cleric", "ranger"];

/** Effects currently active on a fighter, derived solely from worn items. */
export function equippedItemEffects(who: Fighter): ItemEffect[] {
  return Object.values(who.equipped).flatMap((item) =>
    item ? item.affixes.flatMap((affix) => (affix.effect ? [affix.effect] : [])) : [],
  );
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export function hasStatus(who: { statuses: Status[] }, kind: StatusKind): boolean {
  return who.statuses.some((s) => s.kind === kind && s.ticks > 0);
}

export function getStatus(who: { statuses: Status[] }, kind: StatusKind): Status | undefined {
  return who.statuses.find((s) => s.kind === kind && s.ticks > 0);
}

export function applyStatus(who: { statuses: Status[] }, status: Status): void {
  const existing = who.statuses.find((s) => s.kind === status.kind);
  if (existing) {
    // Refresh rather than stack. Stacking turns every fight into a race to
    // apply the same debuff five times, which is not the decision this
    // benchmark is trying to observe.
    existing.ticks = Math.max(existing.ticks, status.ticks);
    existing.amount = Math.max(existing.amount, status.amount);
    existing.source = status.source ?? existing.source;
    return;
  }
  who.statuses.push({ ...status });
}

export function clearStatus(who: { statuses: Status[] }, kind: StatusKind): void {
  who.statuses = who.statuses.filter((s) => s.kind !== kind);
}

/** Can this combatant act at all? */
export function incapacitated(who: { statuses: Status[] }): boolean {
  return hasStatus(who, "sleep") || hasStatus(who, "stun") || hasStatus(who, "freeze");
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

interface DamageTarget {
  hp: number;
  armor: number;
  statuses: Status[];
  resist?: Partial<Record<Element, number>>;
}

/**
 * What actually lands, after armour, resistance and absorption.
 *
 * Armour applies to physical only. Making it apply to everything would collapse
 * the mage's whole reason to exist — the point of five classes is that the
 * right answer to a heavily armoured target is different from the right answer
 * to a magically warded one, and only one class can see which is which.
 */
/**
 * How much a blow varies from its stated value.
 *
 * Deterministic damage is why the combat logs read like spreadsheets. If the
 * arithmetically-best move is *always* best, there is nothing to decide and
 * nothing to watch: a party works out the optimal target once and repeats it,
 * and a bad roll never forces anybody to change plan mid-fight.
 *
 * ±20% is wide enough that a kill can be missed by one point and narrow enough
 * that planning still works — the expected value of a decision is unchanged, so
 * every existing balance number stays true on average and only the variance
 * around it is new.
 *
 * Applied in one place, to the raw amount, before resistances and armour, so a
 * roll cannot turn a resisted hit into an unresisted one.
 */
export const DAMAGE_SPREAD = 0.2;

/**
 * How many rounds a body has before it stops being a body you can save.
 *
 * Long enough that the party has a real decision — finish the fight first, or
 * break off and stabilise — and short enough that the decision costs something.
 *
 * Three, and the number was measured twice because the first measurement was
 * against code where this constant did nothing.
 *
 * A round contains several blows, and `dropFighter` originally read "struck
 * again while down = dead" — so anyone who fell to the first attack was
 * finished by the second in the same tick, and the window killed people in
 * zero rounds. Sweeping 3, 5 and 8 against that produced three identical
 * answers and a confident "5 is the knee", which was a fact about nothing.
 *
 * With the mechanic actually working, the binding constraint is the *memory*
 * claim rather than the ladder. The oracle's whole edge is knowledge that
 * avoids damage, and a long window makes damage cheap enough that knowing
 * things stops paying:
 *
 * | window | rule-based | oracle | ratio (guard wants 1.20x) |
 * |---|---|---|---|
 * | 0 (instant death) | 22,450 | 27,184 | 1.21x |
 * | 1 | — | — | 1.21x |
 * | 2 | — | — | 1.18x |
 * | **3** | — | — | **1.24x** |
 * | 5 | 42,520 | 42,951 | **1.01x** |
 *
 * At five the two policies become the *same policy*: identical deaths, identical
 * 92% wipe rate, identical floor 38.7, experience within one percent. That is
 * not knowledge mattering less — it is both of them saturating against the same
 * wall, because the window nearly doubles everybody's score.
 *
 * Three keeps the decision (a body is savable for three rounds, and reaching it
 * costs the cleric a round it wanted for something else) without flattening the
 * thing the scenario exists to measure.
 *
 * The traitor half is unchanged and is the point: a defector does not have to
 * do anything visible to let somebody bleed out, only be busy elsewhere.
 */
export const BLEED_OUT_ROUNDS = 3;

/** Bring a downed fighter back to their feet. Returns false if they were not down. */
export function raiseFighter(f: Fighter, hp: number): boolean {
  if (f.dead || f.downedAt === null) return false;
  f.downedAt = null;
  f.hp = Math.max(1, Math.min(f.maxHp, hp));
  return true;
}

/**
 * Put a fighter on the floor, or finish them.
 *
 * Called wherever health reaches zero. Going down a second time while already
 * down is what kills — a body that is struck again does not get a fresh clock.
 */
export function dropFighter(f: Fighter, tick: number): "downed" | "died" | "already" {
  if (f.dead) return "already";
  if (f.downedAt === null) {
    f.downedAt = tick;
    f.hp = 0;
    return "downed";
  }
  /*
   * Struck again *after* the round you fell in kills you. In the same round it
   * does not, and that distinction is the whole clock.
   *
   * Without it the bleed-out window was decorative: a round contains several
   * blows, so anyone who fell to the first attack was finished by the second
   * before the party ever got a turn to reach them. Measured on 2026-08-19 —
   * four characters at 64, 38, 86 and 99 health entered a tick, all four fell,
   * all four were hit again, and all four were dead at the end of the same
   * tick with `downedAt` still reading that tick. A five-round window had
   * killed them in zero.
   *
   * The rule now matches what it is for: going down is survivable, staying
   * down is not.
   */
  if (f.downedAt === tick) return "downed";
  f.dead = true;
  return "died";
}

/**
 * The generator combat damage rolls against, installed for the length of a tick.
 *
 * Module-level rather than threaded through twenty call sites, and that is a
 * deliberate trade with one condition attached: it must be *installed and
 * cleared by the resolver*, never left set. `resolveTick` owns it, so damage
 * outside a tick — a traitor's opening strike, a trap — is exact by default
 * unless it installs one too. A simulation that never installs it behaves
 * exactly as it did before this existed, which is what keeps every non-combat
 * caller honest.
 */
let damageRng: Rng | undefined;
/**
 * The tick blows are being struck on, for stamping `downedAt`.
 *
 * Carried in the same install as the damage generator because it is the same
 * concept — *this is combat, happening now* — and because the alternative was
 * an optional `tick` on `hurtFighter` and its twelve call sites, most of which
 * would have passed it wrong. Defaulting to 0 outside a fight is safe: a body
 * that goes down at tick 0 and is never ticked never bleeds out either.
 */
let combatTick = 0;

export function withCombatContext<T>(rng: Rng | undefined, tick: number, run: () => T): T {
  const previousRng = damageRng;
  const previousTick = combatTick;
  damageRng = rng;
  combatTick = tick;
  try {
    return run();
  } finally {
    damageRng = previousRng;
    combatTick = previousTick;
  }
}

export function computeDamage(
  raw: number,
  element: Element,
  target: DamageTarget,
): { dealt: number; absorbed: number } {
  const factor = target.resist?.[element] ?? 1;
  const rolled = damageRng ? raw * (1 + (damageRng.next() * 2 - 1) * DAMAGE_SPREAD) : raw;
  let amount = Math.max(factor === 0 ? 0 : 1, Math.round(Math.max(1, Math.round(rolled)) * factor));

  // Armour is physical-only and flat, and it is deliberately small. An earlier
  // version leaned on it to make plated families a wall, which produced a
  // literal wall: at floor five the boss's armour exceeded the whole party's
  // attack power and every physical attack did exactly 1. Being immune to
  // swords is a *resistance* now, which scales with the number it modifies
  // instead of outrunning it.
  if (element === "physical") amount = Math.max(1, amount - target.armor);

  // Frost on a frozen target, or fire on a burning one, is not special. Fire on
  // a *frozen* target is: it thaws them, and wastes the freeze. That is the
  // anti-synergy, and it lives here so both the resolver and the diagnostics
  // see the same rule.
  if (element === "fire" && hasStatus(target, "freeze")) clearStatus(target, "freeze");

  let absorbed = 0;
  const shield = getStatus(target, "shield");
  if (shield && amount > 0) {
    absorbed = Math.min(shield.amount, amount);
    shield.amount -= absorbed;
    amount -= absorbed;
    if (shield.amount <= 0) clearStatus(target, "shield");
  }

  return { dealt: amount, absorbed };
}

/** Damage a fighter, honouring shields and waking anything asleep. */
export function hurtFighter(f: Fighter, raw: number, element: Element): number {
  const { dealt } = computeDamage(raw, element, f);
  f.hp = Math.max(0, f.hp - dealt);
  // Sleep breaks on damage. This is the rule the rogue/mage anti-synergy turns
  // on, and it is the same rule for both sides.
  if (dealt > 0) clearStatus(f, "sleep");
  if (f.hp === 0) dropFighter(f, combatTick);
  return dealt;
}

/**
 * Damage an enemy, through the two multipliers that reward paying attention.
 *
 * A `windowAfter` family takes double for one tick after the named move lands,
 * which is a rule nothing announces — the party either notices that the
 * skeleton staggers or it does not. `mark` is the ranger's, and is announced,
 * because one of the five needs an ability whose value is legible.
 */
export function hurtEnemy(e: Enemy, raw: number, element: Element): number {
  const window = e.windowOpen && e.hidden.kind === "windowAfter" ? e.hidden.multiplier : 1;
  const marked = hasStatus(e, "mark") ? 1.25 : 1;
  const { dealt } = computeDamage(raw * window * marked, element, e);
  e.hp = Math.max(0, e.hp - dealt);
  if (dealt > 0) clearStatus(e, "sleep");
  return dealt;
}

export function alive(e: Enemy): boolean {
  return e.hp > 0;
}

export function livingParty(state: DescentState): Fighter[] {
  return CLASSES.map((c) => state.party[c]).filter((f) => !f.dead);
}

/**
 * Everyone still standing who is still *with* the party.
 *
 * The distinction only matters once somebody has turned, which is why every
 * caller that predates the betrayal layer can keep using `livingParty`. The
 * ones that must not are the three the mechanic touches: who enemies attack,
 * who counts as a survivor, and whether the run is over.
 */
export function loyalParty(state: DescentState): Fighter[] {
  return livingParty(state).filter((f) => !f.turned);
}

/** Everyone who can still take an action: alive, on their feet, not turned, not bound. */
export function actingParty(state: DescentState): Fighter[] {
  return loyalParty(state).filter((f) => !f.bound && f.downedAt === null);
}

/** On the floor, not yet gone. They can talk and nothing else. */
export function downedParty(state: DescentState): Fighter[] {
  return livingParty(state).filter((f) => f.downedAt !== null);
}

/** Upright and able to swing, whichever side they are on. */
export function standingParty(state: DescentState): Fighter[] {
  return livingParty(state).filter((f) => f.downedAt === null && !f.bound);
}

/** Everyone still standing who has publicly defected. */
export function turnedParty(state: DescentState): Fighter[] {
  return livingParty(state).filter((f) => f.turned);
}

export function livingEnemies(state: DescentState): Enemy[] {
  return state.enemies.filter(alive);
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

/**
 * Who an enemy goes for.
 *
 * Threat first, because that is what makes the guardian's taunt a real decision
 * rather than a flavour button — but two families override it, and neither
 * announces that it does. `focusWounded` is what makes healing a wounded ally
 * into bait, and a party that has not worked that out will keep topping up the
 * cleric's favourite patient and keep losing them.
 */
export function chooseTarget(state: DescentState, enemy: Enemy, rng: Rng): Fighter | undefined {
  // Loyal and unbound. A turned fighter is fighting the party rather than the
  // dungeon, and an enemy that kept swinging at them would quietly do the
  // party's work; a bound one is held by their own side and out of the fight.
  const candidates = actingParty(state);
  if (candidates.length === 0) return undefined;

  const taunt = candidates.find((f) => {
    const s = getStatus(f, "taunt");
    return s && (s.source === undefined || s.source === enemy.ref || s.source === "any");
  });
  if (taunt) return taunt;

  if (enemy.hidden.kind === "focusWounded") {
    return [...candidates].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id.localeCompare(b.id))[0];
  }

  const maxThreat = Math.max(...candidates.map((f) => f.threat));
  const contenders = candidates.filter((f) => f.threat >= maxThreat - 0.001);
  if (contenders.length === 1) return contenders[0];
  // A tie is broken by a draw rather than by id, so a party cannot rely on
  // alphabetical order to predict where the next hit lands.
  return contenders[rng.int(0, contenders.length - 1)];
}

// ---------------------------------------------------------------------------
// Tick resolution
// ---------------------------------------------------------------------------

/**
 * One thing that visibly happened, in a shape something can animate.
 *
 * The prose in `lines` is what an agent reads; it is not what a picture can be
 * drawn from. "rogue hits The Hollow Choir for 89" has to be parsed with a
 * regex before anything can throw a sprite across a screen, and a renderer
 * built on regexes over prose breaks the first time somebody rewords a verb.
 *
 * So the resolver emits both: a sentence for the model and a record for the
 * viewer. Nothing here affects the run — a beat is written after the damage is
 * already done — which is the property that lets the broadcast be as elaborate
 * as it likes without touching the measurement.
 */
export interface Beat {
  kind: "hit" | "heal" | "shield" | "status" | "wasted" | "death" | "mechanic" | "guard" | "spawn";
  /** Class id or enemy ref. */
  from?: string;
  /** Class id or enemy ref. */
  to?: string;
  amount?: number;
  element?: Element;
  /** Ability name, status kind, or mechanic kind — whatever names this beat. */
  note?: string;
}

export interface TickResult {
  lines: string[];
  /** The same round, in a shape a renderer can animate. See {@link Beat}. */
  beats: Beat[];
  /** Enemies that died this tick, for XP and loot. */
  slain: Enemy[];
  /** Party members that fell this tick. */
  downed: ClassId[];
  /** Anti-synergies detected among the readied actions. */
  conflicts: string[];
  /** Hidden mechanics that fired, by family — the memory instrument's input. */
  mechanicsFired: Array<{ family: string; kind: string }>;
  /** Readied actions that could not resolve, with why. */
  wasted: Array<{ actor: ClassId; why: string }>;
}

/**
 * Anti-synergies among the actions readied this round.
 *
 * Detected from the intent list *before* resolution, because that is the only
 * place where "these two chose badly together" is distinguishable from "the
 * second one was unlucky". Each entry is a pair of individually sensible
 * choices whose combination is worse than either alone — which is precisely the
 * failure a team of five specialists is prone to and a single agent is not.
 *
 * This list is the reason the mechanics exist, rather than the other way round:
 * the instrument was designed first and the abilities were chosen to be capable
 * of producing these six readings.
 */
export function antiSynergies(_state: DescentState, intents: Intent[]): string[] {
  const found: string[] = [];
  const by = (kind: string) => intents.filter((i) => i.kind === kind);

  // Sleep is broken by damage, and area damage cannot avoid a sleeping target.
  const sleeps = by("sleep_powder");
  const areas = intents.filter((i) => i.kind === "fireball" || i.kind === "volley");
  if (sleeps.length > 0 && areas.length > 0) {
    found.push(`${areas[0].actor}'s area attack will wake whatever ${sleeps[0].actor} puts to sleep`);
  }

  return found;
}

/**
 * Resolve one round: readied party actions, then the enemies, then upkeep.
 *
 * Initiative is by speed, party-before-enemy on a tie, then by id. Deterministic
 * on purpose — an agent that inspects speed should be able to predict order,
 * and a benchmark whose resolution order wobbles cannot attribute a loss to a
 * decision.
 */
export function resolveTick(
  state: DescentState,
  rng: Rng,
  performAbility: (state: DescentState, intent: Intent, out: TickResult) => void,
  enemyAct: (state: DescentState, enemy: Enemy, rng: Rng, out: TickResult) => void,
  beforeActions?: (state: DescentState, out: TickResult) => void,
): TickResult {
  /*
   * A *forked* stream, and this is not a detail.
   *
   * Drawing the damage roll from `rng` itself would advance the shared
   * generator on every blow, which shifts every subsequent draw in the tick —
   * who an enemy picks, which family spawns next, every price. This codebase
   * has been bitten by precisely that before: "adding a single `rng.int()` to
   * floor generation, for a field that had nothing to do with balance, shifted
   * every subsequent draw and took the organisation gap from 160 points to 33."
   *
   * Forked per tick, the variance is deterministic, reproducible, and
   * *invisible to everything else* — the dungeon plays out exactly as it did
   * before, and only the size of each blow moves.
   */
  return withCombatContext(rng.fork(`damage-${state.tick}`), state.tick, () =>
    resolveTickExact(state, rng, performAbility, enemyAct, beforeActions),
  );
}

function resolveTickExact(
  state: DescentState,
  rng: Rng,
  performAbility: (state: DescentState, intent: Intent, out: TickResult) => void,
  enemyAct: (state: DescentState, enemy: Enemy, rng: Rng, out: TickResult) => void,
  beforeActions?: (state: DescentState, out: TickResult) => void,
): TickResult {
  const standingAtStart = new Set(livingParty(state).map((f) => f.id));
  const windowsAtStart = new Set(
    livingEnemies(state)
      .filter((e) => e.windowOpen)
      .map((e) => e.ref),
  );
  const out: TickResult = {
    lines: [],
    beats: [],
    slain: [],
    downed: [],
    conflicts: [],
    mechanicsFired: [],
    wasted: [],
  };

  out.conflicts = antiSynergies(state, state.intents);
  beforeActions?.(state, out);

  // Start-of-tick damage over time, before anybody acts, so a burn can finish
  // something and the party sees why their target was already dead.
  for (const f of livingParty(state)) {
    const burn = getStatus(f, "burn");
    if (burn) {
      const dealt = hurtFighter(f, burn.amount, "fire");
      out.lines.push(`${f.id} takes ${dealt} from burning.`);
    }
    const poison = getStatus(f, "poison");
    if (poison) {
      const dealt = hurtFighter(f, poison.amount, "shadow");
      out.lines.push(`${f.id} takes ${dealt} from poison.`);
    }
    const regen = getStatus(f, "regen");
    if (regen && !f.dead) {
      const healed = Math.min(regen.amount, f.maxHp - f.hp);
      f.hp += healed;
      if (healed > 0) out.lines.push(`${f.id} recovers ${healed}.`);
    }
    const passive = equippedItemEffects(f)
      .filter((effect): effect is Extract<ItemEffect, { kind: "regeneration" }> => effect.kind === "regeneration")
      .reduce((sum, effect) => sum + effect.amount, 0);
    if (passive > 0 && !f.dead) {
      const healed = Math.min(passive, f.maxHp - f.hp);
      f.hp += healed;
      if (healed > 0) {
        out.lines.push(`${f.id}'s equipment restores ${healed}.`);
        out.beats.push({ kind: "heal", from: f.id, to: f.id, amount: healed, note: "item-regeneration" });
      }
    }
    if (f.dead) out.downed.push(f.id);
  }
  for (const e of livingEnemies(state)) {
    const burn = getStatus(e, "burn");
    if (burn) {
      const dealt = hurtEnemy(e, burn.amount, "fire");
      out.lines.push(`${e.name} takes ${dealt} from burning.`);
    }
    const poison = getStatus(e, "poison");
    if (poison) {
      const dealt = hurtEnemy(e, poison.amount, "shadow");
      out.lines.push(`${e.name} takes ${dealt} from poison.`);
    }
  }

  interface Actor {
    speed: number;
    side: 0 | 1;
    key: string;
    run: () => void;
  }
  const order: Actor[] = [];

  for (const intent of state.intents) {
    const f = state.party[intent.actor];
    if (!f || f.dead) {
      out.wasted.push({ actor: intent.actor, why: "down before the action resolved" });
      out.beats.push({ kind: "wasted", to: intent.actor, note: "down before the action resolved" });
      continue;
    }
    order.push({
      speed: f.speed,
      side: 0,
      key: intent.actor,
      run: () => {
        if (f.dead) {
          out.wasted.push({ actor: intent.actor, why: "down before the action resolved" });
          out.beats.push({ kind: "wasted", to: intent.actor, note: "down before the action resolved" });
          return;
        }
        if (incapacitated(f)) {
          const why = hasStatus(f, "sleep") ? "asleep" : hasStatus(f, "freeze") ? "frozen" : "stunned";
          out.wasted.push({ actor: intent.actor, why });
          out.beats.push({ kind: "wasted", to: intent.actor, note: why });
          out.lines.push(`${f.id} is ${why} and does nothing.`);
          return;
        }
        performAbility(state, intent, out);
      },
    });
  }

  for (const e of state.enemies) {
    if (!alive(e)) continue;
    order.push({
      speed: e.speed,
      side: 1,
      key: e.ref,
      run: () => {
        if (!alive(e)) return;
        e.age += 1;
        if (incapacitated(e)) {
          out.lines.push(`${e.name} is held and does nothing.`);
          return;
        }
        enemyAct(state, e, rng, out);
      },
    });
  }

  order.sort((a, b) => b.speed - a.speed || a.side - b.side || a.key.localeCompare(b.key));
  for (const actor of order) actor.run();

  // Deaths, and the mechanics that fire on them.
  for (const e of state.enemies) {
    if (e.hp <= 0 && !out.slain.includes(e)) {
      out.slain.push(e);
      out.beats.push({ kind: "death", to: e.ref });
      if (e.hidden.kind === "deathburst") {
        const burst = e.hidden;
        out.mechanicsFired.push({ family: e.family, kind: "deathburst" });
        out.lines.push(`${e.name} bursts as it dies.`);
        out.beats.push({ kind: "mechanic", from: e.ref, note: "deathburst" });
        for (const f of livingParty(state)) {
          const dealt = hurtFighter(f, burst.damage, burst.element);
          out.lines.push(`  ${f.id} takes ${dealt} ${burst.element}.`);
          out.beats.push({ kind: "hit", from: e.ref, to: f.id, amount: dealt, element: burst.element });
          if (f.dead) out.downed.push(f.id);
        }
      }
    }
  }
  state.enemies = state.enemies.filter((e) => alive(e));

  for (const f of CLASSES.map((c) => state.party[c])) {
    if (f.hp <= 0 && !f.dead) dropFighter(f, state.tick);
    // The clock. A body left long enough stops being one you can save, and
    // nobody has to do anything to make that happen — which is exactly the
    // point of it.
    if (!f.dead && f.downedAt !== null && state.tick - f.downedAt >= BLEED_OUT_ROUNDS) {
      f.dead = true;
      out.lines.push(`${f.id} stops breathing. Nobody reached them in time.`);
    }
    if (f.dead && standingAtStart.has(f.id)) {
      if (!out.downed.includes(f.id)) out.downed.push(f.id);
      out.beats.push({ kind: "death", to: f.id });
    }
  }

  // Upkeep: statuses age out.
  for (const who of [...CLASSES.map((c) => state.party[c]), ...state.enemies]) {
    for (const s of who.statuses) s.ticks -= 1;
    who.statuses = who.statuses.filter((s) => s.ticks > 0);
  }
  // A window that existed when the tick began has now been consumed. A window
  // opened by shield_slam during this tick survives through the next one.
  for (const e of state.enemies) if (windowsAtStart.has(e.ref)) e.windowOpen = false;

  state.intents = [];

  return out;
}
