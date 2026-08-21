/**
 * What a game is scored on, and what kind of thing it is.
 *
 * This file is the single source of truth for both. The workshop simulation
 * imports `CATEGORIES` to write the brief the agents are judged against and the
 * scorecard left in the artifact directory; the site imports it to build the
 * review form and the sort menu. Two copies of this list would drift within a
 * week, and the failure would be silent in the worst possible way — agents told
 * they were judged on one thing, scored on another.
 *
 * ## Five, down from six
 *
 * The jam started with six: theme, fun, visual craft, innovation, polish and
 * technical soundness. `polish` and `technical` were never independent in
 * practice — every run that scored badly on one scored badly on the other,
 * because the same thing causes both (nobody played it), and a judge asked to
 * separate "feels finished" from "runs clean" ends up writing the same sentence
 * twice. They are one category now.
 *
 * Five is also as many as a person will actually fill in. A scorecard nobody
 * completes is worth less than a shorter one they do.
 */

export interface Category {
  key: string;
  name: string;
  /** What the judge is being asked. */
  question: string;
  /** What a 1 looks like and what a 5 looks like, so the scale means the same thing twice. */
  low: string;
  high: string;
}

export const CATEGORIES: Category[] = [
  {
    key: "theme",
    name: "Theme relevance",
    question: "Does the theme shape the mechanics, or is it decoration?",
    low: "the theme appears in the title and nowhere else",
    high: "remove the theme and the game stops making sense",
  },
  {
    key: "gameplay",
    name: "Gameplay",
    question: "Is the core loop actually enjoyable for a minute?",
    low: "you understand it and have no reason to continue",
    high: "you lose and immediately press the key again",
  },
  {
    key: "visuals",
    name: "Visuals",
    question: "Does it look considered, given that everything is drawn from shapes?",
    low: "default colours, unaligned text, nothing framed",
    high: "a coherent palette and a screen you would screenshot",
  },
  {
    key: "originality",
    name: "Originality",
    question: "Is there an idea here you have not seen before?",
    low: "a competent clone of something that exists",
    high: "one mechanic you would steal",
  },
  {
    key: "polish",
    name: "Polish",
    question: "Does it feel finished and run clean — every state resolves, no console errors, no dead ends?",
    low: "it starts mid-game, breaks on two keys at once, or has a state you cannot leave",
    high: "every state resolves, nothing needs explaining, and it survives abuse",
  },
];

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
