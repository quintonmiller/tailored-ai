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
  identity: {
    displayName: string;
    generatedName: string;
    nameSource: "generated" | "agent";
    pronouns: { subject: string; object: string; possessive: string };
    ancestry: string;
    appearance: string;
    backstory: string;
    publicAspiration: string;
    archetype: string;
    traits: Array<{ id: string; name: string; score: number; label: string; description: string }>;
    /** Details are observer-only; renderers seal them until disclosure or recap. Null supports old traces. */
    secretGoal: {
      revealed: boolean;
      completed: boolean;
      title: string | null;
      description: string | null;
      progress: number | null;
      target: number | null;
      unit: string | null;
    };
  };
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
  /**
   * Whether this character has openly defected, and whether the party is
   * holding them.
   *
   * **Not spoiler-gated**, and that is the opposite of every other rule here.
   * `betrayal.traitors` answers who was *always* against the party and is
   * sealed until the recap, because knowing it early spoils the deduction. A
   * turn is a different fact: public, irreversible, and known to everybody in
   * the room the moment it happens. Hiding it from the audience would hide
   * something the characters can see, which is the one thing this page must
   * never do.
   *
   * Missing until 2026-08-19, which meant a viewer with spoilers off watched a
   * party of five in which one member was inexplicably attacking the others,
   * with nothing on screen to say why.
   */
  turned: boolean;
  bound: boolean;
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
  paths: Array<{ id: string; label: string; kind: string; route: string | null; hint: string | null }>;
  floorMap: {
    zone: string;
    /** Stable per-floor randomness, so the same floor of two seeds does not look identical. */
    seed: number;
    currentRoom: string;
    keys: number;
    rooms: Array<{
      id: string;
      /**
       * Whether the party has any idea this room exists.
       *
       * Every room of the floor is sent, not only the known ones. The map draws
       * the whole floor and dims what has not been found, because a map whose
       * *set of rooms* changes is a map whose layout changes — and a picture
       * that rearranges itself every time somebody opens a door cannot be read
       * at all. The page never reaches an agent, so this costs the run nothing.
       */
      known: boolean;
      label: string;
      kind: string;
      links: string[];
      x: number;
      y: number;
      visited: boolean;
      revealed: boolean;
      cleared: boolean;
      key: boolean;
      keyCollected: boolean;
      environment: {
        kind: "flooded" | "spore-cloud" | "arcane-well" | "narrow-bridge" | "high-ground";
        name: string;
        effect: string;
      } | null;
      threat: { enemies: number; hp: number; maxHp: number; retreats: number } | null;
    }>;
    routes: Array<{
      id: string;
      from: string;
      to: string;
      /** Whether the party has found this way. Undiscovered ones are drawn faint. */
      discovered: boolean;
      kind: string;
      bidirectional: boolean;
      triggered: boolean;
      disarmed: boolean;
      openedBy: "key" | "rogue" | "guardian" | "paid" | null;
      /** What a toll gate asks, in gold. Null on every other kind of route. */
      toll: number | null;
      traversals: number;
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
  /**
   * What the party said out loud last round, attributed.
   *
   * Separate from `log` because it has a different author. The log is the
   * dungeon reporting what it did; this is the five of them talking, and a
   * viewer that renders the two identically loses the only channel in the run
   * where the party's reasoning is visible without opening a transcript.
   */
  said: Array<{ who: string; text: string; accuses?: string }>;
  /**
   * Who is against the party, for the audience and for nobody in it.
   *
   * Null unless the betrayal layer is on. The page is a pure reader, so naming
   * the traitors here cannot change a run — it buys the viewer the whole point
   * of the mechanic, which is watching four characters reason about something
   * the audience already knows. `murmurs` is the count the party *can* see;
   * `traitors` is the part it cannot.
   */
  betrayal: {
    /**
     * Whether this trace carries the answer at all.
     *
     * Load-bearing next to `traitors`, which is empty in two completely
     * different situations: the seed rolled nobody, and the run was recorded
     * with `revealTraitors: false` so somebody could watch it blind. A page
     * that could not tell them apart would confidently announce "this seed
     * rolled nobody" over a run with two traitors in it.
     */
    revealed: boolean;
    traitors: string[];
    won: boolean;
    murmurs: number;
    accusations: Array<{ by: string; target: string; why: string; tick: number }>;
    /**
     * Every private instrument anybody reached for, and what it said.
     *
     * Audience-only, and the reason it exists is that the social layer is
     * *entirely* private by design: a draught, a read and a poisoning are each
     * known to exactly two people and to nobody else, so a page built from what
     * the party can see would render a run in which four characters slowly turn
     * on each other for no visible reason. This is the half of the screen where
     * the viewer knows more than everyone in the dungeon, which is the whole
     * point of watching one.
     *
     * `verdict` is what the instrument told the user — `true` for "against the
     * party", `false` for "not", and absent for a poisoning, which says
     * nothing. Comparing that against what the holder then announces out loud
     * is the only place a lie is visible.
     *
     * Named `said` until a careful reader took it for "did they say it out
     * loud", concluded from three `said: true` rows that the disclosure
     * tracking was broken, and wrote it up as an instrumentation bug. It was
     * not — the field meant what it always meant. A name that invites a wrong
     * reading in a structure whose entire subject is who-knows-what is a name
     * worth changing.
     */
    instruments: Array<{
      by: string;
      kind: "read" | "draught" | "poison" | "vigil" | "tally" | "reckoning";
      target?: string;
      verdict?: boolean;
      tick: number;
    }>;
  } | null;
}
