/**
 * What an agent is for, read from its name, its description, its
 * instructions and its tools, and what follows from that in the world: a
 * word for it ("coder", "writer", "producer"), the kind of home that suits
 * it, something in that home for the work (a server rack, a microphone, a
 * globe), and what its body wears unless it chooses otherwise.
 *
 * Read from words alone, with no model call. Each role has a few patterns,
 * and an agent has a role only when its name or its description says one:
 * those are written to say what it is for. Its instructions and the tools it
 * is given only add to a role already said, to choose between two, since
 * instructions mention all sorts in passing and most agents are given the
 * same exec, edit and web search. The name counts over everything else
 * together, and a tie goes to the role listed first, so the more particular
 * role wins over the general one: a trip planner is a travel agent before it
 * is a planner, a code reviewer a reviewer before a coder. An agent whose
 * name and description say nothing has no role: its home is the seed's, and
 * it wears nothing.
 *
 * Pure, like `places-layout.ts`.
 */
import { seeded } from "./places-rooms.js";

// --------------------------------------------------------------------------
// What a body wears
// --------------------------------------------------------------------------

/** What a body can wear, by name, and where on it each goes: one thing to a place. */
export const WEAR: Record<string, "head" | "eyes" | "neck" | "chest" | "side" | "waist"> = {
  headset: "head",
  glasses: "eyes",
  beret: "head",
  cap: "head",
  "wizard hat": "head",
  "adventurer hat": "head",
  scarf: "neck",
  "bow tie": "neck",
  lanyard: "chest",
  satchel: "side",
  "tool belt": "waist",
};

/** The most a body wears at once. */
export const WEAR_MOST = 4;

/** Other words for the same things. */
const ALIASES: Record<string, string> = {
  headphones: "headset",
  "headset with mic": "headset",
  spectacles: "glasses",
  specs: "glasses",
  "baseball cap": "cap",
  wizard: "wizard hat",
  "witch hat": "wizard hat",
  "pointy hat": "wizard hat",
  adventurer: "adventurer hat",
  "explorer hat": "adventurer hat",
  fedora: "adventurer hat",
  badge: "lanyard",
  "name badge": "lanyard",
  bag: "satchel",
  "messenger bag": "satchel",
  "shoulder bag": "satchel",
  belt: "tool belt",
  toolbelt: "tool belt",
  bowtie: "bow tie",
};

/** "a coder", "an artist". */
export const aOrAn = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

/** "a scarf", "glasses", "an adventurer hat": a thing worn, with its article. */
function withArticle(thing: string): string {
  return thing === "glasses" ? thing : aOrAn(thing);
}

/** What a body wears, in words: "glasses and a lanyard", or "nothing". */
export function wearWords(wear: string[]): string {
  const said = wear.map(withArticle);
  if (!said.length) return "nothing";
  return said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
}

/** What someone asked a body to wear: these things, nothing at all, or whatever suits its role again. */
export type WearAsk = { wear: string[] } | { suited: true } | { problem: string };

/**
 * What to wear, from words ("glasses, scarf", "a cap and a lanyard"), or a
 * list of names: each thing by its name or another word for it, one to a
 * place on the body, at most a few. "none" is nothing at all; "default" is
 * whatever suits the agent's role again.
 */
export function parseWear(input: unknown): WearAsk {
  const parts = Array.isArray(input)
    ? input.map(String)
    : typeof input === "string"
      ? input.split(/,|;|&|\+|\/|\band\b/i)
      : [];
  const asked = parts
    .map((p) =>
      p
        .trim()
        .toLowerCase()
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^(a|an|the|my|some)\s+/, ""),
    )
    .filter(Boolean);
  if (!asked.length || (asked.length === 1 && /^(none|nothing|no|bare|plain)$/.test(asked[0]))) return { wear: [] };
  if (asked.length === 1 && /^(default|usual|role|suited|reset)$/.test(asked[0])) return { suited: true };
  const wear: string[] = [];
  for (const word of asked) {
    const name = WEAR[word]
      ? word
      : (ALIASES[word] ?? (word.endsWith("s") && WEAR[word.slice(0, -1)] ? word.slice(0, -1) : undefined));
    if (!name)
      return {
        problem: `"${word}" isn't something a body can wear. It can wear: ${Object.keys(WEAR).join(", ")}; or none.`,
      };
    if (wear.includes(name)) continue;
    const clash = wear.find((w) => WEAR[w] === WEAR[name]);
    if (clash)
      return { problem: `${withArticle(clash)} and ${withArticle(name)} both go on the ${WEAR[name]}: choose one.` };
    wear.push(name);
  }
  if (wear.length > WEAR_MOST) return { problem: `A body wears at most ${WEAR_MOST} things at once.` };
  return { wear };
}

// --------------------------------------------------------------------------
// Roles
// --------------------------------------------------------------------------

/** What an agent is for, and what follows from it in the world. */
export interface Role {
  id: string;
  /** What it is, in a word or two: for the map, and its card. */
  word: string;
  /** Kinds of home that suit it (presets in `places-rooms.ts`): the seed picks one. */
  homes: string[];
  /** Something its home has for the work (`ROLE_DRESSINGS` in `places-rooms.ts`). */
  dressing?: string;
  /** What its body wears unless it chooses otherwise. */
  wear: string[];
}

interface RoleDef extends Role {
  /**
   * Words that say it, each matched from the start of a word. Only words that
   * mean the role wherever they turn up: "DM" is a direct message as often as
   * a dungeon master, "health" an agent's or a channel's as often as a
   * person's, so neither is here.
   */
  words: RegExp;
  /** Tools that say it, by name: only ones particular to the work, never the exec, edit and web search most agents have. */
  tools?: RegExp;
}

const words = (...alternatives: string[]) => new RegExp(`\\b(?:${alternatives.join("|")})`, "gi");

/** Every role, the more particular first: a tie goes to the one listed first. */
export const ROLES: RoleDef[] = [
  {
    id: "game-master",
    word: "game master",
    words: words("game.?master", "dungeon.?master", "d&d", "dnd\\b", "tabletop", "ttrpgs?\\b", "rpgs?\\b"),
    homes: ["den"],
    dressing: "game",
    wear: ["wizard hat"],
  },
  {
    id: "player",
    word: "player",
    words: words(
      "player",
      "adventurer",
      "paladin",
      "rogue\\b",
      "ranger\\b",
      "bard\\b",
      "cleric",
      "warrior",
      "barbarian",
      "sorcer",
      "warlock",
      "druid",
      "party member",
      "character sheet",
    ),
    homes: ["den"],
    dressing: "game",
    wear: ["adventurer hat", "tool belt"],
  },
  {
    id: "producer",
    word: "producer",
    words: words(
      "podcast",
      "audio",
      "sound\\b",
      "music",
      "radio\\b",
      "recording",
      "narrat",
      "voice.?overs?\\b",
      "voice actor",
      "tts\\b",
      "dj\\b",
      "producer",
      "episodes?\\b",
      "mixing",
      "mixdown",
    ),
    tools: /^(speak|tts|transcribe|audio)/,
    homes: ["studio"],
    dressing: "booth",
    wear: ["headset", "scarf"],
  },
  {
    id: "travel",
    word: "travel agent",
    words: words(
      "travel",
      "trips?\\b",
      "flights?\\b",
      "hotels?\\b",
      "itinerar",
      "vacation",
      "holidays?\\b",
      "touris",
      "passport",
      "airline",
      "getaway",
      "cartograph",
      "mapper",
    ),
    homes: ["lounge"],
    dressing: "travel",
    wear: ["adventurer hat", "satchel"],
  },
  {
    id: "bookkeeper",
    word: "bookkeeper",
    words: words(
      "financ",
      "budget",
      "bookkeep",
      "accountan",
      "accounting",
      "ledger",
      "tax(?:es)?\\b",
      "invoice",
      "expense",
      "money",
      "bank(?:s|ing)?\\b",
      "bills?\\b",
      "billing",
      "invest(?:s|or|ors|ing|ment|ments)?\\b",
      "stocks\\b",
      "stock (?:market|prices?)",
      "payroll",
      "spending",
      "savings",
      "receipts?\\b",
    ),
    homes: ["study"],
    dressing: "accounts",
    wear: ["bow tie", "glasses"],
  },
  {
    id: "coach",
    word: "coach",
    words: words(
      "health.?coach",
      "health.?track",
      "healthy",
      "mental health",
      "physical health",
      "fitness",
      "workouts?\\b",
      "exercis",
      "gym\\b",
      "diet",
      "nutrition",
      "meals?\\b",
      "sleep",
      "medic",
      "doctor",
      "wellness",
      "wellbeing",
      "well-being",
      "yoga",
      "jogging",
      "marathon",
      "coach",
      "therap",
      "moods?\\b",
      "habits?\\b",
    ),
    homes: ["garden"],
    wear: ["cap", "lanyard"],
  },
  {
    id: "reviewer",
    word: "reviewer",
    words: words(
      "reviewer",
      "reviewing",
      "code.?reviews?",
      "reviews? (?:the )?(?:code|pull requests?|prs?\\b|diffs?|changes|drafts?|work)",
      "critic",
      "critique",
      "audit",
      "qa\\b",
      "quality (?:assurance|control)",
      "lint",
      "proofread",
      "checker",
      "verifier",
      "inspector",
      "gatekeep",
      "testers?\\b",
      "judge",
      "judging",
      "grader",
      "grading",
      "scorer",
    ),
    homes: ["study", "workshop"],
    wear: ["glasses", "lanyard"],
  },
  {
    id: "coder",
    word: "coder",
    words: words(
      "code",
      "coder",
      "coding",
      "programm",
      "developer",
      "devs?\\b",
      "engineer",
      "software",
      "debug",
      "refactor",
      "typescript",
      "javascript",
      "python",
      "rust\\b",
      "golang",
      "front.?end",
      "back.?end",
      "full.?stack",
      "hacker",
      "bugs?\\b",
      "compiler",
      "repos?\\b",
      "repositor",
      "pull requests?",
    ),
    tools: /^(coding_agent|claude_code|apply_patch|git)/,
    homes: ["workshop", "study"],
    dressing: "rack",
    wear: ["headset", "glasses"],
  },
  {
    id: "ops",
    word: "operator",
    words: words(
      "devops",
      "ops\\b",
      "sre\\b",
      "deploy",
      "infra",
      "sysadmin",
      "homelab",
      "self.?host",
      "web servers?\\b",
      "uptime",
      "kubernetes",
      "k8s\\b",
      "docker",
      "backups?\\b",
      "incidents?\\b",
      "on.?call",
      "outages?\\b",
    ),
    homes: ["workshop"],
    dressing: "rack",
    wear: ["headset", "tool belt"],
  },
  {
    id: "writer",
    word: "writer",
    words: words(
      "writers?\\b",
      "writing",
      "scribe",
      "journal(?:s|ing)?\\b",
      "author",
      "blog",
      "essay",
      "story",
      "stories",
      "novel",
      "poet",
      "poem",
      "copywrit",
      "prose",
      "editor",
      "editing",
      "manuscript",
      "newsletter",
      "screenplay",
    ),
    homes: ["nook", "study"],
    wear: ["beret", "scarf"],
  },
  {
    id: "artist",
    word: "artist",
    words: words(
      "artist",
      "arts?\\b",
      "designer",
      "graphic",
      "draw",
      "paint",
      "illustrat",
      "sketch",
      "photographer",
      "photography",
      "comic",
      "animator",
    ),
    homes: ["studio"],
    wear: ["beret", "satchel"],
  },
  {
    id: "researcher",
    word: "researcher",
    words: words(
      "research",
      "analy",
      "datasets?\\b",
      "data scien",
      "scien",
      "scholar",
      "investigat",
      "surveys?\\b",
      "studies",
      "literature",
      "papers?\\b",
      "fact.?check",
      "librarian",
      "archivist",
      "historian",
      "look(?:s)? things up",
    ),
    homes: ["study", "nook"],
    wear: ["glasses", "satchel"],
  },
  {
    id: "reporter",
    word: "reporter",
    words: words(
      "news",
      "reporter",
      "digest",
      "briefing",
      "briefer",
      "headlines?\\b",
      "journalis",
      "rss\\b",
      "summar",
      "bulletin",
      "press\\b",
    ),
    homes: ["study", "studio"],
    wear: ["cap", "satchel"],
  },
  {
    id: "tutor",
    word: "tutor",
    words: words(
      "teach",
      "tutor",
      "lessons?\\b",
      "courses\\b",
      "coursework",
      "mentor",
      "school",
      "homework",
      "quiz",
      "flashcard",
    ),
    homes: ["nook"],
    wear: ["glasses", "scarf"],
  },
  {
    id: "clerk",
    word: "clerk",
    words: words(
      "mail",
      "e-?mails?\\b",
      "inbox",
      "sort(?:s|er|ers|ing)?\\b",
      "triage",
      "filing",
      "letters?\\b",
      "correspond",
      "paperwork",
      "notary",
    ),
    tools: /^(gmail|email|mail)/,
    homes: ["study"],
    wear: ["bow tie", "lanyard"],
  },
  {
    id: "housekeeper",
    word: "housekeeper",
    words: words(
      "house",
      "home\\b",
      "chores?\\b",
      "cleaning",
      "cleaner",
      "garden",
      "plants?\\b",
      "grocer",
      "shopping",
      "pantry",
      "kitchen",
      "cook",
      "recipe",
      "chef",
      "room.?keeper",
      "janitor",
      "laundry",
      "pets?\\b",
    ),
    homes: ["garden", "lounge"],
    wear: ["tool belt", "scarf"],
  },
  {
    id: "concierge",
    word: "concierge",
    words: words(
      "concierge",
      "help.?desk",
      "tech support",
      "customers?\\b",
      "butler",
      "receptionist",
      "hostess",
      "greet",
      "welcom",
      "porter",
      "steward",
    ),
    homes: ["lounge"],
    wear: ["bow tie"],
  },
  {
    id: "builder",
    word: "builder",
    words: words(
      "builder",
      "maker",
      "craft",
      "repair",
      "fixer",
      "hardware",
      "electronics",
      "tinker",
      "3d.?print",
      "woodwork",
      "diy\\b",
      "robot",
    ),
    homes: ["workshop"],
    wear: ["cap", "tool belt"],
  },
  {
    id: "planner",
    word: "planner",
    words: words(
      "plan",
      "schedul",
      "calendar",
      "organi[sz]",
      "todos?\\b",
      "to-do",
      "agenda",
      "coordinat",
      "project manag",
      "reminder",
      "routine",
      "assistant",
      "secretary",
      "chief of staff",
    ),
    homes: ["study", "lounge"],
    wear: ["lanyard"],
  },
];

/** What an agent's role is read from. */
export interface AgentAbout {
  name: string;
  description?: string;
  instructions?: string;
  /** The tools it is given by name; none for an agent given every tool, which says nothing about it. */
  tools?: string[];
}

/**
 * How much each kind of evidence counts: the name over everything else
 * together (10 > 4 + 3 + 2), the description over either of the rest alone.
 * Instructions and tools only ever add to a role the name or description says.
 */
const WEIGHT = { name: 10, description: 4, instructions: 1, tools: 1 };
/** Instructions run long and mention all sorts: at most this many of a role's words in them count. */
const INSTRUCTION_HITS = 3;
/** And this many of its tools. */
const TOOL_HITS = 2;
/** Long instructions are read only this far: what an agent is for comes first. */
const INSTRUCTION_CHARS = 4000;

/** A name as words: "podcast-producer", "tripPlanner" and "mail_sorter" read as two words each. */
function nameWords(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_.:]+/g, " ")
    .toLowerCase();
}

const hits = (pattern: RegExp, text: string | undefined) => (text ? (text.match(pattern)?.length ?? 0) : 0);

/**
 * How strongly each role is said of an agent, by role id: only the roles its
 * name or description says. A role its instructions or tools alone suggest is
 * no role: long instructions mention players, history and DMs in passing, and
 * most agents have the same handful of tools.
 */
export function roleScores(about: AgentAbout): Map<string, number> {
  const name = nameWords(about.name);
  const instructions = about.instructions?.slice(0, INSTRUCTION_CHARS);
  const scores = new Map<string, number>();
  for (const role of ROLES) {
    const said =
      (hits(role.words, name) ? WEIGHT.name : 0) + (hits(role.words, about.description) ? WEIGHT.description : 0);
    if (!said) continue;
    const tools = role.tools ? (about.tools ?? []).filter((t) => role.tools?.test(t)).length : 0;
    scores.set(
      role.id,
      said +
        Math.min(INSTRUCTION_HITS, hits(role.words, instructions)) * WEIGHT.instructions +
        Math.min(TOOL_HITS, tools) * WEIGHT.tools,
    );
  }
  return scores;
}

/** What an agent is for, from its name and description, its instructions and tools choosing between two; undefined when neither says. */
export function readRole(about: AgentAbout): Role | undefined {
  const scores = roleScores(about);
  let best: RoleDef | undefined;
  let top = 0;
  for (const role of ROLES) {
    const score = scores.get(role.id) ?? 0;
    if (score > top) {
      best = role;
      top = score;
    }
  }
  if (!best) return undefined;
  const { words: _words, tools: _tools, ...role } = best;
  return role;
}

/** The kind of home that suits a role, the seed choosing among those that do, and what it has for the work. */
export function homeFor(role: Role | undefined, seed: string): { kind?: string; dressing?: string } {
  if (!role) return {};
  const kind = role.homes[Math.floor(seeded(`${seed}\nrole`)() * role.homes.length)];
  return { kind, ...(role.dressing ? { dressing: role.dressing } : {}) };
}
