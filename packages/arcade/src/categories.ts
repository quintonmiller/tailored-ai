/**
 * What a game is scored on, what kind of thing it is, and what a builder is
 * aiming at.
 *
 * This file is the single source of truth for all of it. The workshop
 * simulation imports it to write the brief the agents build against and the
 * scorecard left in the artifact directory; the site imports it to build the
 * review form and the sort menu. Two copies of this list would drift within a
 * week, and the failure would be silent in the worst possible way — agents told
 * they were judged on one thing, scored on another.
 *
 * ## The question and the aim are different strings, deliberately
 *
 * This is the most important thing in the file, and it was learned the
 * expensive way. There used to be one field. `jamBrief()` quoted it verbatim,
 * so every judge's question was also a build spec — and an agent builds the
 * minimum artifact that makes the answer "yes".
 *
 * `gameplay` asked: *"Is the core loop actually enjoyable for a minute?"* That
 * is a reasonable thing to ask a person who has just played. Handed to a
 * builder it names a duration, and a duration is what got built: twenty-four
 * consecutive one-screen games with a sixty-second loop. `visuals` asked
 * whether it looked considered *"given that everything is drawn from shapes"* —
 * written as context for the judge, read as a house style, and the shelf is
 * abstract shapes on a dark canvas twenty-four times over.
 *
 * So: `question` is **observational and neutral** — did this happen to me? —
 * and `aim` is **demanding and directional** — make this happen. The invariant,
 * which matters more than any particular wording here:
 *
 *   **An aim must describe one sufficient way to earn a 5, never the only way.**
 *
 * An aim that is the only way is a specification, and a specification produces
 * one game. Say what to achieve; never say by what mechanic.
 *
 * `aim` is rendered only into the agents' brief. `question`, `low` and `high`
 * are rendered only to the judge — on the site and in the scorecard.
 *
 * ## Six scored, two gates
 *
 * The rubric started at six categories, merged to five, and is now six plus two
 * yes/no gates that are reported and never averaged.
 *
 * `polish` and `technical` were merged years ago because they were never
 * independent — every run that scored badly on one scored badly on the other,
 * since the same thing causes both (nobody played it), and a judge asked to
 * separate "feels finished" from "runs clean" writes the same sentence twice.
 * That reasoning still holds and the merged category still exists; it is now
 * the `finished` gate rather than a score, because 24 of 24 entries passed it
 * and a question everybody answers the same way was eating a fifth of the
 * signal.
 *
 * A gate is a near-binary property that costs the judge ten seconds, costs the
 * mean nothing, and is still a rule the agents read. A score is a judgement on
 * a spectrum. Keeping the scored list short matters more for the *builder* than
 * for the judge: five bullets an agent holds, eight it triages — and it will
 * triage toward the ones it already knows how to satisfy, which are exactly the
 * ones already saturated.
 *
 * ## Optional categories were considered and rejected
 *
 * `overallScore` skips categories nobody scored, so "core plus optional" would
 * need no code at all — which is the trap. An optional category gets answered
 * when the answer is obvious and skipped when it is a 3, so it arrives biased
 * to the extremes; and two games scored on different subsets have `overall`
 * values that are not comparable, with nothing recording which subset. Every
 * scored category here is mandatory.
 *
 * ## What is deliberately not scored
 *
 * **Scope.** Size is already counted by the harness for free — `linesWritten`,
 * `bytesInWorkspace`, `filesPresent` — and counted better than a person could.
 * Content volume is also the cheapest thing a model can produce: twelve levels
 * of data is a generation task, twelve *good* levels is a design task, and a
 * scored category cannot tell them apart. What is worth knowing is recorded as
 * a declared claim instead — see {@link CLAIMS}.
 *
 * **Story.** With no images and no audio, story is text, and a lore paragraph
 * plus an epilogue is a thirty-line diff that maxes any honest story category.
 * It also overlaps `theme`, which already asks whether the fiction reaches the
 * mechanics. The fatal objection is the diversifiers: `words` makes text the
 * entire game, while `stillness` and `no-numbers` push against it, so a story
 * category's expected value would be set by a coin flip in `pickDiversifier`
 * rather than by the team. The part worth keeping is that a game should go
 * somewhere, and that lives in `depth`'s top anchor as an *ending* — the one
 * narrative primitive that survives the asset ban and that no entry has yet.
 */

export interface Category {
  key: string;
  name: string;
  /** What the judge is asked, after playing. Observational: did this happen? */
  question: string;
  /**
   * What a builder is told to reach for. Directional, and never a mechanic.
   *
   * Rendered into the brief in place of `question`. See the file header for
   * why these must be different strings.
   */
  aim: string;
  /** What a 1 looks like and what a 5 looks like, so the scale means the same thing twice. */
  low: string;
  high: string;
}

export const CATEGORIES: Category[] = [
  {
    key: "theme",
    name: "Theme",
    question: "Does the theme shape the mechanics you played, or is it decoration?",
    aim:
      "Decide early what your reading of the theme is, write it down, and build the game that reading " +
      "demands. A judge scores what they played, not what your pitch claims — so the test is not whether " +
      "you can explain the connection. If the theme could be swapped for a different one and the game " +
      "would still work, you have not used it.",
    low: "the theme appears in the title and nowhere else",
    high: "remove the theme and the game stops making sense",
  },
  {
    key: "gameplay",
    name: "Play",
    question: "Did you play it more times than you had to?",
    aim:
      "Nothing is scored on how long one run lasts. The question a judge answers is whether they chose " +
      "to start another one — so build the thing that makes somebody press the key again after they have " +
      "already seen everything you were worried they would miss.",
    low: "you understood it and stopped",
    high: "you lost, said one more, and meant it three times",
  },
  {
    key: "depth",
    name: "Depth",
    question: "By the end of your session, was the game doing something it was not doing in the first thirty seconds?",
    aim:
      "One screen and one rule is where every team before you stopped, and a difficulty ramp is not " +
      "development — the same game faster is the same game. Build one with a second half: by a few " +
      "minutes in, a player should be doing something they were not doing at the start, and it should be " +
      "there because you designed it rather than because a number went up. What that is, is yours.",
    low: "minute five is minute one, faster",
    high: "something arrived, changed or ended, and it reframed what you had been doing",
  },
  {
    key: "balance",
    name: "Balance",
    question: "Across your first three runs, did you lose for reasons you understood, and get better?",
    aim:
      "You cannot feel this game; you can only reason about it, which is why games built this way tend to " +
      "be either trivial or lethal. A first run should end in a loss the player can explain to " +
      "themselves, a third run should go better than the first, and nothing should be able to kill " +
      "somebody who is playing well. A difficulty menu is not a curve — EASY / NORMAL / HARD is what a " +
      "team ships when it has tuned nothing.",
    low: "you never lost, or you lost instantly and could not see why",
    high: "every loss was legible and your third run was plainly better than your first",
  },
  {
    key: "originality",
    name: "Originality",
    question:
      "Is there a mechanic here you have not seen before — a mechanic, not a premise — including on the rest of this arcade?",
    aim:
      "The first idea a theme suggests is the idea it suggested to everybody. A strange premise over a " +
      "familiar loop scores a one: `you are the black hole` is a premise, dodging things is the loop, and " +
      "the shelf is full of the first wrapped around the second. Look at what is already there before you " +
      "commit, and if a judge could swap your entry for one already on it, how well it is built does not " +
      "rescue you.",
    low: "a competent clone of something that exists, or of another entry here",
    high: "one mechanic you would steal",
  },
  {
    key: "visuals",
    name: "Look",
    question: "Has somebody decided how this should look, or is it defaults?",
    aim:
      "Everything on screen is generated by your code, so looking good means the choices you made: a " +
      "palette somebody picked, type that lines up, and a screen that answers the player. A still frame " +
      "is half of it — what matters as much is what happens when the player hits something, and whether " +
      "the game is still readable when it is busy. Effects that make a screenshot better and the game " +
      "harder to read lose you this category rather than winning it.",
    low: "default colours, unaligned text, nothing framed, and nothing on screen acknowledges what you did",
    high: "a coherent palette, and you can tell what just happened from how it looked",
  },
];

/**
 * Yes/no questions that are reported and never averaged.
 *
 * `keep` is the ground truth the whole rubric is a proxy for. It is asked
 * *before* the numbers, because scoring rationalises: a judge who has just
 * written five 4s finds a reason to say yes. It is also the least gameable
 * question in the system — there is nothing to optimise toward except the
 * actual goal — and it is what lets the rubric be audited. If `overall` and
 * `keep` disagree across thirty games, the rubric is wrong and you can see it.
 *
 * `finished` is the old `polish` category. `no` is the pass, matching the
 * diversifier gate on the same form.
 */
export interface Gate {
  key: string;
  name: string;
  question: string;
  /** Asked before the scores, or after them. */
  when: "before" | "after";
  /** The answer that passes. */
  pass: "yes" | "no";
}

export const GATES: Gate[] = [
  {
    key: "keep",
    name: "Would you keep it?",
    question: "Would you put this on a shelf and show somebody?",
    when: "before",
    pass: "yes",
  },
  {
    key: "finished",
    name: "Finished",
    question: "Did you hit an error, a dead end, or something you had to be told?",
    when: "after",
    pass: "no",
  },
];

export const GATE_KEYS = GATES.map((g) => g.key);

/**
 * Things a team may claim about its own game, which a judge confirms in the
 * time they are already spending.
 *
 * Global Game Jam's diversifier rules are the model, and both halves matter.
 * **No score**: "there is no virtual or real score granted... you are not a
 * better game jammer just because you have taken it upon yourself to fulfil
 * more." **Self-evident**: a claim has to be "verified by anyone downloading
 * the game", chosen so that cheating is hard and organiser effort is near zero.
 *
 * That is what makes this the right shape for scope. Scope as a scored category
 * rewards volume, which is the cheapest thing a model can make; scope as a
 * claim rewards *reaching a state a person can see*. "Reaches a win state"
 * passes the self-evident test. "We attempted a roguelike deckbuilder" does not,
 * and is not on this list for that reason.
 *
 * Nothing here enters `overall`. It is a filter and a record.
 */
export interface Claim {
  key: string;
  /** Written for the team, in the brief. */
  label: string;
  /** What the judge confirms, in ten seconds, without playing well. */
  check: string;
}

export const CLAIMS: Claim[] = [
  {
    key: "ending",
    label: "The game can be finished — there is a win state, not just a loss state.",
    check: "Did you reach an ending, or see one described?",
  },
  {
    key: "levels",
    label: "There is more than one level, stage or configuration.",
    check: "Did the layout or setup change between runs?",
  },
  {
    key: "modes",
    label: "There is more than one way to play it.",
    check: "Is there a second mode, character or ruleset?",
  },
  {
    key: "progress",
    label: "Something carries across runs — a record, an unlock, a state that persists.",
    check: "Did anything survive a reload?",
  },
  {
    key: "teaches",
    label: "It teaches itself: no instructions needed outside the game.",
    check: "Could you play without reading the page?",
  },
];

export const CLAIM_KEYS = CLAIMS.map((c) => c.key);

/**
 * Which rubric a review was written against.
 *
 * Stamped on every review so that the next time this list changes, `overall`
 * does not silently start mixing two rubrics with nothing anywhere saying so.
 * Bump it whenever a scored category is added, removed or renamed.
 */
export const RUBRIC_VERSION = "v2";

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

export const SCORE_MIN = 1;
export const SCORE_MAX = 5;

/**
 * What kind of thing it is, for the genre filter.
 *
 * A closed list rather than free text, because the filter is the whole point:
 * `platformer`, `Platformer` and `2D platformer` are three facets of one genre
 * and a dropdown built from free text is unusable after ten entries. Agents
 * choosing a genre get this list in the tool description, and anything not on
 * it lands in `other` rather than being refused — a wrong genre is a bad filter
 * row, a refusal is a lost registration.
 */
export const GENRES = [
  "action",
  "arcade",
  "puzzle",
  "platformer",
  "shooter",
  "strategy",
  "simulation",
  "rhythm",
  "toy",
  "other",
] as const;

export type Genre = (typeof GENRES)[number];

export function normaliseGenre(raw: unknown): Genre {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (GENRES as readonly string[]).includes(value) ? (value as Genre) : "other";
}

/**
 * The overall figure: the mean of the category means, not the mean of every
 * score handed in.
 *
 * The difference matters as soon as two people review the same game and one of
 * them skips a category. Averaging every number equally would let a reviewer
 * who filled in only `visuals` pull the overall towards visuals; averaging per
 * category first means each category counts once however many people answered
 * it. Categories nobody scored are left out entirely rather than counted as
 * zero — an unanswered question is not a bad answer.
 *
 * Returns null when there is nothing to average, so a caller can say "not yet
 * reviewed" rather than printing a confident 0.0.
 */
export function overallScore(byCategory: Record<string, { mean: number; count: number } | undefined>): number | null {
  const means = CATEGORY_KEYS.map((key) => byCategory[key]).filter(
    (entry): entry is { mean: number; count: number } => !!entry && entry.count > 0,
  );
  if (means.length === 0) return null;
  return round2(means.reduce((sum, entry) => sum + entry.mean, 0) / means.length);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Clamp a submitted score into range, or reject it as unscored. */
export function cleanScore(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < SCORE_MIN || rounded > SCORE_MAX) return null;
  return rounded;
}
