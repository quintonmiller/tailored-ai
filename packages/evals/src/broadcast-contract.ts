/**
 * The scene the simulation publishes and the broadcast draws, declared once.
 *
 * A leaf file on purpose: it imports nothing, so it can be compiled by both
 * halves of this package. `tsconfig.json` builds it for Node and
 * `tsconfig.viewer.json` builds it for the browser, and neither drags the
 * other's globals across — which is the whole reason the shape is not simply
 * imported from `sim/descent/index.ts`, a module that reaches `node:fs` through
 * the simulation registry.
 *
 * `sim/descent/scene-check.ts` asserts, at compile time, that the simulation's
 * own `DescentScene` is exactly this. Rename a field on either side and the
 * build fails at the seam — rather than the browser reading `undefined`,
 * drawing a health bar at zero, and reporting nothing.
 */

export type ClassId = "guardian" | "mage" | "rogue" | "cleric" | "ranger";

export type DamageElement = "physical" | "fire" | "frost" | "lightning" | "shadow" | "holy";

export type Phase = "explore" | "combat" | "spoils" | "market" | "cache" | "camp" | "over";

export interface SceneStatus {
  kind: string;
  ticks: number;
  amount: number;
}

export interface SceneItem {
  id: string;
  baseId: string;
  name: string;
  kind: string;
  rarity: string;
  description: string;
  affixes: Array<{
    id: string;
    name: string;
    description: string;
    polarity: "positive" | "negative";
    modifiers: { power?: number; armor?: number; hp?: number; mana?: number; speed?: number };
    effect?: { kind: string; fraction?: number; amount?: number; scope?: string };
  }>;
  provenance: { source: string; floor: number };
}

/** One animatable thing that happened. See the note on `Beat` in the simulation. */
export interface SceneBeat {
  kind: "hit" | "heal" | "shield" | "status" | "wasted" | "death" | "mechanic" | "guard" | "spawn";
  from?: string;
  to?: string;
  amount?: number;
  element?: DamageElement;
  note?: string;
}

export interface ScenePartyMember {
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
  talentPoints: number;
  talents: Array<{ id: string; name: string; rank: number }>;
  cooldowns: Array<{ id: string; ticks: number }>;
  statuses: SceneStatus[];
  pack: SceneItem[];
  worn: Array<SceneItem & { slot: string }>;
  readied: { kind: string; target: string | null } | null;
}

export interface SceneEnemy {
  ref: string;
  name: string;
  family: string;
  hp: number;
  maxHp: number;
  elite: boolean;
  boss: boolean;
  speed: number;
  statuses: SceneStatus[];
  telegraph: string | null;
}

export interface Scene {
  floor: number;
  phase: Phase;
  tick: number;
  horizon: number;
  dread: number;
  level: number;
  earnedXp: number;
  party: ScenePartyMember[];
  enemies: SceneEnemy[];
  paths: Array<{ id: string; label: string; kind: string; hint: string | null }>;
  floorMap: {
    zone: string;
    currentRoom: string;
    rooms: Array<{
      id: string;
      label: string;
      kind: string;
      links: string[];
      x: number;
      y: number;
      visited: boolean;
      revealed: boolean;
      cleared: boolean;
    }>;
  } | null;
  pendingPath: string | null;
  scouted: string | null;
  stock: Array<SceneItem & { price: number }>;
  cache: Array<SceneItem & { forClasses: string[]; taken: string | null }>;
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
  loot: Array<SceneItem & { to: ClassId }>;
  beats: SceneBeat[];
  /**
   * Which tick the beats belong to.
   *
   * The harness writes a snapshot after every *turn*, so one round of five
   * agents publishes five scenes carrying identical beats. Anything that
   * animates or counts them must dedupe on this, or it throws the same sword
   * five times and reports five deaths for one.
   */
  beatsTick: number;
  log: string[];
}
