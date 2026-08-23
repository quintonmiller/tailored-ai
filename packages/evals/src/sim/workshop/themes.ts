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
 *
 * The five questions themselves now live in `@tailored-ai/arcade`, because the
 * site that stores the answers has to ask the same ones. They are re-exported
 * here so this file stays the one place the jam is described.
 */

import { CATEGORIES, type Category } from "@tailored-ai/arcade";

export type { Category };

export interface Theme {
  id: string;
  /** What the teams are told, verbatim. Short on purpose: a theme is a prompt, not a spec. */
  title: string;
}

/*
 * There used to be a `shallow` field here: one line per theme naming the
 * laziest reading, so the brief could warn against it. It was removed because
 * it worked in reverse.
 *
 * YOU ARE THE HAZARD carried `shallow: "an enemy that copies your movement"`.
 * The brief said, in as many words, that this was the worst possible reading
 * and the first thing a judge would check. The team then built a game whose own
 * pitch was "every death leaves a ghost that replays your path". The warning
 * was the only concrete mechanic anywhere in eight thousand words of brief, and
 * a model reaching for an idea took the one idea on offer.
 *
 * The general rule, which cost a run to learn: never name a mechanic you do not
 * want built. Warn about the *relationship* — theme as decoration rather than
 * as constraint — which is what the judging criteria already do, and leave the
 * mechanics unnamed.
 */

/**
 * Real jam themes, in the sense that each admits several honest readings and
 * punishes the laziest one.
 */
export const THEMES: Theme[] = [
  {
    id: "only-one",
    title: "ONLY ONE",
  },
  {
    id: "it-grows",
    title: "IT GROWS",
  },
  {
    id: "out-of-control",
    title: "OUT OF CONTROL",
  },
  {
    id: "two-halves",
    title: "TWO HALVES",
  },
  {
    id: "the-last-one",
    title: "THE LAST ONE",
  },
  {
    id: "held-together",
    title: "HELD TOGETHER",
  },
  {
    id: "you-are-the-hazard",
    title: "YOU ARE THE HAZARD",
  },
  {
    id: "no-going-back",
    title: "NO GOING BACK",
  },
];

/**
 * A second constraint, on *form* rather than on subject.
 *
 * ## Why
 *
 * Fifteen consecutive entries were the same game. Abstract single-noun titles
 * (SEAM, KNOT, EMBER, WAKE, ECHO), a "you are the X, keep it alive" pitch, and
 * underneath all of them a real-time keyboard avoidance loop on a dark canvas.
 * SEAM was built twice, for two *different* themes; so was THE LAST ONE.
 * Different inputs, identical output — the theme was not reaching the design at
 * all, because something else was deciding it first.
 *
 * A theme constrains what the game is *about*, and "about" is exactly the axis
 * a model can satisfy with a coat of paint. None of the eight themes forbids
 * dodging things, so all eight got dodging things. The genre was never chosen;
 * it was defaulted to, and a theme cannot dislodge a default it does not touch.
 *
 * ## What a diversifier is
 *
 * Real jams run these alongside the theme, and they constrain form: one button,
 * no words, no colour. They work because they are cheap to check and expensive
 * to ignore — you cannot decorate your way out of "the player never moves".
 *
 * Several of these are *deliberately incompatible* with the modal entry above.
 * `stillness`, `turn-based`, `make-not-dodge`, `no-enemies` and `words` each
 * make a real-time avoidance game structurally illegal rather than merely
 * unimaginative. That is the whole point: the constraint has to bite on the
 * axis where the collapse is happening, and prose asking for more imagination
 * has now failed fifteen times running.
 *
 * ## Nine, not eight
 *
 * Nine is coprime with the eight themes, so theme and diversifier do not move
 * in lockstep with the seed — consecutive seeds vary both, and the pairing does
 * not repeat for seventy-two runs. With eight of each, every theme would have
 * been welded to one diversifier forever, which is the same mode collapse one
 * level up.
 */
export interface Diversifier {
  id: string;
  /** Stated to the team verbatim, as a rule of the jam. */
  rule: string;
  /** What the judge is asked, on the scorecard. Must be answerable without playing well. */
  check: string;
}

export const DIVERSIFIERS: Diversifier[] = [
  {
    id: "no-contact",
    rule: "Nothing harms the player by touching it. No collision damage, no contact deaths.",
    check: "Can anything hurt the player by touching it?",
  },
  {
    id: "stillness",
    rule: "The player never moves through space. Whatever the player controls, it is not a position.",
    check: "Does the player move something around the screen?",
  },
  {
    id: "one-key",
    rule: "One key is the entire control scheme. Press, hold and release are all fair; a second key is not.",
    check: "Does anything respond to a second key?",
  },
  {
    id: "turn-based",
    rule: "Nothing in the world moves unless the player has just acted. No real-time loop.",
    check: "Does anything move while the player sits still?",
  },
  {
    id: "no-numbers",
    rule: "No score, no timer, no counters, no bars. Nothing numeric on screen at any point.",
    check: "Is there a number, a bar or a clock anywhere on screen?",
  },
  {
    id: "make-not-dodge",
    rule: "The verb is build, arrange or connect — never avoid, shoot or survive.",
    check: "Is the player mostly avoiding things?",
  },
  {
    id: "words",
    rule: "Text is the main thing on screen and text is the game — not a HUD sitting on top of one.",
    check: "Would the game still work with all the words removed?",
  },
  {
    id: "mouse-only",
    rule: "The mouse is the only input. The keyboard does nothing.",
    check: "Does any key do anything?",
  },
  {
    id: "no-enemies",
    rule: "Nothing in the game is hostile. No enemies, no chasers, no antagonist, no threat.",
    check: "Is something in there trying to end the run?",
  },
];

/** The diversifier for a run: an explicit id, or one drawn from the seed. */
export function pickDiversifier(requested: unknown, seed: number): Diversifier | undefined {
  const raw = String(requested ?? "")
    .trim()
    .toLowerCase();
  if (raw === "none" || raw === "off") return undefined;
  if (raw) {
    const found = DIVERSIFIERS.find((d) => d.id === raw);
    if (found) return found;
    // Free text, used verbatim, so an afternoon can test a constraint that is
    // not on the list without editing the list.
    return { id: "custom", rule: String(requested).trim(), check: "Did they honour the diversifier?" };
  }
  return DIVERSIFIERS[Math.abs(Math.floor(seed)) % DIVERSIFIERS.length];
}

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
    return { id: "custom", title: raw.toUpperCase() };
  }
  const index = Math.abs(Math.floor(seed)) % THEMES.length;
  return THEMES[index];
}

/**
 * The categories, which live in the arcade rather than here.
 *
 * They used to be defined in this file, and that stopped being tenable the
 * moment a site started collecting the scores. The brief tells the agents what
 * they are judged on, the scorecard in the artifact directory asks a reviewer
 * those questions, and the arcade's review form records the answers — three
 * surfaces, and if any of them drifts the whole record becomes uncomparable in
 * a way nothing would report. So there is one list, and it is owned by the
 * thing that stores the numbers.
 *
 * They went from six to five in the move; `@tailored-ai/arcade` says why.
 */
export const JUDGING = CATEGORIES;

/**
 * The scorecard, written into the artifact directory as an empty form.
 *
 * Deliberately a file rather than a prompt in a chat: the review happens when
 * somebody opens the folder, possibly days later, and the questions have to be
 * there when they do.
 */
export function renderScorecard(theme: Theme, rounds: number, entry: string, diversifier?: Diversifier): string {
  const lines = [
    "# Jam scorecard",
    "",
    `**Theme:** ${theme.title}`,
    ...(diversifier
      ? [
          `**Diversifier:** ${diversifier.rule}`,
          "",
          // Asked first, and answerable in ten seconds. A constraint nobody
          // checks is a suggestion, and the team is told a judge checks this.
          `> **Did they honour it?** ${diversifier.check}  \`yes / no\` — *no* is the pass.`,
        ]
      : []),
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
    "This form is the offline copy. The same five questions are on the game's arcade page, which",
    "is where a score gets recorded and compared against every other entry — `pnpm run arcade`.",
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
