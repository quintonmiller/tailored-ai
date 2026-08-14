/**
 * The Endless Descent: five specialists, one dungeon, and no win condition.
 *
 * Every other scenario in this package asks whether a team can reach a state
 * somebody wrote down in advance. `the-machine` scores 98/98 on three runs of
 * three and `the-lock` was solved on its third; both are finished, permanently,
 * and each cost a session to author. A benchmark built that way has to be
 * re-authored every time it is beaten, which does not scale and is not how the
 * interesting question gets asked anyway.
 *
 * So this one has no answer. The dungeon goes down forever, gets harder on six
 * axes rather than one, and ends when the party is dead. The score is the
 * experience they earned on the way, which is continuous, comparative, and
 * cannot be saturated — a better organisation gets further, and there is always
 * a further to get.
 *
 * ## Where the difficulty comes from
 *
 * The measured lesson from `the-machine` is that difficulty in a multi-agent
 * scenario comes from the shape of the team, not the length of the chain: the
 * same puzzle scores 98/98 in one room and 32/52/107 split across two. Value
 * has to cross a boundary. Three mechanics here exist only to force that, and
 * they are the ones to keep if anything is ever cut:
 *
 *   private packs   `look` shows an ally's health and what they are wearing. It
 *                   does not show their inventory or their purse. A plate
 *                   cuirass in the mage's bag is invisible to the guardian
 *                   until the mage works out it is useless and says so.
 *   split sight     `inspect_enemy` returns a different slice per class, and no
 *                   slice is enough. The mage sees resistances; the guardian
 *                   sees armour; whoever is swinging sees neither.
 *   individual gold Nobody can afford the good item alone. `give_gold` exists
 *                   and nothing suggests using it.
 *
 * ## And the one thing nothing else here measures
 *
 * Ten enemy families each carry a hidden rule that no tool will ever reveal —
 * crystal reflects lightning, wisps detonate, bells punish healing. A family
 * met on floor 15 comes back stronger on floor 28, with the same rule. That gap
 * is longer than a context window, so it is the framework's memory being
 * measured rather than the model's attention. See `diagnostics.ts`.
 *
 * ## Actions are readied, not taken
 *
 * A combat tool call queues an intent; everything resolves together when the
 * round closes. That is what makes coordination failure possible — see the note
 * in `model.ts`. Non-combat actions resolve immediately.
 */

import type { Tool } from "@tailored-ai/core";
import { makeRng, type Rng } from "../rng.js";
import { agentTool, num } from "../tool.js";
import {
  registerSimulation,
  type SimEvent,
  type SimMetrics,
  type Simulation,
  type SimulationOptions,
  type SimulationReport,
} from "../types.js";
import {
  canEquip,
  equippableBy,
  FAMILIES,
  generateEncounter,
  generatePaths,
  ITEM_BY_ID,
  itemName,
  rollCache,
  rollLoot,
  rollStock,
} from "./content.js";

/**
 * The ranger's notes, keyed by family.
 *
 * Built from the bestiary rather than written twice, so a family added to
 * `content.ts` cannot end up with a behaviour line that describes a different
 * creature. Behaviour only — the hidden rule is never in here, which is the
 * whole reason the ranger's read is a hint and not an answer.
 */
const FAMILY_BEHAVIOUR = new Map<string, string>(FAMILIES.map((f) => [f.family, f.behaviour]));

import { Diagnostics } from "./diagnostics.js";
import {
  alive,
  antiSynergies,
  applyStatus,
  type Beat,
  CLASSES,
  type ClassId,
  clearStatus,
  type DescentState,
  type Element,
  type Enemy,
  type Fighter,
  getStatus,
  hasStatus,
  hurtEnemy,
  hurtFighter,
  type Intent,
  livingEnemies,
  livingParty,
  type Phase,
  resolveTick,
  type Status,
  type TickResult,
} from "./model.js";
import { DESCENT_POLICIES } from "./policies.js";

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

interface AbilityDef {
  owner: ClassId;
  mana?: number;
  cooldown?: number;
  target: "enemy" | "ally" | "none";
  description: string;
}

/**
 * One table, used for three things: declaring the tools, validating a call, and
 * letting a baseline policy pick a legal action without duplicating the rules.
 *
 * Three copies of "how much mana does lightning cost" is how a simulation ends
 * up with a bot that plays a slightly different game from the agents, and a
 * ladder that means nothing.
 */
export const ABILITIES: Record<string, AbilityDef> = {
  taunt: { owner: "guardian", cooldown: 2, target: "none", description: "Pull every enemy onto you for two rounds." },
  shield: { owner: "guardian", cooldown: 2, target: "ally", description: "Absorb damage for an ally." },
  shield_slam: {
    owner: "guardian",
    cooldown: 2,
    target: "enemy",
    description: "A stagger. Light damage, and it stuns.",
  },

  firebolt: { owner: "mage", mana: 8, target: "enemy", description: "Fire damage to one enemy." },
  frostbite: { owner: "mage", mana: 10, target: "enemy", description: "Frost damage, and it freezes for a round." },
  lightning: { owner: "mage", mana: 12, target: "enemy", description: "Heavy lightning damage to one enemy." },
  fireball: { owner: "mage", mana: 20, target: "none", description: "Fire damage to every enemy." },

  backstab: { owner: "rogue", cooldown: 1, target: "enemy", description: "Heavy physical damage to one enemy." },
  interrupt: {
    owner: "rogue",
    cooldown: 2,
    target: "enemy",
    description: "Stun one enemy for a round, stopping whatever it was winding up.",
  },
  sleep_powder: {
    owner: "rogue",
    cooldown: 3,
    target: "enemy",
    description: "Put one enemy to sleep. Any damage wakes it.",
  },
  vanish: { owner: "rogue", cooldown: 3, target: "none", description: "Drop all your threat." },

  heal: { owner: "cleric", mana: 10, target: "ally", description: "Restore health to one ally." },
  cleanse: {
    owner: "cleric",
    mana: 8,
    target: "ally",
    description: "Clear burning, poison and weakness from an ally.",
  },
  bless: { owner: "cleric", mana: 12, target: "ally", description: "An ally regenerates for three rounds." },
  sanctuary: {
    owner: "cleric",
    mana: 25,
    cooldown: 3,
    target: "none",
    description: "A small shield on the whole party.",
  },

  shoot: { owner: "ranger", target: "enemy", description: "Reliable physical damage at range." },
  mark: {
    owner: "ranger",
    cooldown: 1,
    target: "enemy",
    description: "Marked enemies take a quarter more damage from everyone.",
  },
  volley: { owner: "ranger", cooldown: 2, target: "none", description: "Lighter physical damage to every enemy." },
};

/**
 * How many trinkets the party may keep attuned at once.
 *
 * Two, against a party of five and a trinket pool anybody can wear. Scarce
 * enough that the second one is already a decision and the third is an
 * argument; not so scarce that the mechanic never comes up.
 */
export const ATTUNEMENT_SLOTS = 2;

/** Sentence-case, for prose that starts with a name the content table wrote lowercase. */
const cap = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** How many items a cache offers, and how many of them the party may leave with. */
export const CACHE_OFFERS = 6;
export const CACHE_TAKES = 2;

const BASE_STATS: Record<
  ClassId,
  Omit<Fighter, "id" | "statuses" | "inventory" | "equipped" | "dead" | "cooldowns" | "bonusHp">
> = {
  guardian: { hp: 130, maxHp: 130, mana: 0, maxMana: 0, armor: 8, power: 10, speed: 8, gold: 60, threat: 0, xp: 0 },
  mage: { hp: 68, maxHp: 68, mana: 60, maxMana: 60, armor: 1, power: 14, speed: 10, gold: 60, threat: 0, xp: 0 },
  rogue: { hp: 82, maxHp: 82, mana: 0, maxMana: 0, armor: 3, power: 13, speed: 15, gold: 60, threat: 0, xp: 0 },
  cleric: { hp: 90, maxHp: 90, mana: 65, maxMana: 65, armor: 3, power: 9, speed: 9, gold: 60, threat: 0, xp: 0 },
  ranger: { hp: 88, maxHp: 88, mana: 0, maxMana: 0, armor: 3, power: 12, speed: 12, gold: 60, threat: 0, xp: 0 },
};

/**
 * Level from total party experience. Growth is deliberately slower than depth.
 *
 * "Slower" is the whole design — the party's curve and the dungeon's curve have
 * to cross, or the run never ends. But the first attempt at this was slower by
 * so much that the party reached the floor-five boss at level two and lost to
 * arithmetic rather than to a decision, which measures nothing. The exponent is
 * what to move if the ladder ever compresses at the bottom.
 */
export function levelFor(xp: number): number {
  let level = 1;
  while (xp >= Math.round(100 * level ** 1.55)) level += 1;
  return level;
}

// ---------------------------------------------------------------------------

/**
 * The shape the broadcast draws.
 *
 * Declared rather than left implicit because four separate renderers were
 * written against it, and until this existed the only description of the
 * contract was a paragraph in `docs/broadcast-viewer.md`. A page is not
 * typechecked — the viewer is plain ES modules with no build step, on purpose —
 * so the compiler cannot catch a client reading `scene.hp` where the field is
 * `maxHp`. What it *can* catch is this end drifting: rename a field here and
 * every server-side use fails to compile, which turns a silent renderer bug
 * into a build error at the moment the rename happens.
 */
export interface DescentScene {
  floor: number;
  phase: Phase;
  tick: number;
  horizon: number;
  dread: number;
  level: number;
  earnedXp: number;
  party: Array<{
    id: ClassId;
    hp: number;
    maxHp: number;
    mana: number;
    maxMana: number;
    armor: number;
    power: number;
    speed: number;
    gold: number;
    dead: boolean;
    statuses: Array<{ kind: string; ticks: number; amount: number }>;
    pack: Array<{ id: string; name: string }>;
    worn: Array<{ slot: string; id: string; name: string }>;
    readied: { kind: string; target: string | null } | null;
  }>;
  enemies: Array<{
    ref: string;
    name: string;
    family: string;
    hp: number;
    maxHp: number;
    elite: boolean;
    boss: boolean;
    speed: number;
    statuses: Array<{ kind: string; ticks: number; amount: number }>;
    telegraph: string | null;
  }>;
  paths: Array<{ id: string; label: string; kind: string; hint: string | null }>;
  pendingPath: string | null;
  scouted: string | null;
  stock: Array<{ id: string; name: string; price: number }>;
  cache: Array<{ id: string; name: string; forClasses: string[]; taken: string | null }>;
  cacheTakesLeft: number;
  cacheOrigin: string | null;
  /**
   * What the readied actions will do to each other if the round closes now.
   *
   * Computed from the same pure `antiSynergies` the diagnostic uses, over the
   * intents queued *so far*. Deliberately broadcast-only: the party can already
   * see who has readied what, and cannot see this. That gap is the point — the
   * audience watches a fireball being aimed into the group the rogue just put
   * to sleep, several seconds before anybody in the party finds out.
   */
  clashes: string[];
  loot: Array<{ id: string; name: string; to: ClassId }>;
  beats: Beat[];
  /** Which tick the beats belong to — see the note on the field below. */
  beatsTick: number;
  log: string[];
}

export class DescentSimulation implements Simulation {
  readonly name = "descent";
  readonly state: DescentState;
  readonly events: SimEvent[] = [];
  readonly diag = new Diagnostics();

  private readonly rng: Rng;
  private readonly lootRng: Rng;
  private readonly encounterRng: Rng;
  private readonly pathRng: Rng;
  private readonly stockRng: Rng;

  private level = 1;
  private totalXp = 0;
  private goldEarned = 0;
  private goldSpent = 0;
  private bossesDefeated = 0;
  private elitesDefeated = 0;
  private enemiesDefeated = 0;
  private deaths = 0;
  private floorReached = 1;
  private readonly startFloor: number;
  private revives = 0;
  private lastLog: string[] = [];
  private lastBeats: Beat[] = [];
  private lastBeatsTick = -1;
  private encounterSerious = false;
  private descendRequested = false;
  /** Surface preparation ends together, so an early roster slot cannot strand the rest in the shop. */
  private enterRequested = false;
  /** Retreat is resolved at the round boundary, after enemies get one unanswered attack. */
  private retreatRequested = false;
  /** The encounter left behind by a retreat. The party may turn back to it from exploration. */
  private fledEnemies: Enemy[] | undefined;
  /** A party can take one rest action per simulation tick. */
  private lastRestTick = -1;
  /** Distinguishes separate caches for the sharing diagnostic. */
  private cacheSerial = 0;
  private pendingPath: string | undefined;
  /** Who has been handed gold, and what they held before it. See `buyItem`. */
  private readonly toppedUp = new Map<ClassId, number>();

  constructor(options: SimulationOptions) {
    const seed = options.seed ?? 1;
    this.rng = makeRng(seed);
    this.lootRng = this.rng.fork("loot");
    this.encounterRng = this.rng.fork("encounter");
    this.pathRng = this.rng.fork("path");
    this.stockRng = this.rng.fork("stock");

    const party = {} as Record<ClassId, Fighter>;
    for (const id of CLASSES) {
      party[id] = {
        id,
        ...BASE_STATS[id],
        statuses: [],
        inventory: [],
        equipped: {},
        dead: false,
        cooldowns: {},
        bonusHp: 0,
      };
    }
    const startFloor = Math.max(1, Math.floor(Number(options.startFloor ?? 1)));
    // The CLI's generic `--sim-option` parser cannot know a simulation's
    // schema, so booleans arrive as strings there and as booleans from a
    // scenario definition.
    const preparation = (options.preparation === true || options.preparation === "true") && startFloor === 1;
    if (preparation) {
      // The opening budget replaces a free, predetermined kit. The party has
      // enough to make several good choices, not enough to buy every role its
      // obvious best-in-slot item, and the two universal trinket slots make
      // pooling a genuinely shared decision before the first fight.
      const startingGold = Math.max(0, Math.floor(Number(options.startingGold ?? 180)));
      for (const id of CLASSES) party[id].gold = startingGold;
    } else {
      // Legacy/direct-start simulations retain the sparse fixed kit. Keeping
      // this path is useful for focused combat tests and custom scenarios.
      party.guardian.inventory.push("healing_potion");
      party.cleric.inventory.push("healing_potion", "antidote");
      party.mage.inventory.push("mana_potion");
    }
    this.startFloor = startFloor;

    this.state = {
      floor: startFloor,
      phase: preparation ? "camp" : "explore",
      tick: 0,
      party,
      enemies: [],
      intents: [],
      dread: 0,
      paths: generatePaths(startFloor, this.pathRng),
      pending: [],
      stock: preparation ? rollStock(1, this.stockRng) : [],
      cache: [],
      cacheTakesLeft: 0,
      log: [],
      wiped: false,
      horizon: typeof options.days === "number" ? options.days : 400,
    };
    this.floorReached = startFloor;
    if (startFloor > 1) this.equipForDepth(startFloor);
    if (preparation) {
      this.lastLog = ["The party stands outside the first stair with money, empty packs, and one chance to prepare."];
    }
  }

  /**
   * Start a party partway down, as if they had walked there.
   *
   * Not a convenience. An agent run has a tick budget, and measured against the
   * baselines a forty-tick run from floor one reaches about floor eleven — which
   * is *above* the floor where anything interesting starts. Hidden mechanics
   * appear at fifteen and recur at twenty-eight, so a run that stops at eleven
   * cannot measure memory at all, and `tactics-only`, `rule-based` and `oracle`
   * all finish within fifteen percent of each other. The ladder has no
   * resolution in the shallows.
   *
   * So the scenario starts them in the band that discriminates, with the levels,
   * purses and gear a party that walked there would have. `descent-sim.test.ts`
   * checks that against a party that actually walked.
   */
  /**
   * Experience the party was handed at the start, which is not theirs.
   *
   * `totalXp` includes it, so scoring on that would credit a run of floor 26
   * with the eighteen thousand it was given for standing there — every
   * threshold in the scenario would pass on tick zero. What the run is worth is
   * what it *earned*, so that is the objective and that is what the ladder
   * ranks.
   */
  private grantedXp = 0;

  private equipForDepth(floor: number): void {
    // Fitted to what a `rule-based` party actually holds when it arrives, over
    // twenty seeds: 1,433 experience at floor 8, 3,298 at 12, 15,003 at 25. The
    // first version of this guessed a curve about fifteen percent high and
    // handed the party five extra levels, which showed up immediately as a
    // ladder where nobody died and a random party out-scored a competent one.
    this.totalXp = Math.round(19 * floor ** 2.07);
    this.grantedXp = this.totalXp;
    this.level = levelFor(this.totalXp);

    const kit: Record<ClassId, string[]> = {
      guardian: ["iron_sword", "plate_cuirass"],
      mage: ["oak_staff", "silk_robe"],
      rogue: ["fang_dagger", "shadow_leathers"],
      cleric: ["oak_staff", "silk_robe"],
      ranger: ["yew_bow", "shadow_leathers"],
    };
    for (const id of CLASSES) {
      const f = this.state.party[id];
      for (const item of kit[id]) {
        const def = ITEM_BY_ID.get(item);
        if (def && (def.kind === "weapon" || def.kind === "armor")) f.equipped[def.kind] = item;
      }
      f.gold = Math.round((this.totalXp * 0.63) / CLASSES.length);
      this.effective(f);
      f.hp = f.maxHp;
      f.mana = f.maxMana;
    }
    this.state.party.cleric.inventory.push("greater_potion");
    this.state.party.guardian.inventory.push("healing_potion");
    this.state.party.ranger.inventory.push("soul_stone");
  }

  get day(): number {
    return this.state.tick;
  }

  get done(): boolean {
    return this.state.wiped || this.state.tick >= this.state.horizon;
  }

  get endedBecause(): string | undefined {
    if (this.state.wiped) return `the party was wiped out on floor ${this.state.floor}`;
    if (this.state.tick >= this.state.horizon) return `the run reached its tick limit on floor ${this.state.floor}`;
    return undefined;
  }

  /**
   * What counts as answering an event, for the organisational-latency metric.
   *
   * The entries worth having are the ones a *different* agent answers than the
   * one who could see the event — a wisp detonating is seen by everybody and
   * answered by whoever stops using area damage on the next one.
   */
  readonly responses: Record<string, string[]> = {
    encounter: ["inspect_enemy", "read_beast", "look"],
    mechanic: ["inspect_enemy", "read_beast"],
    down: ["heal", "revive", "use_item", "shield"],
    loot: ["trade_item", "equip_item", "give_gold"],
    merchant: ["buy", "give_gold", "sell"],
    cache: ["take", "trade_item", "equip_item", "unequip"],
    boss: ["inspect_enemy", "read_beast", "taunt", "interrupt", "mark"],
  };

  // -------------------------------------------------------------------------
  // Prose
  // -------------------------------------------------------------------------

  announce(): string {
    const s = this.state;
    const head = `Floor ${s.floor} — ${s.phase}${s.dread >= 4 ? ` (something is closing in: dread ${s.dread})` : ""}.`;
    if (this.lastLog.length === 0) {
      if (s.phase === "camp") return `${head} The outfitter's wagon is open before the first stair.`;
      if (s.phase === "explore") return `${head} Four ways on; somebody has to choose one.`;
      if (s.phase === "spoils") return `${head} The fight is over. Nothing moves until somebody descends.`;
      if (s.phase === "market") return `${head} A merchant is here.`;
      if (s.phase === "cache") return `${head} A dead expedition's packs are here; the party can carry two things out.`;
      return head;
    }
    return `${head}\n${this.lastLog.slice(0, 14).join("\n")}`;
  }

  private enemyLine(e: Enemy): string {
    const band = e.hp / e.maxHp;
    const health = band > 0.85 ? "untouched" : band > 0.6 ? "hurt" : band > 0.35 ? "badly hurt" : "nearly down";
    const marks = e.statuses.filter((s) => s.ticks > 0).map((s) => s.kind);
    const tail = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
    const tel = e.telegraph ? ` — ${e.telegraph}` : "";
    return `  ${e.ref}: ${e.name}, ${health}${tail}${tel}`;
  }

  private sheet(f: Fighter, full: boolean): string {
    const st = f.statuses.filter((s) => s.ticks > 0).map((s) => `${s.kind}(${s.ticks})`);
    const status = st.length > 0 ? ` [${st.join(", ")}]` : "";
    if (f.dead) return `  ${f.id}: DOWN`;
    const mana = f.maxMana > 0 ? `, mana ${f.mana}/${f.maxMana}` : "";
    if (!full) {
      const worn = Object.values(f.equipped)
        .filter(Boolean)
        .map((i) => itemName(i as string));
      const wearing = worn.length > 0 ? `, wearing ${worn.join(" + ")}` : "";
      return `  ${f.id}: ${f.hp}/${f.maxHp} hp${mana}${status}${wearing}`;
    }
    const cds = Object.entries(f.cooldowns)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}(${v})`);
    // Ids, not display names. Every tool takes `healing_potion`, so a pack that
    // reads "Healing Potion" is an invitation to call `use_item` with a string
    // the simulation will refuse — a refusal caused by the interface rather
    // than by the decision, which is exactly the kind of noise that makes a
    // tool-correctness diagnostic worthless.
    const pack = f.inventory.map((i) => `${i} (${itemName(i)})`);
    return [
      `  ${f.id}: ${f.hp}/${f.maxHp} hp${mana}${status}`,
      `  armour ${f.armor}, power ${f.power}, speed ${f.speed}`,
      `  purse ${f.gold} gold`,
      `  pack: ${pack.length > 0 ? pack.join(", ") : "(empty)"}`,
      `  worn: ${
        Object.entries(f.equipped)
          .filter(([, v]) => v)
          .map(([slot, v]) => `${slot} ${v} (${itemName(v as string)})`)
          .join(", ") || "(nothing)"
      }`,
      cds.length > 0 ? `  cooling down: ${cds.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * What one agent can see.
   *
   * An ally's health and armour are visible because you are standing next to
   * them. Their pack and their purse are not, and that is the single most
   * load-bearing omission in the scenario: it is what turns "the plate landed
   * on the mage" from a bookkeeping error into a conversation somebody has to
   * start.
   */
  /**
   * What one agent's `look` returns, addressable by name.
   *
   * Exposed because the per-agent slices — private packs, private purses, and
   * the scout's private report — are the load-bearing part of the design, and
   * a test that cannot ask "what does the cleric see?" cannot check any of
   * them.
   */
  describeFor(who: string): string {
    return this.describe(who as ClassId);
  }

  private describe(who: ClassId | undefined): string {
    const s = this.state;
    const me = who && s.party[who] ? s.party[who] : undefined;
    const out: string[] = [];
    out.push(`Floor ${s.floor}, phase ${s.phase}, tick ${s.tick} of ${s.horizon}. Dread ${s.dread}.`);
    out.push(`Party experience ${this.totalXp}, level ${this.level}.`);

    if (me) {
      out.push("", "You:");
      out.push(this.sheet(me, true));
    }
    out.push("", "The others (you can see their condition and what they are wearing, not their packs or purses):");
    for (const id of CLASSES) {
      if (id === who) continue;
      out.push(this.sheet(s.party[id], false));
    }

    if (s.phase === "combat") {
      out.push("", `Against you (${livingEnemies(s).length}):`);
      for (const e of livingEnemies(s)) out.push(this.enemyLine(e));
      if (s.intents.length > 0) {
        out.push("", "Readied this round:");
        for (const i of s.intents) out.push(`  ${i.actor}: ${i.kind}${i.target ? ` → ${i.target}` : ""}`);
      }
    }

    if (s.phase === "explore") {
      out.push("", "Ways on:");
      for (const p of s.paths) out.push(`  ${p.id}: ${p.label}${p.hint ? ` (${p.hint})` : ""}`);
      // The scout's findings belong to the scout. Everybody else is told only
      // that somebody went and came back, which is the prompt to go and ask.
      if (this.scoutReport && this.scoutedFloor === s.floor) {
        if (who === "rogue") out.push("", "What you saw ahead (nobody else knows any of this):", this.scoutReport);
        else out.push("  rogue went ahead and came back. Whatever they saw, they have not said yet.");
      }
      out.push(
        this.pendingPath
          ? `  The party is set to take the ${this.pendingPath} way when the round closes.`
          : "  Nobody has chosen yet.",
      );
    }

    if (s.phase === "market" || s.phase === "camp") {
      out.push("", s.phase === "camp" ? "The surface outfitter has:" : "The merchant has:");
      for (const item of s.stock) {
        const def = ITEM_BY_ID.get(item.item);
        out.push(`  ${item.item} — ${def?.name}, ${item.price} gold. ${def?.desc ?? ""}`);
      }
      out.push(
        s.phase === "camp"
          ? "  Buy, sell, pool gold, trade, and equip here. Call `enter_dungeon` when the party is ready."
          : "  Call `descend` when the party is finished here.",
      );
    }

    if (s.phase === "cache") {
      out.push("", `What is left of ${s.cacheOrigin ?? "an expedition"}. Their packs hold:`);
      for (const entry of s.cache) {
        const def = ITEM_BY_ID.get(entry.item);
        // Who can use it is spelled out, because the interesting argument is
        // about that and not about remembering the class table.
        const fit = def && def.kind !== "consumable" && def.classes ? ` — for ${def.classes.join(" or ")}` : "";
        out.push(
          entry.taken
            ? `  ${entry.item} — ${def?.name}${fit}. Taken by ${entry.taken}.`
            : `  ${entry.item} — ${def?.name}${fit}. ${def?.desc ?? ""}`,
        );
      }
      out.push(
        s.cacheTakesLeft > 0
          ? `  The party can carry ${s.cacheTakesLeft} more of these out. Everything else stays. Use \`take\`.`
          : "  The party is carrying all it can from here.",
      );
      out.push("  Call `descend` when the party is finished here.");
    }

    if (s.phase === "spoils") {
      if (s.pending.length > 0) {
        out.push("", "Picked up:");
        for (const p of s.pending) out.push(`  ${p.item} (${itemName(p.item)}) → went into ${p.to}'s pack`);
      }
      out.push("", "Nothing happens until somebody calls `descend`. Dread rises while you stay.");
    }

    if (this.lastLog.length > 0) {
      out.push("", "Last round:");
      for (const line of this.lastLog.slice(0, 16)) out.push(`  ${line}`);
    }
    return out.join("\n");
  }

  // -------------------------------------------------------------------------
  // Ability resolution
  // -------------------------------------------------------------------------

  private findEnemy(ref: string): Enemy | undefined {
    const exact = this.state.enemies.find((e) => e.ref === ref && alive(e));
    if (exact) return exact;
    const lowered = ref.toLowerCase().trim();
    return this.state.enemies.find(
      (e) => alive(e) && (e.ref.toLowerCase() === lowered || e.name.toLowerCase() === lowered),
    );
  }

  /**
   * Damage lands, and anything the target does about it happens here.
   *
   * `reflect` is the reason this is one function rather than inline arithmetic
   * at six call sites: the rule has to fire for every source of that element,
   * including a fireball that happened to catch a crystal in the blast, or the
   * party learns "do not cast lightning" and then relearns it from area damage.
   */
  private strike(from: Fighter, target: Enemy, raw: number, element: Element, out: TickResult): number {
    const dealt = hurtEnemy(target, raw, element);
    out.beats.push({ kind: "hit", from: from.id, to: target.ref, amount: dealt, element });
    from.threat += dealt * 0.6;
    const factor = target.resist[element] ?? 1;
    this.diag.recordAttack(
      target.ref,
      element === "physical" ? 1 : factor,
      element === "physical" && target.armor >= 12,
    );

    if (target.hidden.kind === "reflect" && target.hidden.element === element && dealt > 0) {
      const back = Math.round(dealt * target.hidden.fraction);
      const took = hurtFighter(from, back, element);
      out.lines.push(`${element} arcs back off ${target.name}'s facets — ${from.id} takes ${took}.`);
      out.beats.push({ kind: "mechanic", from: target.ref, to: from.id, amount: took, element, note: "reflect" });
      out.mechanicsFired.push({ family: target.family, kind: "reflect" });
      if (from.dead) out.downed.push(from.id);
    }
    return dealt;
  }

  private performAbility = (state: DescentState, intent: Intent, out: TickResult): void => {
    const actor = state.party[intent.actor];
    const kind = intent.kind;

    const enemyTarget = intent.target ? this.findEnemy(intent.target) : undefined;
    const needsEnemy = ABILITIES[kind]?.target === "enemy" || kind === "attack";
    if (needsEnemy && !enemyTarget) {
      out.wasted.push({ actor: actor.id, why: "the target was already dead" });
      out.lines.push(`${actor.id} swings at nothing; ${intent.target} was already down.`);
      return;
    }

    const power = actor.power * (hasStatus(actor, "weaken") ? 0.6 : 1);
    const say = (t: string) => out.lines.push(t);

    switch (kind) {
      case "attack": {
        const dealt = this.strike(actor, enemyTarget as Enemy, power, "physical", out);
        say(`${actor.id} hits ${(enemyTarget as Enemy).name} for ${dealt}.`);
        break;
      }
      case "defend": {
        out.beats.push({ kind: "guard", to: actor.id });
        applyStatus(actor, { kind: "guard", ticks: 1, amount: 0 });
        applyStatus(actor, { kind: "shield", ticks: 1, amount: Math.round(actor.power * 1.2) });
        say(`${actor.id} guards.`);
        break;
      }
      case "use_item": {
        this.consume(actor, intent.what as string, intent.target, out);
        break;
      }

      // Guardian ------------------------------------------------------------
      case "taunt": {
        applyStatus(actor, { kind: "taunt", ticks: 2, amount: 0, source: "any" });
        out.beats.push({ kind: "status", to: actor.id, note: "taunt" });
        actor.threat += 40;
        say(`${actor.id} roars; everything turns to face them.`);
        break;
      }
      case "shield": {
        const ally = state.party[(intent.target ?? "") as ClassId];
        if (!ally || ally.dead) {
          out.wasted.push({ actor: actor.id, why: "no such ally standing" });
          break;
        }
        applyStatus(ally, { kind: "shield", ticks: 3, amount: Math.round(actor.power * 2.6) });
        out.beats.push({ kind: "shield", from: actor.id, to: ally.id, amount: Math.round(actor.power * 2.6) });
        say(`${actor.id} puts a shield on ${ally.id} (${Math.round(actor.power * 2.6)}).`);
        break;
      }
      case "shield_slam": {
        const target = enemyTarget as Enemy;
        const dealt = this.strike(actor, target, power * 0.8, "physical", out);
        applyStatus(target, { kind: "stun", ticks: 1, amount: 0 });
        if (target.hidden.kind === "windowAfter" && target.hidden.move === "shield_slam") {
          target.windowOpen = true;
          say(`${actor.id} slams ${target.name} for ${dealt}. It staggers, and its guard drops.`);
        } else {
          say(`${actor.id} slams ${target.name} for ${dealt}; it is stunned.`);
        }
        break;
      }

      // Mage ----------------------------------------------------------------
      case "firebolt":
      case "lightning":
      case "frostbite": {
        const element: Element = kind === "firebolt" ? "fire" : kind === "lightning" ? "lightning" : "frost";
        const scale = kind === "lightning" ? 1.9 : kind === "firebolt" ? 1.6 : 1.2;
        const target = enemyTarget as Enemy;
        const dealt = this.strike(actor, target, power * scale, element, out);
        if (kind === "firebolt") applyStatus(target, { kind: "burn", ticks: 2, amount: Math.round(power * 0.3) });
        if (kind === "frostbite" && alive(target)) applyStatus(target, { kind: "freeze", ticks: 1, amount: 0 });
        say(`${actor.id} casts ${kind} at ${target.name} for ${dealt}.`);
        break;
      }
      case "fireball": {
        const targets = livingEnemies(state);
        const parts: string[] = [];
        for (const e of targets) parts.push(`${e.name} ${this.strike(actor, e, power * 1.1, "fire", out)}`);
        say(`${actor.id} throws a fireball: ${parts.join(", ")}.`);
        break;
      }

      // Rogue ---------------------------------------------------------------
      case "backstab": {
        const target = enemyTarget as Enemy;
        const bonus = hasStatus(target, "sleep") || hasStatus(target, "stun") ? 1.5 : 1;
        const dealt = this.strike(actor, target, power * 1.9 * bonus, "physical", out);
        say(`${actor.id} drives a blade into ${target.name} for ${dealt}${bonus > 1 ? " (it never saw it)" : ""}.`);
        break;
      }
      case "interrupt": {
        const target = enemyTarget as Enemy;
        applyStatus(target, { kind: "stun", ticks: 1, amount: 0 });
        const stopped = target.telegraph;
        target.telegraph = undefined;
        say(
          stopped
            ? `${actor.id} cuts ${target.name} off — ${stopped} — and it comes to nothing.`
            : `${actor.id} staggers ${target.name}.`,
        );
        break;
      }
      case "sleep_powder": {
        const target = enemyTarget as Enemy;
        applyStatus(target, { kind: "sleep", ticks: 2, amount: 0 });
        say(`${actor.id} puts ${target.name} to sleep. Anything that hits it will wake it.`);
        break;
      }
      case "vanish": {
        actor.threat = 0;
        clearStatus(actor, "taunt");
        say(`${actor.id} steps out of sight.`);
        break;
      }

      // Cleric --------------------------------------------------------------
      case "heal":
      case "bless":
      case "cleanse": {
        const ally = state.party[(intent.target ?? "") as ClassId];
        if (!ally || ally.dead) {
          out.wasted.push({ actor: actor.id, why: "no such ally standing" });
          break;
        }
        if (kind === "heal") {
          const anti = hasStatus(ally, "antiheal") ? 0.4 : 1;
          const healed = Math.min(Math.round(power * 2.4 * anti), ally.maxHp - ally.hp);
          ally.hp += healed;
          out.beats.push({ kind: "heal", from: actor.id, to: ally.id, amount: healed });
          say(`${actor.id} heals ${ally.id} for ${healed}${anti < 1 ? " (something is smothering it)" : ""}.`);
        } else if (kind === "bless") {
          applyStatus(ally, { kind: "regen", ticks: 3, amount: Math.round(power * 0.8) });
          say(`${actor.id} blesses ${ally.id}.`);
        } else {
          for (const s of ["burn", "poison", "weaken"] as const) clearStatus(ally, s);
          say(`${actor.id} cleanses ${ally.id}.`);
        }
        // Two families punish this, and neither says so until it happens.
        for (const e of livingEnemies(state)) {
          if (e.hidden.kind === "punishHeal") {
            // Mana *and* blood. Mana alone was not a punishment: it comes back
            // on its own every tick, so the party could pay it forever and the
            // lesson never became worth learning.
            actor.mana = Math.max(0, actor.mana - e.hidden.drain);
            const bled = hurtFighter(actor, Math.round(e.hidden.drain * 1.6), "shadow");
            say(`${e.name} turns toward ${actor.id}: ${e.hidden.drain} mana gone, and ${bled} with it.`);
            out.mechanicsFired.push({ family: e.family, kind: "punishHeal" });
            if (actor.dead) out.downed.push(actor.id);
          }
          if (e.hidden.kind === "tollHeal") applyStatus(ally, { kind: "mark", ticks: 1, amount: 0, source: "healed" });
        }
        break;
      }
      case "sanctuary": {
        for (const f of livingParty(state))
          applyStatus(f, { kind: "shield", ticks: 2, amount: Math.round(power * 1.1) });
        say(`${actor.id} raises a sanctuary over the party.`);
        break;
      }

      // Ranger --------------------------------------------------------------
      case "shoot": {
        const target = enemyTarget as Enemy;
        const dealt = this.strike(actor, target, power * 1.25, "physical", out);
        say(`${actor.id} puts an arrow into ${target.name} for ${dealt}.`);
        break;
      }
      case "mark": {
        const target = enemyTarget as Enemy;
        applyStatus(target, { kind: "mark", ticks: 3, amount: 0 });
        say(`${actor.id} marks ${target.name}; everything hits it harder now.`);
        break;
      }
      case "volley": {
        const parts: string[] = [];
        for (const e of livingEnemies(state))
          parts.push(`${e.name} ${this.strike(actor, e, power * 0.7, "physical", out)}`);
        say(`${actor.id} looses a volley: ${parts.join(", ")}.`);
        break;
      }
      default:
        out.wasted.push({ actor: actor.id, why: `unknown action ${kind}` });
    }
  };

  /**
   * How an enemy spends its turn.
   *
   * Ordinary families do one thing. Bosses run a script with a telegraph, which
   * is the only place in the simulation where the correct play is legible in
   * advance and still needs five agents to agree in one round about who does
   * it.
   */
  private enemyAct = (state: DescentState, e: Enemy, rng: Rng, out: TickResult): void => {
    const say = (t: string) => out.lines.push(t);
    const enraged = e.hidden.kind === "enrage" && e.hp / e.maxHp <= e.hidden.threshold;
    const power = e.power * (enraged ? (e.hidden as { multiplier: number }).multiplier : 1);
    if (enraged && !e.statuses.some((s) => s.kind === "weaken")) {
      out.mechanicsFired.push({ family: e.family, kind: "enrage" });
    }

    const bite = (target: Fighter, raw: number, element: Element = "physical", label = "hits") => {
      const dealt = hurtFighter(target, raw, element);
      out.beats.push({ kind: "hit", from: e.ref, to: target.id, amount: dealt, element });
      say(`${e.name} ${label} ${target.id} for ${dealt}.`);
      if (target.dead) {
        out.downed.push(target.id);
        say(`${target.id} goes down.`);
      }
    };

    // Bells keep count, and what they punish is whatever was healed last tick.
    if (e.hidden.kind === "tollHeal") {
      const period = e.hidden.period;
      if (e.age % period === 0) {
        const healed = livingParty(state).filter((f) => getStatus(f, "mark")?.source === "healed");
        e.telegraph = undefined;
        if (healed.length > 0) {
          say(`${e.name} tolls.`);
          out.mechanicsFired.push({ family: e.family, kind: "tollHeal" });
          for (const f of healed) bite(f, e.hidden.damage, "shadow", "rings through");
        } else {
          say(`${e.name} tolls, and nothing answers it.`);
        }
        return;
      }
      if ((e.age + 1) % period === 0) e.telegraph = "drawing breath to toll";
    }

    if (e.boss) {
      this.bossAct(e, power, bite, say, rng);
      return;
    }

    const target = this.pick(state, e, rng);
    if (!target) return;
    bite(target, power);
  };

  /**
   * Who this enemy goes for.
   *
   * Taunt wins, then the family's own rule, then threat. `focusWounded` only
   * counts as *fired* when it actually diverts the attack — a shaman that would
   * have hit the wounded target anyway has taught the party nothing, and
   * recording it would inflate the memory ledger with lessons nobody was shown.
   */
  private pick(state: DescentState, e: Enemy, rng: Rng): Fighter | undefined {
    const candidates = livingParty(state);
    if (candidates.length === 0) return undefined;
    const taunted = candidates.find((f) => hasStatus(f, "taunt"));
    if (taunted) return taunted;

    const max = Math.max(...candidates.map((f) => f.threat));
    const top = candidates.filter((f) => f.threat >= max - 0.001);
    const byThreat = top[rng.int(0, top.length - 1)];

    if (e.hidden.kind === "focusWounded") {
      const wounded = [...candidates].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id.localeCompare(b.id))[0];
      if (wounded.id !== byThreat.id && wounded.hp / wounded.maxHp < 0.75) {
        this.diag.recordMechanic(e.family, "focusWounded");
        return wounded;
      }
    }
    return byThreat;
  }

  private bossAct(
    e: Enemy,
    power: number,
    bite: (t: Fighter, raw: number, element?: Element, label?: string) => void,
    say: (t: string) => void,
    rng: Rng,
  ): void {
    const state = this.state;
    const party = livingParty(state);
    if (party.length === 0) return;

    switch (e.family) {
      case "iron-saint": {
        // Half strength summons two attendants, once.
        if (e.hp / e.maxHp <= 0.5 && e.bossPhase === 1) {
          e.bossPhase = 2;
          // Its own family, not `void`. Borrowing one would credit the party
          // with a void lesson they were never taught, and the memory ledger
          // is only worth anything if every entry in it was actually shown.
          const attendant = (n: number): Enemy => ({
            ref: `saint-attendant-${n}`,
            name: "Attendant of the Saint",
            family: "saint-attendant",
            hp: Math.round(e.maxHp * 0.12),
            maxHp: Math.round(e.maxHp * 0.12),
            armor: 4,
            power: Math.round(power * 0.35),
            speed: 14,
            resist: { holy: 0.5 },
            statuses: [],
            hidden: { kind: "punishHeal", drain: 12 },
            elite: false,
            boss: false,
            xp: 40,
            gold: 30,
            age: 0,
          });
          state.enemies.push(attendant(1), attendant(2));
          say(`${e.name} strikes the floor and two attendants rise. They are watching your healer.`);
          return;
        }
        if (e.age % 3 === 0) {
          const weakest = [...party].sort((a, b) => a.hp - b.hp)[0];
          e.telegraph = undefined;
          say(`${e.name} completes its count of three and reaches for ${weakest.id}.`);
          bite(weakest, power * 2.6, "holy", "executes");
          return;
        }
        if (e.age % 4 === 0) {
          e.telegraph = undefined;
          applyStatus(e, { kind: "shield", ticks: 3, amount: Math.round(e.maxHp * 0.25) });
          say(`${e.name} gathers light into a shell. Nobody stopped it.`);
          return;
        }
        if ((e.age + 1) % 3 === 0) e.telegraph = "counting — three";
        else if ((e.age + 1) % 4 === 0) e.telegraph = "gathering light";
        bite(this.pick(state, e, rng) ?? party[0], power);
        return;
      }
      case "hollow-choir": {
        if (e.age % 3 === 0) {
          say(`${e.name} opens into a chord.`);
          for (const f of party) bite(f, power * 0.75, "shadow", "rolls over");
          return;
        }
        bite(this.pick(state, e, rng) ?? party[0], power, "shadow");
        return;
      }
      case "gate-warden": {
        if (e.age % 4 === 0) {
          e.telegraph = undefined;
          say(`${e.name} brings the slab down.`);
          for (const f of party) bite(f, power * 0.8);
          return;
        }
        if ((e.age + 1) % 4 === 0) e.telegraph = "raising the slab";
        bite(this.pick(state, e, rng) ?? party[0], power * 1.2);
        return;
      }
      case "ashen-alpha": {
        const enraged = e.hp / e.maxHp <= 0.45;
        bite(this.pick(state, e, rng) ?? party[0], power);
        if (enraged) {
          const second = this.pick(state, e, rng);
          if (second) bite(second, power * 0.8, "physical", "wheels and takes");
        }
        return;
      }
      default:
        bite(this.pick(state, e, rng) ?? party[0], power);
    }
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  private consume(actor: Fighter, item: string, target: string | undefined, out: TickResult): void {
    const def = ITEM_BY_ID.get(item);
    const say = (t: string) => out.lines.push(t);
    if (!def || !actor.inventory.includes(item)) {
      out.wasted.push({ actor: actor.id, why: `no ${item} in the pack` });
      return;
    }
    const ally = target && this.state.party[target as ClassId] ? this.state.party[target as ClassId] : actor;
    actor.inventory.splice(actor.inventory.indexOf(item), 1);
    this.diag.recordConsumable(item, this.encounterSerious);

    switch (item) {
      case "healing_potion": {
        const healed = Math.min(45, ally.maxHp - ally.hp);
        ally.hp += healed;
        say(`${actor.id} gives ${ally.id} a potion (${healed}).`);
        break;
      }
      case "greater_potion": {
        const healed = Math.min(Math.round(ally.maxHp * 0.8), ally.maxHp - ally.hp);
        ally.hp += healed;
        say(`${actor.id} breaks a greater potion over ${ally.id} (${healed}).`);
        break;
      }
      case "mana_potion": {
        const gained = Math.min(40, ally.maxMana - ally.mana);
        ally.mana += gained;
        say(`${actor.id} hands ${ally.id} a mana potion (${gained}).`);
        break;
      }
      case "antidote": {
        for (const s of ["poison", "burn", "weaken"] as const) clearStatus(ally, s);
        say(`${actor.id} clears ${ally.id}.`);
        break;
      }
      case "bomb": {
        for (const e of livingEnemies(this.state)) {
          const dealt = this.strike(actor, e, 46, "fire", out);
          say(`  the bomb catches ${e.name} for ${dealt}.`);
        }
        break;
      }
      case "smoke_bomb": {
        for (const f of livingParty(this.state)) {
          f.threat = 0;
          clearStatus(f, "taunt");
        }
        say(`${actor.id} drops a smoke bomb; everything loses its grip on who to hit.`);
        break;
      }
      case "elixir": {
        ally.bonusHp += 30;
        ally.maxHp += 30;
        ally.hp += 30;
        say(`${actor.id} gives ${ally.id} an elixir; they are permanently sturdier.`);
        break;
      }
      default:
        say(`${actor.id} uses ${def.name}, and nothing much happens.`);
    }
  }

  /**
   * Recompute a fighter's numbers from base, level and what they are wearing.
   *
   * A recompute rather than an increment, because incrementing is how a party
   * ends up with a guardian whose armour went up seven times from equipping and
   * unequipping the same cuirass. Everything permanent that is *not* derivable
   * from those three inputs — elixirs — lives in `bonusHp` and is added back.
   */
  private effective(f: Fighter): void {
    const base = BASE_STATS[f.id];
    const lvl = this.level - 1;
    let maxHp = base.maxHp + lvl * 16;
    let maxMana = base.maxMana + (base.maxMana > 0 ? lvl * 10 : 0);
    let armor = base.armor + Math.floor(lvl * 0.6);
    // Damage per level, and the party's half of the pacing contract in
    // `depthScale`. Raised from 2.4 because it is the *depth-targeted* lever:
    // a level-1 party is untouched and a level-40 one hits a quarter harder,
    // which is exactly where encounters were running long. Health per level is
    // deliberately left alone — the party is meant to get more fragile with
    // depth, and that gap is what ends a run.
    let power = base.power + lvl * 3;
    let speed = base.speed;
    for (const id of Object.values(f.equipped)) {
      const def = id ? ITEM_BY_ID.get(id) : undefined;
      if (!def) continue;
      maxHp += def.hp ?? 0;
      maxMana += def.mana ?? 0;
      armor += def.armorBonus ?? 0;
      power += def.power ?? 0;
      speed += def.speed ?? 0;
    }
    f.maxHp = maxHp + f.bonusHp;
    f.maxMana = maxMana;
    f.armor = armor;
    f.power = Math.round(power);
    f.speed = speed;
    f.hp = Math.min(f.hp, f.maxHp);
    f.mana = Math.min(f.mana, f.maxMana);
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private note(kind: string, message: string, visibleTo?: string[]): void {
    this.events.push({ day: this.state.tick, kind, message, ...(visibleTo ? { visibleTo } : {}) });
  }

  private beginEncounter(elite: boolean): void {
    const s = this.state;
    s.enemies = generateEncounter(s.floor, s.dread, elite, this.encounterRng);
    s.phase = "combat";
    this.scoutReport = undefined;
    this.encounterSerious = elite || s.floor % 5 === 0 || s.enemies.length >= 4;
    this.diag.recordEncounter(s.enemies.map((e) => e.family));
    for (const f of livingParty(s)) f.threat = 0;
    const roster = s.enemies.map((e) => `${e.ref} (${e.name})`).join(", ");
    this.note(s.enemies[0]?.boss ? "boss" : "encounter", `Floor ${s.floor}: ${roster}.`);
    this.lastLog = [`Something is here: ${roster}.`];
  }

  private endEncounter(): void {
    const s = this.state;
    s.phase = "spoils";
    s.pending = [];
    this.descendRequested = false;
    // Clearing a room buys quiet back. Without this the only way down from a
    // high dread is the stairs, so a party that lingered once carried the
    // penalty through every remaining encounter on the floor.
    s.dread = Math.max(0, s.dread - 3);
    const gold = this.slainGold;
    this.slainGold = 0;
    if (gold > 0) {
      // Split evenly, remainder to the guardian. Individual purses are the
      // whole reason `give_gold` has anything to do.
      const each = Math.floor(gold / CLASSES.length);
      for (const id of CLASSES) s.party[id].gold += each;
      s.party.guardian.gold += gold - each * CLASSES.length;
      this.goldEarned += gold;
    }
    const drops = rollLoot(s.floor, s.floor % 5 === 0, this.encounterSerious, this.lootRng);
    for (const item of drops) {
      const to = CLASSES[this.lootRng.int(0, CLASSES.length - 1)];
      const holder = s.party[to];
      if (holder.inventory.length >= 6) {
        this.lastLog.push(`${itemName(item)} was left behind — ${to}'s pack is full.`);
        continue;
      }
      holder.inventory.push(item);
      s.pending.push({ item, to });
    }
    if (drops.length > 0) this.note("loot", `Spoils on floor ${s.floor}: ${drops.map(itemName).join(", ")}.`);

    // A cache is the common find; a merchant is the rarer, stranger one.
    //
    // It used to be a merchant every third floor, which never made sense — a
    // trader who sets up on floor 32 of a lethal endless dungeon, restocks on a
    // schedule, and takes coin. Worse, buying is settled privately from one
    // purse: measured on run 3 the party spent 5,309 gold, every coin of it by
    // one agent on themselves, and finished sitting on 11,944 unspent with the
    // pooling diagnostic reading zero. A dead expedition's packs explain
    // themselves, explain why the gear suits the depth, and cannot be resolved
    // by whoever is richest.
    s.stock = [];
    s.cache = [];
    s.cacheTakesLeft = 0;
    s.cacheOrigin = undefined;
    if (s.floor % 6 === 0) {
      s.stock = rollStock(s.floor, this.stockRng);
      this.note("merchant", `A merchant has set up on floor ${s.floor}.`);
    } else if (this.pendingCache || s.floor % 3 === 0) {
      const rolled = rollCache(s.floor, CACHE_OFFERS, this.stockRng);
      this.cacheSerial += 1;
      s.cache = rolled.items.map((item) => ({ item }));
      s.cacheTakesLeft = CACHE_TAKES;
      s.cacheOrigin = rolled.origin;
      this.note("cache", `What is left of ${rolled.origin} is on floor ${s.floor}.`);
      this.pendingCache = false;
    }
  }

  /** Set when the party walked toward a cache; consumed when the room is cleared. */
  private pendingCache = false;

  /** What the rogue saw ahead, and on which floor. Nobody else can read it. */
  private scoutReport: string | undefined;
  private scoutedFloor = -1;

  private slainGold = 0;

  private descend(): void {
    const s = this.state;
    s.floor += 1;
    this.floorReached = Math.max(this.floorReached, s.floor);
    s.dread = 0;
    s.phase = "explore";
    s.paths = generatePaths(s.floor, this.pathRng);
    s.stock = [];
    s.cache = [];
    s.cacheTakesLeft = 0;
    s.cacheOrigin = undefined;
    s.pending = [];
    this.scoutReport = undefined;
    this.descendRequested = false;
    this.pendingPath = undefined;
    this.pendingCache = false;
    this.retreatRequested = false;
    this.fledEnemies = undefined;
    this.note("descend", `The party goes down to floor ${s.floor}.`);
    this.lastLog = [`Down to floor ${s.floor}.`];
  }

  /** One tick. The harness calls this once per round of the roster. */
  advance(): SimEvent[] {
    const before = this.events.length;
    const s = this.state;
    if (this.done) return [];

    for (const id of CLASSES) {
      const f = s.party[id];
      for (const k of Object.keys(f.cooldowns)) f.cooldowns[k] = Math.max(0, f.cooldowns[k] - 1);
      // Mana comes back, slowly in a fight and quickly out of one.
      //
      // Without this the mage and the cleric are spent by floor three and spend
      // the rest of the run as bad physical attackers — which is not a resource
      // decision, it is a resource cliff, and the party has no way to see it
      // coming or anything to do about it when it arrives.
      if (!f.dead && f.maxMana > 0) {
        const rate = s.phase === "combat" ? 0.09 : 0.3;
        f.mana = Math.min(f.maxMana, f.mana + Math.ceil(f.maxMana * rate));
      }
    }

    switch (s.phase) {
      case "camp": {
        this.lastBeats = [];
        if (this.enterRequested) {
          this.enterRequested = false;
          s.phase = "explore";
          s.stock = [];
          this.lastLog = ["The outfitter closes the wagon. The party takes the first stair together."];
          this.note("enter", "The party enters the dungeon.");
        } else {
          this.lastLog = ["The party is still choosing how to spend its opening budget."];
        }
        break;
      }
      case "explore": {
        this.lastBeats = [];
        if (this.pendingPath) {
          this.takePath();
          break;
        }
        // A round in which nobody chose is a round the dungeon notices.
        s.dread += 1;
        this.lastLog = ["Nobody chose a way on. Something moves in the dark."];
        if (s.dread >= 3) {
          this.lastLog = ["Waiting too long in the open. Something finds you."];
          this.beginEncounter(false);
        }
        break;
      }
      case "combat": {
        const fleeing = this.retreatRequested;
        this.retreatRequested = false;
        // Counted before resolution: `resolveTick` empties the queue, so asking
        // afterwards whether two agents acted in the same round always answered
        // no, and the coordination diagnostic read 0% for every run ever made.
        const actorsThisRound = s.intents.length;
        this.diag.turnsIdle += Math.max(0, livingParty(s).length - new Set(s.intents.map((i) => i.actor)).size);
        // Retreat replaces the party's readied actions. The enemies still take
        // their turns, making escape a damage-and-dread trade rather than a
        // free undo button after seeing a bad encounter.
        if (fleeing) s.intents = [];
        const result = resolveTick(s, this.rng.fork(`tick-${s.tick}`), this.performAbility, this.enemyAct);
        this.lastLog = result.lines;
        this.lastBeats = result.beats;
        this.lastBeatsTick = s.tick;
        s.log.push(...result.lines.map((text) => ({ tick: s.tick, text })));
        this.diag.recordConflicts(result.conflicts.length, result.conflicts, actorsThisRound >= 2);
        this.diag.actionsWasted += result.wasted.length;

        for (const e of result.slain) {
          this.totalXp += e.xp;
          this.slainGold += e.gold;
          this.enemiesDefeated += 1;
          if (e.boss) this.bossesDefeated += 1;
          if (e.elite) this.elitesDefeated += 1;
        }
        for (const id of new Set(result.downed)) {
          this.deaths += 1;
          this.note("down", `${id} went down on floor ${s.floor}.`);
        }
        if (result.mechanicsFired.length > 0) {
          for (const m of result.mechanicsFired) {
            this.diag.recordMechanic(m.family, m.kind);
            this.note("mechanic", `Something about the ${m.family} answered back.`);
          }
        }

        const levelled = levelFor(this.totalXp);
        if (levelled > this.level) {
          this.level = levelled;
          for (const id of CLASSES) this.effective(s.party[id]);
          this.note("level", `The party reaches level ${this.level}.`);
          this.lastLog.push(`The party reaches level ${this.level}.`);
        }

        if (livingParty(s).length === 0) {
          s.wiped = true;
          this.note("wipe", `The party died on floor ${s.floor}.`);
          s.phase = "over";
          break;
        }
        if (livingEnemies(s).length === 0) {
          this.lastLog.push("The last of them goes down.");
          this.endEncounter();
        } else if (fleeing) {
          this.fledEnemies = s.enemies;
          s.enemies = [];
          s.phase = "explore";
          s.dread += 2;
          this.pendingPath = undefined;
          s.paths = [
            {
              id: "back",
              label: "return to the unfinished fight",
              hint: "the wounded enemies are still there",
              kind: "retreat",
            },
            ...s.paths,
          ];
          this.lastLog.push(`The party escapes, but gives the enemy an opening. Dread rises to ${s.dread}.`);
          this.note("retreat", `The party fled an encounter on floor ${s.floor}.`);
        }
        // Dread deliberately does *not* rise during a fight.
        //
        // It is the price of lingering — deliberating on the stairs, picking
        // over spoils, haggling — and being in a fight is not lingering. While
        // combat charged it, a long encounter raised dread, dread bought the
        // *next* encounter extra bodies (`reinforcements` in `content.ts`), and
        // the bigger encounter took longer still. Nothing anywhere in that loop
        // pushed back. Measured on run 3: a thirteen-round fight ended with
        // dread at 13 and handed the party a six-enemy follow-up.
        break;
      }
      case "spoils":
      case "market":
      case "cache": {
        this.lastBeats = [];
        s.dread += 1;
        // Arriving somewhere re-opens the question of whether to leave.
        //
        // These two transitions are checked *before* the descend request, and
        // they clear it. A party that called `descend` while picking over
        // spoils had not yet seen the merchant or the packs — resolving the
        // stale request first walked it straight past both, and the cache was
        // unreachable for every policy in the sweep. Whoever still wants to go
        // down can say so again now that they know what is here.
        if (s.phase === "spoils" && s.stock.length > 0) {
          s.phase = "market";
          this.descendRequested = false;
          this.lastLog = ["A merchant is waiting further along."];
          break;
        }
        if (s.phase === "spoils" && s.cacheTakesLeft > 0) {
          s.phase = "cache";
          this.descendRequested = false;
          this.lastLog = [`${cap(s.cacheOrigin ?? "somebody")} got this far, and no further.`];
          break;
        }
        // Dread is a consequence, not a number the party can erase by resting
        // and asking for the stairs in the same round.
        if (s.dread >= 6) {
          this.descendRequested = false;
          this.lastLog = ["Lingering has been noticed."];
          this.beginEncounter(false);
          break;
        }
        if (this.descendRequested) {
          this.descend();
          break;
        }
        this.lastLog = ["The party lingers."];
        break;
      }
      case "over":
        break;
    }

    // One call to `advance` is one round, whatever phase the party is in.
    //
    // This used to live inside `resolveTick`, so the clock only moved during a
    // fight — a party deliberating on the stairs advanced no time at all, the
    // horizon counted *combat* rounds rather than rounds, and `done` could not
    // fire for a party that never fought. It also quietly invalidated the
    // baseline ladder: a sweep run to `days: 40` was giving the bots forty
    // fights where an agent run gets forty turns of everything.
    this.state.tick += 1;

    // Anything in the wrong pack, counted once per tick it stays there.
    let misheld = 0;
    for (const id of CLASSES) {
      const f = s.party[id];
      for (const item of f.inventory) {
        const owners = equippableBy(item);
        if (owners.length > 0 && !owners.includes(id) && owners.some((o) => !s.party[o].dead)) misheld += 1;
      }
    }
    this.diag.recordMisheld(misheld);

    return this.events.slice(before);
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private who(agent: string | undefined): Fighter {
    const f = agent ? this.state.party[agent as ClassId] : undefined;
    if (!f) throw new Error(`${agent ?? "you"} is not one of the five. This tool belongs to the party.`);
    if (f.dead) throw new Error(`${f.id} is down. Somebody has to revive you before you can act.`);
    return f;
  }

  private requirePhase(...phases: string[]): void {
    if (!phases.includes(this.state.phase)) {
      throw new Error(
        `not now — the party is in the ${this.state.phase} phase, and that only works in: ${phases.join(", ")}.`,
      );
    }
  }

  /** Ready a combat action, replacing anything this agent had already readied. */
  private ready(actor: Fighter, intent: Intent): string {
    const existing = this.state.intents.findIndex((i) => i.actor === actor.id);
    let replaced = "";
    if (existing >= 0) {
      replaced = ` (this replaces your ${this.state.intents[existing].kind})`;
      this.state.intents.splice(existing, 1);
    }
    this.state.intents.push(intent);
    const others = this.state.intents.filter((i) => i.actor !== actor.id);
    const alsoReady =
      others.length > 0 ? ` Also readied: ${others.map((i) => `${i.actor} ${i.kind}`).join(", ")}.` : "";
    return `Readied${replaced}. It resolves when the round closes, at the same time as everyone else's.${alsoReady}`;
  }

  // -------------------------------------------------------------------------
  // The action API, shared by the tools and by the baseline policies
  // -------------------------------------------------------------------------
  //
  // Every rule about what is legal lives here rather than in the tool wrappers,
  // because the baselines have to play *exactly* the game the agents play. A
  // bot that reaches into the state directly is a bot that ignores mana costs
  // and cooldowns, and a ladder built from one is a ladder measuring a
  // different dungeon. The tools below are a thin agent-facing skin over these.

  /** Validate, pay for, and ready a class ability. */
  useAbility(agent: string | undefined, name: string, targetRaw?: unknown): string {
    const def = ABILITIES[name];
    if (!def) throw new Error(`no such ability: ${name}.`);
    const me = this.who(agent);
    if (me.id !== def.owner) throw new Error(`${name} belongs to the ${def.owner}, not the ${me.id}.`);
    this.requirePhase("combat");
    if (def.mana && me.mana < def.mana) throw new Error(`${name} costs ${def.mana} mana and you have ${me.mana}.`);
    if ((me.cooldowns[name] ?? 0) > 0)
      throw new Error(`${name} is cooling down for another ${me.cooldowns[name]} round(s).`);

    let target: string | undefined;
    if (def.target === "enemy") {
      const e = this.findEnemy(String(targetRaw ?? ""));
      if (!e) {
        throw new Error(
          `no enemy called "${targetRaw}" is standing. Try: ${livingEnemies(this.state)
            .map((x) => x.ref)
            .join(", ")}.`,
        );
      }
      target = e.ref;
    }
    if (def.target === "ally") {
      const ally = this.state.party[String(targetRaw ?? "") as ClassId];
      if (!ally) throw new Error(`no party member called "${targetRaw}".`);
      target = ally.id;
    }

    if (def.mana) me.mana -= def.mana;
    // One more than the stated cooldown, because upkeep decrements it on the
    // same tick the ability resolves.
    if (def.cooldown) me.cooldowns[name] = def.cooldown + 1;
    return this.ready(me, { actor: me.id, kind: name, target });
  }

  /** Ready a plain attack. Available to everyone, costs nothing. */
  useBasic(agent: string | undefined, targetRaw: unknown): string {
    const me = this.who(agent);
    this.requirePhase("combat");
    const e = this.findEnemy(String(targetRaw ?? ""));
    if (!e) throw new Error(`no enemy called "${targetRaw}" is standing.`);
    return this.ready(me, { actor: me.id, kind: "attack", target: e.ref });
  }

  useDefend(agent: string | undefined): string {
    const me = this.who(agent);
    this.requirePhase("combat");
    return this.ready(me, { actor: me.id, kind: "defend" });
  }

  useItem(agent: string | undefined, item: string, targetRaw?: unknown): string {
    const me = this.who(agent);
    if (!me.inventory.includes(item)) {
      throw new Error(`there is no ${item} in your pack. You have: ${me.inventory.join(", ") || "nothing"}.`);
    }
    const target = String(targetRaw ?? me.id);
    if (this.state.phase === "combat") return this.ready(me, { actor: me.id, kind: "use_item", what: item, target });
    const out: TickResult = {
      lines: [],
      beats: [],
      slain: [],
      downed: [],
      conflicts: [],
      mechanicsFired: [],
      wasted: [],
    };
    this.consume(me, item, target, out);
    return out.lines.join("\n") || `Used ${item}.`;
  }

  equipItem(agent: string | undefined, item: string): string {
    const me = this.who(agent);
    if (this.state.phase === "combat") throw new Error("not in the middle of a fight.");
    const def = ITEM_BY_ID.get(item);
    if (!def) throw new Error(`no such item: ${item}.`);
    if (!me.inventory.includes(item)) throw new Error(`there is no ${item} in your pack.`);
    if (def.kind === "consumable") throw new Error(`${def.name} is used, not worn. Try use_item.`);
    if (!canEquip(def, me.id)) {
      throw new Error(
        `a ${me.id} cannot use ${def.name} — it is for ${(def.classes ?? []).join(" or ")}. ` +
          `It is no use to you sitting in your pack.`,
      );
    }
    const slot = def.kind;
    const previous = me.equipped[slot];

    // Trinkets are attuned, and the dungeon only tolerates so much at once.
    //
    // This is the cheapest way to make an item a *party* decision instead of a
    // private one. Weapons and armour are class-locked, so who wears them is
    // usually obvious; trinkets fit anybody, which made them a pure individual
    // upgrade — find one, wear it, nobody else is involved. With a party-wide
    // cap a third trinket is not a gain, it is a proposal that somebody else
    // give theirs up, and that proposal has to be spoken aloud.
    if (slot === "trinket" && !previous) {
      const worn = CLASSES.filter((id) => this.state.party[id].equipped.trinket);
      if (worn.length >= ATTUNEMENT_SLOTS) {
        throw new Error(
          `the party can only keep ${ATTUNEMENT_SLOTS} trinkets attuned at once, and all ${ATTUNEMENT_SLOTS} are ` +
            `spoken for: ${worn.map((id) => `${id} (${itemName(this.state.party[id].equipped.trinket as string)})`).join(", ")}. ` +
            "Somebody has to take one off before you can put this on.",
        );
      }
    }

    me.equipped[slot] = item;
    me.inventory.splice(me.inventory.indexOf(item), 1);
    if (previous) me.inventory.push(previous);
    this.effective(me);
    return `You put on ${def.name}.${previous ? ` ${itemName(previous)} goes back into your pack.` : ""} You are now ${me.hp}/${me.maxHp} hp, armour ${me.armor}, power ${me.power}, speed ${me.speed}.`;
  }

  /**
   * Take something off.
   *
   * Added with the attunement cap, and required by it: without a way to give a
   * trinket up, "all the slots are spoken for" is a soft-lock rather than a
   * negotiation, and the party would simply be stuck with whatever the first
   * two drops happened to be.
   */
  unequipItem(agent: string | undefined, slotRaw: string): string {
    const me = this.who(agent);
    if (this.state.phase === "combat") throw new Error("not in the middle of a fight.");
    const slot = slotRaw as "weapon" | "armor" | "trinket";
    if (slot !== "weapon" && slot !== "armor" && slot !== "trinket") {
      throw new Error(`no such slot: ${slotRaw}. There is weapon, armor and trinket.`);
    }
    const worn = me.equipped[slot];
    if (!worn) throw new Error(`you have nothing in your ${slot} slot.`);
    if (me.inventory.length >= 6) throw new Error("your pack is full — hand something to somebody first.");
    me.equipped[slot] = undefined;
    me.inventory.push(worn);
    this.effective(me);
    return `You take off ${itemName(worn)} and stow it. You are now ${me.hp}/${me.maxHp} hp, armour ${me.armor}, power ${me.power}, speed ${me.speed}.`;
  }

  tradeItem(agent: string | undefined, toRaw: string, item: string): string {
    const me = this.who(agent);
    if (this.state.phase === "combat") throw new Error("not in the middle of a fight.");
    const them = this.state.party[toRaw as ClassId];
    if (!them) throw new Error(`no party member called "${toRaw}".`);
    if (them.id === me.id) throw new Error("handing an item to yourself is not a trade.");
    if (them.dead) throw new Error(`${toRaw} is down.`);
    if (!me.inventory.includes(item)) throw new Error(`there is no ${item} in your pack.`);
    if (them.inventory.length >= 6) throw new Error(`${toRaw}'s pack is full.`);
    me.inventory.splice(me.inventory.indexOf(item), 1);
    them.inventory.push(item);
    this.diag.recordTrade();
    return `You hand ${itemName(item)} to ${toRaw}.`;
  }

  giveGold(agent: string | undefined, toRaw: string, amount: number): string {
    const me = this.who(agent);
    const them = this.state.party[toRaw as ClassId];
    if (!them) throw new Error(`no party member called "${toRaw}".`);
    if (them.id === me.id) throw new Error("giving gold to yourself does not move a purse.");
    const give = Math.max(0, Math.floor(amount));
    if (give <= 0) throw new Error("give a positive amount.");
    if (me.gold < give) throw new Error(`you have ${me.gold} gold, not ${give}.`);
    me.gold -= give;
    them.gold += give;
    // Remember what they had before the top-up. A purchase only counts as
    // pooled if it was one they could not have made on their own, and the only
    // moment that is knowable is now.
    this.toppedUp.set(them.id, this.toppedUp.get(them.id) ?? them.gold - give);
    this.diag.recordGoldTransfer();
    return `You give ${toRaw} ${give} gold. You have ${me.gold} left.`;
  }

  buyItem(agent: string | undefined, item: string): string {
    const me = this.who(agent);
    this.requirePhase("market", "camp");
    const listing = this.state.stock.find((x) => x.item === item);
    if (!listing) {
      throw new Error(`the merchant has no ${item}. On offer: ${this.state.stock.map((x) => x.item).join(", ")}.`);
    }
    if (me.gold < listing.price) {
      throw new Error(`${listing.price} gold, and you have ${me.gold}. Somebody could give you the difference.`);
    }
    if (me.inventory.length >= 6) throw new Error("your pack is full.");
    me.gold -= listing.price;
    this.goldSpent += listing.price;
    me.inventory.push(item);
    this.state.stock = this.state.stock.filter((x) => x.item !== item);
    // Pooled means *this buyer could not have afforded it alone*, not merely
    // that it was expensive.
    //
    // The first version compared the price against a notional opening purse of
    // sixty gold, which was true on floor one and nonsense anywhere else: a
    // party started mid-descent opens with thousands each, so every purchase
    // scored as pooled and the scenario handed out ten milestone points for
    // shopping normally. A diagnostic that fires on the wrong thing is worse
    // than one that does not fire.
    const before = this.toppedUp.get(me.id);
    if (before !== undefined) {
      if (before < listing.price) this.diag.recordPooledPurchase();
      this.toppedUp.delete(me.id);
    }
    return `You buy ${itemName(item)} for ${listing.price}. You have ${me.gold} gold left.`;
  }

  /**
   * Take one of the dead expedition's things.
   *
   * The party may take `CACHE_TAKES` of `CACHE_OFFERS`, and that is the whole
   * mechanic: there is no purse to settle it with and no price to sort by, so
   * the only way to resolve it is to agree. Everything the benchmark wants to
   * see — reading who can use what, arguing the case, conceding — is forced by
   * a cap that four of the six things will not fit under.
   */
  takeFromCache(agent: string | undefined, item: string): string {
    const me = this.who(agent);
    this.requirePhase("cache");
    const s = this.state;
    const entry = s.cache.find((x) => x.item === item && !x.taken);
    if (!entry) {
      const left = s.cache.filter((x) => !x.taken).map((x) => x.item);
      throw new Error(
        left.length > 0
          ? `there is no ${item} here. Still in the packs: ${left.join(", ")}.`
          : "the packs are empty — everything has been taken.",
      );
    }
    if (s.cacheTakesLeft <= 0) {
      throw new Error("you are carrying all you can from here. Call `descend` when the party is ready.");
    }
    if (me.inventory.length >= 6) throw new Error("your pack is full.");
    entry.taken = me.id;
    s.cacheTakesLeft -= 1;
    me.inventory.push(item);
    this.diag.recordCacheTake(me.id, `${s.floor}:${this.cacheSerial}`);
    const def = ITEM_BY_ID.get(item);
    const useless =
      def && def.kind !== "consumable" && !canEquip(def, me.id)
        ? ` You cannot use it — it is for ${(def.classes ?? []).join(" or ")}.`
        : "";
    return (
      `You take ${itemName(item)}.${useless} ` +
      (s.cacheTakesLeft > 0
        ? `The party can carry ${s.cacheTakesLeft} more thing${s.cacheTakesLeft === 1 ? "" : "s"} out of here.`
        : "That is all the party can carry. Call `descend` when everyone is ready.")
    );
  }

  sellItem(agent: string | undefined, item: string): string {
    const me = this.who(agent);
    this.requirePhase("market", "camp");
    if (!me.inventory.includes(item)) throw new Error(`there is no ${item} in your pack.`);
    const price = Math.round((ITEM_BY_ID.get(item)?.price ?? 30) * 0.35);
    me.inventory.splice(me.inventory.indexOf(item), 1);
    me.gold += price;
    this.goldEarned += price;
    return `You sell ${itemName(item)} for ${price}. You have ${me.gold} gold.`;
  }

  /**
   * Commit the party to a way on. The move itself happens when the round closes.
   *
   * Deferred rather than immediate, and the difference is not cosmetic: if the
   * choice dropped the party straight into combat, everyone whose turn had
   * already passed would sit out the opening round while the enemies acted, and
   * the party would take a free round of damage on every floor for no reason
   * except roster position. Choosing is an action; walking into the room
   * happens to everybody at once.
   */
  choosePath(agent: string | undefined, id: string): string {
    this.who(agent);
    this.requirePhase("explore");
    const path = this.state.paths.find((p) => p.id === id.toLowerCase().trim());
    if (!path) {
      throw new Error(`no way called "${id}". On offer: ${this.state.paths.map((p) => p.id).join(", ")}.`);
    }
    const already = this.pendingPath;
    this.pendingPath = path.id;
    const changed =
      already && already !== path.id
        ? ` This replaces the ${already} way, which ${agent ?? "somebody"} had already chosen.`
        : "";
    return `The party will take the ${path.id} way — ${path.label} — when the round closes.${changed}`;
  }

  /** Walk the party into whatever they chose. Called from `advance`. */
  private takePath(): void {
    const s = this.state;
    const path = s.paths.find((p) => p.id === this.pendingPath);
    this.pendingPath = undefined;
    if (!path) return;

    if (path.kind === "retreat" && this.fledEnemies) {
      s.enemies = this.fledEnemies;
      this.fledEnemies = undefined;
      s.phase = "combat";
      s.paths = [];
      this.lastLog = ["The party turns back. The unfinished fight is exactly where they left it."];
      return;
    }

    // Taking any other route leaves the escaped encounter behind. The enemy
    // got its opportunity attack and dread remains, so changing plans is
    // possible without being consequence-free.
    this.fledEnemies = undefined;

    if (path.kind === "market") {
      s.stock = rollStock(s.floor, this.stockRng);
      s.phase = "market";
      this.lastLog = [`The party takes the ${path.id} way and finds a merchant.`];
      return;
    }
    if (path.kind === "cache") {
      // Whatever killed them is still in the room.
      //
      // The packs are the reward for clearing it, not a way around it. Handing
      // them over on arrival made the cache path strictly better than fighting
      // — a party took it every floor, descended to 43 without levelling, and
      // walked straight past two bosses. It is also the more coherent reading:
      // "they got this far and no further" implies something that stopped them.
      this.pendingCache = true;
      this.beginEncounter(false);
      this.lastLog.unshift("Packs at the bottom of the stair, and their owners still here. Something else is too.");
      return;
    }
    if (path.kind === "shrine") {
      for (const f of livingParty(s)) {
        f.hp = Math.min(f.maxHp, f.hp + Math.round(f.maxHp * 0.25));
        f.mana = f.maxMana;
      }
      this.beginEncounter(false);
      this.lastLog.unshift(
        "A shrine: a quarter of everyone's health back, and all of their mana. Then something finds you.",
      );
      return;
    }
    this.beginEncounter(path.kind === "elite");
  }

  requestDescend(agent: string | undefined): string {
    this.who(agent);
    this.requirePhase("spoils", "market", "cache");
    this.descendRequested = true;
    return "You start down. The party moves when the round closes — anyone who still has business here has until then.";
  }

  enterDungeon(agent: string | undefined): string {
    this.who(agent);
    this.requirePhase("camp");
    this.enterRequested = true;
    return "The party will enter the dungeon together when the round closes. Finish any purchases now.";
  }

  requestRetreat(agent: string | undefined): string {
    this.who(agent);
    this.requirePhase("combat");
    this.retreatRequested = true;
    return (
      "The party will try to retreat when the round closes. Readied actions will be abandoned, " +
      "and every standing enemy gets one opportunity to attack before the party escapes."
    );
  }

  reviveAlly(agent: string | undefined, allyRaw: string): string {
    const me = this.who(agent);
    this.requirePhase("spoils", "market", "cache", "explore");
    const ally = this.state.party[allyRaw as ClassId];
    if (!ally) throw new Error(`no party member called "${allyRaw}".`);
    if (!ally.dead) throw new Error(`${ally.id} is still standing.`);
    if (!me.inventory.includes("soul_stone")) {
      throw new Error("a soul stone is the only thing that brings anyone back, and you have none.");
    }
    me.inventory.splice(me.inventory.indexOf("soul_stone"), 1);
    ally.dead = false;
    ally.hp = Math.round(ally.maxHp * 0.4);
    ally.statuses = [];
    this.revives += 1;
    return `You burn a soul stone. ${ally.id} comes back at ${ally.hp} health.`;
  }

  restParty(agent: string | undefined): string {
    this.who(agent);
    this.requirePhase("spoils", "market", "cache");
    if (this.lastRestTick === this.state.tick) {
      throw new Error("the party has already rested this round. More recovery takes another round.");
    }
    this.lastRestTick = this.state.tick;
    for (const f of livingParty(this.state)) {
      f.hp = Math.min(f.maxHp, f.hp + Math.round(f.maxHp * 0.18));
      f.mana = Math.min(f.maxMana, f.mana + Math.round(f.maxMana * 0.35));
    }
    this.state.dread += 2;
    return `The party rests. Everyone recovers a little. Dread is now ${this.state.dread} — resting is not free.`;
  }

  /** Read-only view for a baseline, which does not get prose. */
  view(): DescentState {
    return this.state;
  }

  inspect(who: ClassId, ref: string): string {
    const e = this.findEnemy(ref);
    if (!e) throw new Error(`no enemy called "${ref}" is standing.`);
    this.diag.recordInspect(e.ref, who);
    return this.inspectFor(who, e);
  }

  sharedTools(): Tool[] {
    // Every shared tool is counted, refusal or not. Tool correctness is the
    // cheapest diagnostic in the file and the only one that would be wrong by
    // omission rather than by measurement, so it is wired at the wrapper rather
    // than at each of the fourteen call sites.
    const T = (
      n: string,
      d: string,
      p: Record<string, string>,
      f: (a: Record<string, unknown>, who: string | undefined) => string,
      e: "read" | "write" = "write",
    ) =>
      agentTool(
        n,
        d,
        p,
        (args, agent) => {
          try {
            const out = f(args, agent);
            this.diag.recordAttempt(false);
            return out;
          } catch (err) {
            this.diag.recordAttempt(true);
            throw err;
          }
        },
        e,
      );

    return [
      T(
        "look",
        "The floor, your own sheet, your allies' condition, and whatever is in front of you.",
        {},
        (_a, agent) => this.describe(agent as ClassId | undefined),
        "read",
      ),

      T(
        "inspect_enemy",
        "Study one enemy. What you learn depends on which of the five you are; nobody sees all of it.",
        { target: "The enemy's ref, e.g. beast-1." },
        (args, agent) => {
          const me = this.who(agent);
          this.requirePhase("combat");
          return this.inspect(me.id, String(args.target ?? ""));
        },
        "read",
      ),

      T(
        "attack",
        "Ready a plain attack on one enemy. It resolves when the round closes.",
        { target: "The enemy's ref." },
        (args, agent) => this.useBasic(agent, args.target),
      ),

      T("defend", "Ready a guard. Less damage this round, and no attack.", {}, (_a, agent) => this.useDefend(agent)),

      T(
        "use_item",
        "Use something from your own pack. In a fight it is readied with everything else; otherwise it happens now.",
        { item: "The item id, e.g. healing_potion.", target: "Who it is for. Your own id for yourself." },
        (args, agent) => this.useItem(agent, String(args.item ?? ""), args.target),
      ),

      T("equip_item", "Put on something from your pack. Not during a fight.", { item: "The item id." }, (args, agent) =>
        this.equipItem(agent, String(args.item ?? "")),
      ),

      T(
        "trade_item",
        "Hand something from your pack to somebody else. Not during a fight.",
        { to: "Their id: guardian, mage, rogue, cleric or ranger.", item: "The item id." },
        (args, agent) => this.tradeItem(agent, String(args.to ?? ""), String(args.item ?? "")),
      ),

      T(
        "give_gold",
        "Move gold from your purse to somebody else's. Purses are separate; nobody can see yours.",
        { to: "Their id.", amount: "How much." },
        (args, agent) => this.giveGold(agent, String(args.to ?? ""), num(args.amount, 0)),
      ),

      T(
        "buy",
        "Buy from the merchant, out of your own purse.",
        { item: "The item id from the merchant's list." },
        (args, agent) => this.buyItem(agent, String(args.item ?? "")),
      ),

      T(
        "sell",
        "Sell something to the merchant for about a third of its value.",
        { item: "The item id from your pack." },
        (args, agent) => this.sellItem(agent, String(args.item ?? "")),
      ),

      T(
        "take",
        "Take something from a dead expedition's packs. The party can only carry a couple out.",
        { item: "The item id from what is lying here." },
        (args, agent) => this.takeFromCache(agent, String(args.item ?? "")),
      ),

      T(
        "unequip",
        "Take off what you are wearing in a slot and stow it.",
        { slot: "weapon, armor or trinket." },
        (args, agent) => this.unequipItem(agent, String(args.slot ?? "")),
      ),

      T(
        "choose_path",
        "Pick one of the ways currently visible. The last choice readied before the round closes is the one taken.",
        { path: "One of the path ids shown by `look`." },
        (args, agent) => this.choosePath(agent, String(args.path ?? "")),
      ),

      T(
        "enter_dungeon",
        "Leave the surface outfitter and take the first stair. The party enters together when the round closes.",
        {},
        (_a, agent) => this.enterDungeon(agent),
      ),

      T("descend", "Go down to the next floor. Anything left on this one is left behind.", {}, (_a, agent) =>
        this.requestDescend(agent),
      ),

      T(
        "retreat",
        "Try to escape the current fight. Readied actions are abandoned and enemies get one opportunity attack.",
        {},
        (_a, agent) => this.requestRetreat(agent),
      ),

      T(
        "revive",
        "Bring back a fallen ally. Needs a soul stone, and only works between fights.",
        { ally: "Their id." },
        (args, agent) => this.reviveAlly(agent, String(args.ally ?? "")),
      ),

      T(
        "rest",
        "Bind wounds. Restores some health and mana, and the dungeon notices you standing still.",
        {},
        (_a, agent) => this.restParty(agent),
      ),
    ];
  }

  /**
   * What each class's inspection tells them.
   *
   * Five slices, none of them sufficient. The one thing no slice ever contains
   * is the family's hidden rule: the rogue is told that there is something to
   * find, and never what it is.
   */
  private inspectFor(who: ClassId, e: Enemy): string {
    const head = `${e.ref} — ${e.name}. ${e.hp} of ${e.maxHp} health.`;
    const trick = e.hidden.kind !== "none";
    switch (who) {
      case "guardian":
        return `${head}\nArmour ${e.armor}. It hits for about ${e.power} a swing.\nPhysical attacks lose ${e.armor} to that plating.`;
      case "mage": {
        const lines = Object.entries(e.resist).map(
          ([el, v]) => `  ${el}: ${v === 0 ? "immune" : v < 1 ? `resists (×${v})` : `vulnerable (×${v})`}`,
        );
        return `${head}\nElemental readings:\n${lines.length > 0 ? lines.join("\n") : "  nothing unusual — everything lands normally"}`;
      }
      case "rogue":
        return `${head}\nSpeed ${e.speed} — ${e.speed > 12 ? "it acts before most of you" : "you act before it"}.\n${
          trick ? "Something about it is off. You cannot tell what." : "Nothing hidden about this one."
        }`;
      case "cleric":
        return `${head}\nAura: ${
          e.hidden.kind === "punishHeal" || e.hidden.kind === "tollHeal"
            ? "it is paying attention to you rather than to the fighters"
            : "nothing pressing on the party's health"
        }.\nStatus: ${e.statuses.map((s) => s.kind).join(", ") || "clean"}.`;
      case "ranger": {
        const def = e.boss ? undefined : e.family;
        const behaviour = def ? (FAMILY_BEHAVIOUR.get(def) ?? "no notes") : "a boss; it will have a pattern";
        return `${head}\nBehaviour: ${behaviour}.\nExperience worth ${e.xp}. ${e.elite ? "This one is an elite." : ""}`;
      }
    }
  }

  tools(): Record<string, Tool[]> {
    const byClass: Record<string, Tool[]> = { guardian: [], mage: [], rogue: [], cleric: [], ranger: [] };

    for (const [name, def] of Object.entries(ABILITIES)) {
      const params: Record<string, string> = {};
      if (def.target === "enemy") params.target = "The enemy's ref.";
      if (def.target === "ally") params.target = "The ally's id: guardian, mage, rogue, cleric or ranger.";
      const cost = [def.mana ? `${def.mana} mana` : "", def.cooldown ? `${def.cooldown}-round cooldown` : ""]
        .filter(Boolean)
        .join(", ");
      byClass[def.owner].push(
        agentTool(name, `${def.description}${cost ? ` (${cost})` : ""}`, params, (args, agent) => {
          try {
            const out = this.useAbility(agent, name, args.target);
            this.diag.recordAttempt(false);
            return out;
          } catch (err) {
            this.diag.recordAttempt(true);
            throw err;
          }
        }),
      );
    }

    // Two reads that are not abilities: the rogue's look ahead and the ranger's
    // deeper read of a family. Neither queues, because information the party
    // only receives after the round has resolved is information that arrived
    // too late to be worth anything.
    byClass.rogue.push(
      agentTool(
        "scout",
        "Go ahead alone and look down the ways on. Only you see what is there — the others have to be told.",
        {},
        (_args, agent) => {
          try {
            const me = this.who(agent);
            if (me.id !== "rogue") throw new Error("scouting belongs to the rogue.");
            this.requirePhase("explore");
            const s = this.state;
            const readings = s.paths.map((p) => {
              if (p.kind === "elite") return `  ${p.id}: something large, and it is guarding something worth having`;
              if (p.kind === "market") return `  ${p.id}: a merchant`;
              if (p.kind === "cache") return `  ${p.id}: packs, and their owners, and whatever killed them`;
              if (p.kind === "shrine") return `  ${p.id}: a shrine, and a fight after it`;
              return `  ${p.id}: an ordinary room, ${generateEncounter(s.floor, s.dread, false, makeRng(s.floor * 31 + 7)).length} of them waiting`;
            });
            // Private to the rogue, and that is the whole point.
            //
            // This used to write into `state.scouted`, which `describe` renders
            // for everybody — so the party learned what was ahead whether or
            // not anybody said a word, and the one action in the scenario that
            // could create information asymmetry created none. Now the rogue
            // holds it and has to relay it, which is most of what splitting the
            // party would have bought, for one field.
            this.scoutReport = readings.join("\n");
            this.scoutedFloor = s.floor;
            // Going ahead and coming back costs time, and the dungeon notices.
            // Without a price, scouting every floor is free and there is no
            // decision about whether the look was worth it.
            s.dread += 1;
            this.diag.recordAttempt(false);
            return `You go ahead quietly. Nobody else can see any of this:\n${readings.join("\n")}\n\nThey are waiting on you.`;
          } catch (err) {
            this.diag.recordAttempt(true);
            throw err;
          }
        },
        "read",
      ),
    );

    byClass.ranger.push(
      agentTool(
        "read_beast",
        "Everything your training says about a creature's habits. It will not tell you what it does that nobody has seen yet.",
        { target: "The enemy's ref." },
        (args, agent) => {
          try {
            const me = this.who(agent);
            if (me.id !== "ranger") throw new Error("that is the ranger's training.");
            this.requirePhase("combat");
            const e = this.findEnemy(String(args.target ?? ""));
            if (!e) throw new Error(`no enemy called "${args.target}" is standing.`);
            this.diag.recordInspect(e.ref, "ranger");
            this.diag.recordAttempt(false);
            const threshold =
              e.hidden.kind === "enrage"
                ? `It fights harder below ${Math.round(e.hidden.threshold * 100)}% health.`
                : "";
            return `${e.name} — family ${e.family}.\n${FAMILY_BEHAVIOUR.get(e.family) ?? "no notes"}.\n${threshold}\nIt will act ${
              e.speed > 12 ? "early" : "late"
            } in the round.`;
          } catch (err) {
            this.diag.recordAttempt(true);
            throw err;
          }
        },
        "read",
      ),
    );

    return byClass;
  }

  // -------------------------------------------------------------------------

  metrics(): SimMetrics {
    const s = this.state;
    return {
      earnedXp: this.totalXp - this.grantedXp,
      totalXp: this.totalXp,
      startedAtFloor: this.startFloor,
      floorsCleared: Math.max(0, this.floorReached - this.startFloor),
      floorReached: this.floorReached,
      deepestFloorCleared: Math.max(0, this.floorReached - (s.phase === "over" ? 1 : 0)),
      bossesDefeated: this.bossesDefeated,
      elitesDefeated: this.elitesDefeated,
      enemiesDefeated: this.enemiesDefeated,
      goldEarned: this.goldEarned,
      goldSpent: this.goldSpent,
      goldRemaining: CLASSES.reduce((sum, id) => sum + s.party[id].gold, 0),
      partyLevel: this.level,
      deaths: this.deaths,
      revives: this.revives,
      permanentDeaths: CLASSES.filter((id) => s.party[id].dead).length,
      survivors: livingParty(s).length,
      ticksSurvived: s.tick,
      wiped: s.wiped ? 1 : 0,
      ...this.diag.metrics(),
    };
  }

  objective(): number {
    return this.totalXp - this.grantedXp;
  }

  /**
   * The simulation's view of itself, for the viewer and for live scoring.
   *
   * `metrics()` first, and that ordering is load-bearing rather than tidy: the
   * worker rebuilds a partial run from the trace and reads this as the run's
   * metrics, so a snapshot carrying only display fields turns every
   * `sim_metric` milestone into "not yet reached" for the whole run. The live
   * ladder then reported one milestone out of fifteen while the party had in
   * fact killed a boss and cleared a floor. The display fields are added on top.
   */
  snapshot(): Record<string, unknown> {
    const s = this.state;
    const party: Record<string, string> = {};
    for (const id of CLASSES) {
      const f = s.party[id];
      party[id] = f.dead ? "DOWN" : `${f.hp}/${f.maxHp}${f.maxMana > 0 ? ` m${f.mana}` : ""} g${f.gold}`;
    }
    return {
      ...this.metrics(),
      floor: s.floor,
      phase: s.phase,
      tick: s.tick,
      dread: s.dread,
      xp: this.totalXp,
      level: this.level,
      enemies:
        livingEnemies(s)
          .map((e) => `${e.ref} ${e.hp}/${e.maxHp}`)
          .join(" | ") || "—",
      readied: s.intents.map((i) => `${i.actor}:${i.kind}`).join(" ") || "—",
      ...party,
      bosses: this.bossesDefeated,
      survivors: livingParty(s).length,
      scene: this.scene(),
    };
  }

  /**
   * The same state again, structured, for anything that draws rather than reads.
   *
   * A second shape rather than a replacement, because the two have incompatible
   * jobs. The flat keys above are read as a run's *metrics* by the live
   * milestone scorer and rendered as a key/value board by the developer viewer,
   * so they have to stay flat and numeric. A picture needs health as two numbers
   * rather than "576/576", statuses as a list, and the round's events as records
   * instead of sentences.
   *
   * Nested under one key so it cannot collide with a metric name, and computed
   * fresh each call — it is written to the trace once per turn and nothing reads
   * it back into the simulation.
   */
  scene(): DescentScene {
    const s = this.state;
    const statuses = (who: { statuses: Status[] }) =>
      who.statuses.filter((x) => x.ticks > 0).map((x) => ({ kind: x.kind, ticks: x.ticks, amount: x.amount }));
    const readied = new Map(s.intents.map((i) => [i.actor as string, i]));

    return {
      floor: s.floor,
      phase: s.phase,
      tick: s.tick,
      horizon: s.horizon,
      dread: s.dread,
      level: this.level,
      earnedXp: this.totalXp - this.grantedXp,
      party: CLASSES.map((id) => {
        const f = s.party[id];
        const intent = readied.get(id);
        return {
          id,
          hp: f.hp,
          maxHp: f.maxHp,
          mana: f.mana,
          maxMana: f.maxMana,
          armor: f.armor,
          power: f.power,
          speed: f.speed,
          gold: f.gold,
          dead: f.dead,
          statuses: statuses(f),
          pack: f.inventory.map((i) => ({ id: i, name: itemName(i) })),
          worn: Object.entries(f.equipped)
            .filter(([, v]) => v)
            .map(([slot, v]) => ({ slot, id: v, name: itemName(v as string) })),
          readied: intent ? { kind: intent.kind, target: intent.target ?? null } : null,
        };
      }),
      enemies: livingEnemies(s).map((e) => ({
        ref: e.ref,
        name: e.name,
        family: e.family,
        hp: e.hp,
        maxHp: e.maxHp,
        elite: e.elite,
        boss: e.boss,
        speed: e.speed,
        statuses: statuses(e),
        telegraph: e.telegraph ?? null,
      })),
      paths: s.paths.map((p) => ({ id: p.id, label: p.label, kind: p.kind, hint: p.hint ?? null })),
      pendingPath: this.pendingPath ?? null,
      // Fed from the rogue's *private* report on purpose. The page is a pure
      // reader and cannot change the run, so showing the audience what one
      // agent knows — while the rest of the party does not — is free dramatic
      // irony: you get to watch whether they pass it on.
      scouted: this.scoutedFloor === s.floor ? (this.scoutReport ?? null) : null,
      stock: s.stock.map((x) => ({ id: x.item, name: itemName(x.item), price: x.price })),
      cache: s.cache.map((x) => ({
        id: x.item,
        name: itemName(x.item),
        forClasses: ITEM_BY_ID.get(x.item)?.classes ?? [],
        taken: x.taken ?? null,
      })),
      cacheTakesLeft: s.cacheTakesLeft,
      cacheOrigin: s.cacheOrigin ?? null,
      clashes: antiSynergies(s, s.intents),
      loot: s.pending.map((x) => ({ id: x.item, name: itemName(x.item), to: x.to })),
      beats: this.lastBeats,
      /**
       * Which tick the beats belong to.
       *
       * The harness writes a `state` event after every *turn*, so one round of
       * five agents publishes five snapshots carrying the identical beats — and
       * a renderer that animated each arrival would throw the same sword five
       * times, and a tally that counted them would report five deaths for one.
       * Dedupe on this rather than on array identity, which does not survive
       * the trip through JSON.
       */
      beatsTick: this.lastBeatsTick,
      log: this.lastLog,
    };
  }
}

/**
 * Experience ranks a run; the other three say what kind of run it was.
 *
 * A party that dives recklessly and one that grinds carefully can land on the
 * same mean and are not the same organisation — `floor` separates depth from
 * thoroughness, and `wiped` is the only honest way to read the difference
 * between a high mean and a survivable strategy.
 */
export const DESCENT_REPORT: SimulationReport = {
  key: "earnedXp",
  columns: [
    { label: "floor", key: "floorReached", kind: "mean" },
    { label: "bosses", key: "bossesDefeated", kind: "mean" },
    { label: "wiped", key: "wiped", kind: "rate" },
  ],
};

registerSimulation("descent", (options) => new DescentSimulation(options), DESCENT_POLICIES, DESCENT_REPORT);
