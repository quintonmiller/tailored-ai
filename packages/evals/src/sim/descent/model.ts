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
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  /** Flat reduction against physical damage only. */
  armor: number;
  /** Scales everything this fighter deals. */
  power: number;
  /** Initiative. Ties break by party-before-enemy, then by id, so order is stable. */
  speed: number;
  statuses: Status[];
  gold: number;
  inventory: string[];
  equipped: { weapon?: string; armor?: string; trinket?: string };
  dead: boolean;
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

export interface DungeonRoom {
  id: string;
  label: string;
  kind: RoomKind;
  links: string[];
  x: number;
  y: number;
  visited: boolean;
  cleared: boolean;
}

export interface DungeonFloorMap {
  zone: string;
  currentRoom: string;
  rooms: DungeonRoom[];
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
  paths: Array<{ id: string; label: string; hint?: string; kind: string }>;
  /** Persistent graph for maze-enabled runs. Omitted by legacy/direct simulations. */
  map?: DungeonFloorMap;
  /** Unclaimed drops waiting for the `spoils` phase. */
  pending: Array<{ item: string; to: ClassId }>;
  /** Merchant stock, when there is a merchant. */
  stock: Array<{ item: string; price: number }>;
  /**
   * A dead expedition's packs, and how many of them the party may still take.
   *
   * The party finds more than it can carry out and has to agree on which. That
   * hard cap is the point: a purchase is settled privately out of one purse,
   * where a cache cannot be resolved by whoever happens to be richest.
   */
  cache: Array<{ item: string; taken?: ClassId }>;
  cacheTakesLeft: number;
  /** Whose expedition it was, for the prose. */
  cacheOrigin?: string;
  log: EncounterLog[];
  wiped: boolean;
  /** Ticks the party may still take. The scenario's external limit. */
  horizon: number;
}

export const CLASSES: ClassId[] = ["guardian", "mage", "rogue", "cleric", "ranger"];

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
export function computeDamage(
  raw: number,
  element: Element,
  target: DamageTarget,
): { dealt: number; absorbed: number } {
  const factor = target.resist?.[element] ?? 1;
  let amount = Math.max(factor === 0 ? 0 : 1, Math.round(Math.max(1, Math.round(raw)) * factor));

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
  if (f.hp === 0) f.dead = true;
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
  const candidates = livingParty(state);
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
      continue;
    }
    order.push({
      speed: f.speed,
      side: 0,
      key: intent.actor,
      run: () => {
        if (f.dead) {
          out.wasted.push({ actor: intent.actor, why: "down before the action resolved" });
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
    if (f.hp <= 0) f.dead = true;
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
