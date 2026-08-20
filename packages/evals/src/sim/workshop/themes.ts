/**
 * The jam: a theme, a clock, and categories somebody scores afterwards.
 *
 * A brief on its own asks "can five agents build a thing". A *jam* asks
 * something sharper and more measurable by a human: can they take a constraint
 * they did not choose, commit to one reading of it early, and still finish.
 *
 * ## Why a theme rather than a longer brief
 *
 * Two reasons, and the second is the one that matters.
 *
 * A theme is the cheapest known defence against memorisation. `docs/open-builds.md`
 * warns that a model which has read a thousand breakout clones will produce a
 * competent breakout clone and that the polish is recalled rather than earned —
 * and the first two live runs did exactly that shape of thing, producing
 * well-built variants of games that certainly exist. "Only one" or "it grows"
 * cannot be satisfied by recall alone, because the constraint has to reach into
 * the mechanics.
 *
 * And a theme is *judgeable*. "Is this good" is hard to hold steady across two
 * reviews six weeks apart; "does this use the theme in its mechanics, or does it
 * mention the theme in its title screen" is a question a person answers the same
 * way twice. That is what makes theme relevance the first category below.
 *
 * ## The categories are for a person, and are deliberately not computed
 *
 * Nothing in this file is scored by the package. `metrics()` still reports
 * activity and the schema still refuses to let anything assert on it. The
 * scorecard is written into the artifact directory as an empty form, because a
 * qualitative eval with no structure to the qualitative part decays into "seems
 * fine" within three runs — and five fixed questions make two reviews
 * comparable, which is the only kind of comparability this eval can have.
 */

export interface Theme {
  id: string;
  /** What the teams are told, verbatim. Short on purpose: a theme is a prompt, not a spec. */
  title: string;
  /** One line on what a *shallow* reading looks like, so the brief can warn against it. */
  shallow: string;
}

/**
 * Real jam themes, in the sense that each admits several honest readings and
 * punishes the laziest one.
 */
export const THEMES: Theme[] = [
  {
    id: "only-one",
    title: "ONLY ONE",
    shallow: "one life, and nothing else about the game changed",
  },
  {
    id: "it-grows",
    title: "IT GROWS",
    shallow: "a number goes up",
  },
  {
    id: "out-of-control",
    title: "OUT OF CONTROL",
    shallow: "the controls are randomly inverted",
  },
  {
    id: "two-halves",
    title: "TWO HALVES",
    shallow: "a split screen with the same game twice",
  },
  {
    id: "the-last-one",
    title: "THE LAST ONE",
    shallow: "a survival mode with a countdown",
  },
  {
    id: "held-together",
    title: "HELD TOGETHER",
    shallow: "a health bar renamed to something about tape",
  },
  {
    id: "you-are-the-hazard",
    title: "YOU ARE THE HAZARD",
    shallow: "an enemy that copies your movement",
  },
  {
    id: "no-going-back",
    title: "NO GOING BACK",
    shallow: "auto-scrolling in one direction",
  },
];

/**
 * The theme for a run: an explicit id, free text, or one drawn from the seed.
 *
 * Seeded rather than random so a run can be repeated, and overridable so an
 * afternoon's iteration is not eight runs of the same theme.
 */
export function pickTheme(requested: unknown, seed: number): Theme {
  const raw = String(requested ?? "").trim();
  if (raw) {
    const found = THEMES.find((t) => t.id === raw.toLowerCase() || t.title.toLowerCase() === raw.toLowerCase());
    if (found) return found;
    // Free text, used verbatim. A jam organiser gets to invent a theme.
    return { id: "custom", title: raw.toUpperCase(), shallow: "a title-screen mention and nothing in the mechanics" };
  }
  const index = Math.abs(Math.floor(seed)) % THEMES.length;
  return THEMES[index];
}

export interface Category {
  key: string;
  name: string;
  /** What the judge is being asked. */
  question: string;
  /** What a 1 looks like and what a 5 looks like, so the scale means the same thing twice. */
  low: string;
  high: string;
}

/**
 * Six categories, scored 1–5 by a person.
 *
 * Theme relevance is first because it is the one this eval adds over "build
 * something", and the one least reachable by recall. The rest are the axes a
 * jam actually argues about, minus audio (the brief forbids sound) and minus
 * anything requiring more than one sitting to assess.
 */
export const JUDGING: Category[] = [
  {
    key: "theme",
    name: "Theme relevance",
    question: "Does the theme shape the mechanics, or is it decoration?",
    low: "the theme appears in the title and nowhere else",
    high: "remove the theme and the game stops making sense",
  },
  {
    key: "fun",
    name: "Fun",
    question: "Is the core loop actually enjoyable for a minute?",
    low: "you understand it and have no reason to continue",
    high: "you lose and immediately press the key again",
  },
  {
    key: "visual",
    name: "Visual craft",
    question: "Does it look considered, given that everything is drawn from shapes?",
    low: "default colours, unaligned text, nothing framed",
    high: "a coherent palette and a screen you would screenshot",
  },
  {
    key: "innovation",
    name: "Innovation",
    question: "Is there an idea here you have not seen before?",
    low: "a competent clone of something that exists",
    high: "one mechanic you would steal",
  },
  {
    key: "polish",
    name: "Polish & completeness",
    question: "Does it feel finished — title, play, lose, restart, no dead ends?",
    low: "it starts mid-game, or a state you cannot leave",
    high: "every state resolves and nothing needs explaining",
  },
  {
    key: "technical",
    name: "Technical soundness",
    question: "Does it run clean and handle the edges?",
    low: "console errors, or it breaks when you hold two keys",
    high: "no errors, survives abuse, degrades sensibly",
  },
];

/**
 * The scorecard, written into the artifact directory as an empty form.
 *
 * Deliberately a file rather than a prompt in a chat: the review happens when
 * somebody opens the folder, possibly days later, and the questions have to be
 * there when they do.
 */
export function renderScorecard(theme: Theme, rounds: number, entry: string): string {
  const lines = [
    "# Jam scorecard",
    "",
    `**Theme:** ${theme.title}`,
    `**Jam length:** ${rounds} rounds`,
    `**Open:** \`workspace/${entry}\``,
    "",
    "Screenshots taken during the run are in `playtests/`, one directory per round in which",
    "somebody ran the game. `submission.md` is the team's own pitch — read that first, the way",
    "you would on a jam page.",
    "",
    "Score each 1–5. Nothing here is computed and nothing in the benchmark reads it back;",
    "the numbers exist so two reviews weeks apart mean the same thing.",
    "",
    "| # | Category | 1 | 5 | Score | Notes |",
    "|---|---|---|---|---|---|",
    ...JUDGING.map((c) => `| ${c.key} | **${c.name}** | ${c.low} | ${c.high} |  |  |`),
    "",
    "## The question each one is asking",
    "",
    ...JUDGING.map((c) => `- **${c.name}** — ${c.question}`),
    "",
    "## Overall",
    "",
    "- Would you keep it? ",
    "- What is the one thing you would change first? ",
    "- What did they never notice? ",
  ];
  return lines.join("\n");
}
