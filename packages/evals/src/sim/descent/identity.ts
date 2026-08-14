/**
 * Seeded character identity for the descent.
 *
 * This is deliberately its own content stream. A new name or backstory must
 * not move a monster, change a shop, or alter a damage roll; the simulation
 * hands this module a fork named `identities-v1` and nothing here reaches any
 * other RNG.
 */

import type { Rng } from "../rng.js";
import {
  type CharacterIdentity,
  CLASSES,
  type ClassId,
  type PersonalGoal,
  type PersonalGoalKind,
  type PersonalityTrait,
  type PersonalityTraitId,
} from "./model.js";

interface TraitDefinition {
  id: PersonalityTraitId;
  name: string;
  bands: Array<{ label: string; description: string }>;
}

const TRAITS: TraitDefinition[] = [
  {
    id: "boldness",
    name: "Boldness",
    bands: [
      { label: "very cautious", description: "avoids risks unless the need is overwhelming" },
      { label: "guarded", description: "prefers a safe advantage before committing" },
      { label: "balanced", description: "weighs danger without being ruled by it" },
      { label: "daring", description: "accepts danger for a worthwhile opening" },
      { label: "fearless", description: "is drawn toward the choice nobody else will risk" },
    ],
  },
  {
    id: "self-interest",
    name: "Self-interest",
    bands: [
      { label: "selfless", description: "puts the party's needs before personal advantage" },
      { label: "cooperative", description: "usually gives ground when the group benefits" },
      { label: "balanced", description: "balances personal wants against the common good" },
      { label: "self-reliant", description: "protects a fair personal share of every reward" },
      { label: "self-serving", description: "strongly prefers outcomes that improve their own position" },
    ],
  },
  {
    id: "spending",
    name: "Spending",
    bands: [
      { label: "careful saver", description: "parts with gold only for an exceptional return" },
      { label: "frugal", description: "prefers reserves and bargains to immediate upgrades" },
      { label: "measured", description: "spends when the benefit is clear" },
      { label: "free-spending", description: "would rather own an advantage now than gold later" },
      { label: "lavish", description: "sees an unspent purse as a missed opportunity" },
    ],
  },
  {
    id: "deliberation",
    name: "Deliberation",
    bands: [
      { label: "impulsive", description: "acts on the first convincing instinct" },
      { label: "instinctive", description: "thinks briefly and trusts experience" },
      { label: "adaptive", description: "plans enough to move, then adjusts" },
      { label: "methodical", description: "prefers an explicit plan before action" },
      { label: "calculating", description: "wants contingencies settled before anyone commits" },
    ],
  },
  {
    id: "curiosity",
    name: "Curiosity",
    bands: [
      { label: "single-minded", description: "keeps attention on the direct route and stated objective" },
      { label: "focused", description: "investigates only clues likely to matter" },
      { label: "open", description: "makes room for discovery without chasing every mystery" },
      { label: "inquisitive", description: "is willing to detour for an unanswered question" },
      { label: "restless explorer", description: "finds an unopened way almost impossible to ignore" },
    ],
  },
];

const NAMES = [
  "Aderyn",
  "Amaris",
  "Ansel",
  "Arden",
  "Aster",
  "Bram",
  "Brin",
  "Cairn",
  "Cassia",
  "Corin",
  "Dara",
  "Devra",
  "Eiren",
  "Elian",
  "Ember",
  "Eska",
  "Fenn",
  "Galen",
  "Hale",
  "Ilyra",
  "Iven",
  "Jori",
  "Kael",
  "Kestrel",
  "Lio",
  "Lumen",
  "Maelin",
  "Mara",
  "Miren",
  "Neris",
  "Niko",
  "Nim",
  "Orin",
  "Perrin",
  "Quill",
  "Rhea",
  "Riven",
  "Rowan",
  "Sabine",
  "Sable",
  "Sena",
  "Sol",
  "Tamsin",
  "Tarin",
  "Thane",
  "Vale",
  "Vesper",
  "Wren",
  "Yara",
  "Zev",
];

const PRONOUNS = [
  { subject: "she", object: "her", possessive: "her" },
  { subject: "he", object: "him", possessive: "his" },
  { subject: "they", object: "them", possessive: "their" },
];

const ANCESTRIES = ["human", "dwarf", "elf", "halfling", "orc", "goblin", "dragonborn", "tiefling"];

const BUILDS = [
  "short and broad-shouldered",
  "compact and quick",
  "lean and long-limbed",
  "tall and spare",
  "solidly built",
  "wiry",
  "average in height and athletic",
  "imposing and heavy-set",
];

const FEATURES = [
  "a pale scar through one eyebrow",
  "ink-stained fingers",
  "a crown of close-cropped curls",
  "a long braid threaded with copper",
  "weathered tattoos around both wrists",
  "one clouded eye",
  "a chipped front tooth and an easy grin",
  "ritual paint beneath the eyes",
  "silver rings along one ear",
  "a burn mark climbing the left hand",
  "a meticulously waxed moustache",
  "freckles across the nose",
  "a shaved head marked with old vows",
  "dark hair cut with a knife",
  "a voice softer than expected at first",
];

const ORIGINS: Record<ClassId, string[]> = {
  guardian: [
    "once held a city gate while the people behind it escaped",
    "left a ceremonial guard after being ordered to protect a title instead of a life",
    "learned the shield in caravan work where every survivor mattered",
    "was the last recruit standing after a border fortress fell",
  ],
  mage: [
    "was expelled from an academy for testing a forbidden theory in public",
    "learned magic from a lighthouse keeper who charted storms as if they were spells",
    "carries the unfinished field notes of a vanished mentor",
    "survived a laboratory fire that answered one question and created ten more",
  ],
  rogue: [
    "mapped rooftops for smugglers before stealing the maps back",
    "grew up guiding pilgrims through a city that changed its alleys at night",
    "left a thieves' guild after one contract named a friend",
    "made a living opening doors whose owners swore had no locks",
  ],
  cleric: [
    "served a roadside hospice until something began taking the recovered in their sleep",
    "lost faith in a temple and found it again among ordinary people",
    "learned battlefield medicine before learning any prayer",
    "carries a saint's broken bell and no certainty about why it still rings",
  ],
  ranger: [
    "spent years following a migration no scholar believed existed",
    "guarded a mountain pass until the tracks began leading up sheer stone",
    "was raised by surveyors who marked blank spaces as invitations",
    "left a royal hunt after realizing the quarry understood the game better than the hunters",
  ],
};

const REASONS = [
  "The endless stair resembles a place from an old family warning, and leaving it unanswered became impossible.",
  "A companion disappeared below years ago; every floor is another chance to learn where the trail ended.",
  "They believe anything truly without an end must eventually reveal who built it.",
  "Debt, pride, and a promise made at the wrong bedside all point in the same downward direction.",
  "They came for a fortune, but privately suspect knowledge will be harder to surrender than gold.",
];

const ASPIRATIONS: Record<ClassId, string[]> = {
  guardian: [
    "Bring everyone through the first boss still standing.",
    "Become the person the others trust when a retreat turns ugly.",
    "Prove that caution and courage can occupy the same shield wall.",
  ],
  mage: [
    "Record one dungeon law nobody on the surface has named.",
    "Build a spellbook from discoveries rather than inherited doctrine.",
    "Show that knowledge shared quickly is worth more than power hoarded.",
  ],
  rogue: [
    "Find the route the dungeon most wants to keep hidden.",
    "Never let a locked door make the party's decision for them.",
    "Make being first into danger useful to everyone behind them.",
  ],
  cleric: [
    "Make sure every descent still has five voices in it.",
    "Learn what the dungeon asks in exchange for returning a life.",
    "Keep mercy practical when fear makes it look expensive.",
  ],
  ranger: [
    "Leave a map honest enough that another expedition could trust it.",
    "Learn which creatures belong here and which are trapped here too.",
    "Find a floor whose tracks tell a story nobody expected.",
  ],
};

interface GoalDefinition {
  id: PersonalGoalKind;
  title: string;
  description: string;
  event: PersonalGoal["event"];
  target: number;
  unit: string;
  classes?: ClassId[];
  affinity: (scores: Record<PersonalityTraitId, number>) => number;
}

const GOALS: GoalDefinition[] = [
  {
    id: "benefactor",
    title: "A debt paid forward",
    description: "Personally give 100 gold to other party members.",
    event: "gold-given",
    target: 100,
    unit: "gold given",
    affinity: (s) => 130 - s["self-interest"] + (100 - s.spending) * 0.2,
  },
  {
    id: "big-spender",
    title: "Gold cannot fight",
    description: "Personally spend 150 gold at outfitters and merchants.",
    event: "gold-spent",
    target: 150,
    unit: "gold spent",
    affinity: (s) => s.spending + s.boldness * 0.2,
  },
  {
    id: "rare-collector",
    title: "Something worthy of a legend",
    description: "Equip one rare or epic item.",
    event: "rare-equipped",
    target: 1,
    unit: "rare item equipped",
    affinity: (s) => s["self-interest"] * 0.55 + s.curiosity * 0.65,
  },
  {
    id: "trailblazer",
    title: "First through the door",
    description: "Personally lead the party into three previously unexplored rooms.",
    event: "new-room-led",
    target: 3,
    unit: "new rooms led",
    affinity: (s) => s.curiosity * 0.8 + s.boldness * 0.5,
  },
  {
    id: "iron-vow",
    title: "Let it break on me",
    description: "Endure 100 points of enemy or environmental damage and remain in the expedition.",
    event: "damage-taken",
    target: 100,
    unit: "damage endured",
    classes: ["guardian"],
    affinity: (s) => s.boldness + (100 - s["self-interest"]) * 0.35,
  },
  {
    id: "lifesaver",
    title: "No life spent cheaply",
    description: "Restore 100 points of health to the party during combat.",
    event: "healing-done",
    target: 100,
    unit: "health restored",
    classes: ["cleric"],
    affinity: (s) => 145 - s["self-interest"] + s.deliberation * 0.15,
  },
  {
    id: "executioner",
    title: "Remember the last blow",
    description: "Personally land the killing blow on three enemies.",
    event: "killing-blow",
    target: 3,
    unit: "killing blows",
    affinity: (s) => s.boldness * 0.7 + s["self-interest"] * 0.35,
  },
  {
    id: "lock-opener",
    title: "No door decides for us",
    description: "Personally open a locked route with a key, lock-pick, or breach.",
    event: "lock-opened",
    target: 1,
    unit: "locked routes opened",
    affinity: (s) => s.curiosity * 0.75 + s.boldness * 0.45,
  },
  {
    id: "deep-delver",
    title: "See what waits below",
    description: "Reach floor three alive.",
    event: "floor-reached",
    target: 3,
    unit: "deepest floor reached",
    affinity: (s) => s.boldness * 0.55 + s.deliberation * 0.35 + s.curiosity * 0.25,
  },
  {
    id: "watchful-eye",
    title: "Know before they choose",
    description: "Scout the ways ahead on two different floors.",
    event: "scout-used",
    target: 2,
    unit: "floors scouted",
    classes: ["rogue"],
    affinity: (s) => s.curiosity + s.deliberation * 0.25,
  },
];

const cap = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text);

const choose = <T>(values: readonly T[], rng: Rng): T => values[rng.int(0, values.length - 1)];

function rollTraits(rng: Rng): PersonalityTrait[] {
  return TRAITS.map((definition) => {
    const score = rng.int(1, 100);
    const band = definition.bands[Math.min(4, Math.floor((score - 1) / 20))];
    return {
      id: definition.id,
      name: definition.name,
      score,
      label: band.label,
      description: band.description,
    };
  });
}

export function strongestPersonalityTraits(identity: CharacterIdentity, count = 2): PersonalityTrait[] {
  return [...identity.traits]
    .sort((a, b) => Math.abs(b.score - 50.5) - Math.abs(a.score - 50.5) || a.id.localeCompare(b.id))
    .slice(0, count);
}

function archetype(traits: PersonalityTrait[]): string {
  const strongest = [...traits]
    .sort((a, b) => Math.abs(b.score - 50.5) - Math.abs(a.score - 50.5) || a.id.localeCompare(b.id))
    .slice(0, 2);
  return strongest.map((trait) => `${trait.label} ${trait.name.toLowerCase()}`).join(" with ");
}

function pickGoal(id: ClassId, traits: PersonalityTrait[], used: Set<PersonalGoalKind>, rng: Rng): PersonalGoal {
  const scores = Object.fromEntries(traits.map((trait) => [trait.id, trait.score])) as Record<
    PersonalityTraitId,
    number
  >;
  const compatible = GOALS.filter((goal) => !goal.classes || goal.classes.includes(id));
  const unused = compatible.filter((goal) => !used.has(goal.id));
  const candidates = unused.length > 0 ? unused : compatible;
  const ranked = candidates
    .map((goal) => ({ goal, score: goal.affinity(scores) + rng.range(0, 35) }))
    .sort((a, b) => b.score - a.score || a.goal.id.localeCompare(b.goal.id));
  const selected = ranked[0].goal;
  used.add(selected.id);
  return {
    id: selected.id,
    title: selected.title,
    description: selected.description,
    event: selected.event,
    progress: 0,
    target: selected.target,
    unit: selected.unit,
    revealed: false,
    completed: false,
  };
}

/** Generate all five together so provisional names and motives are unique within the run. */
export function generatePartyIdentities(rng: Rng): Record<ClassId, CharacterIdentity> {
  const identities = {} as Record<ClassId, CharacterIdentity>;
  const usedNames = new Set<string>();
  const usedGoals = new Set<PersonalGoalKind>();

  for (const id of CLASSES) {
    const own = rng.fork(id);
    const traits = rollTraits(own.fork("traits"));
    const availableNames = NAMES.filter((name) => !usedNames.has(name.toLowerCase()));
    const generatedName = choose(availableNames, own.fork("name"));
    usedNames.add(generatedName.toLowerCase());
    const pronouns = { ...choose(PRONOUNS, own.fork("pronouns")) };
    const ancestry = choose(ANCESTRIES, own.fork("ancestry"));
    const build = choose(BUILDS, own.fork("build"));
    const distinguishingFeature = choose(FEATURES, own.fork("feature"));
    const article = /^[aeiou]/i.test(build) ? "an" : "a";
    const appearance = `${cap(pronouns.subject)} is ${article} ${build} ${ancestry} with ${distinguishingFeature}.`;
    const origin = choose(ORIGINS[id], own.fork("origin"));
    const reason = choose(REASONS, own.fork("reason"));
    const backstory = `${generatedName} ${origin}. ${reason}`;

    identities[id] = {
      displayName: generatedName,
      generatedName,
      nameSource: "generated",
      renamed: false,
      pronouns,
      ancestry,
      build,
      distinguishingFeature,
      appearance,
      backstory,
      publicAspiration: choose(ASPIRATIONS[id], own.fork("aspiration")),
      traits,
      archetype: archetype(traits),
      secretGoal: pickGoal(id, traits, usedGoals, own.fork("goal")),
    };
  }
  return identities;
}

const RESERVED_NAMES = new Set([...CLASSES, "unknown", "narrator", "dungeon", "enemy", "party"]);

/** Normalise and validate a player-written display name before it enters state or the broadcast. */
export function validateDisplayName(raw: string, taken: readonly string[]): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 24) throw new Error("choose a name between 2 and 24 characters.");
  if (!/^[A-Za-z][A-Za-z '-]*$/.test(name)) {
    throw new Error("names may contain letters, spaces, apostrophes, and hyphens only.");
  }
  const key = name.toLowerCase();
  if (RESERVED_NAMES.has(key)) throw new Error(`"${name}" is reserved by the game.`);
  if (taken.some((candidate) => candidate.toLowerCase() === key)) {
    throw new Error(`somebody in the party is already called "${name}".`);
  }
  return name;
}

export function goalProgressText(goal: PersonalGoal): string {
  if (goal.completed) return `complete (${goal.target}/${goal.target} ${goal.unit})`;
  return `${Math.min(goal.progress, goal.target)}/${goal.target} ${goal.unit}`;
}
