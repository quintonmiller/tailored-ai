/**
 * How hard a scenario is, and how to ask for a slice of the set by it.
 *
 * The benchmark grew by addition: every scenario written to catch a specific
 * regression sits beside every scenario written to find the model's ceiling,
 * and the overall score averages them. That average moves for the wrong reasons
 * — adding six easy rows raises it, adding six hard ones lowers it — and it
 * cannot answer the question that actually decides what to work on next: *where
 * does this stop working?*
 *
 * A level is a claim about what the turn demands of the model, not about how
 * long the YAML is or how often it currently fails. Grading by observed pass
 * rate would make the scale circular: every fix would relabel the scenario, and
 * "we now pass the hard ones" would be true by construction.
 */

/**
 * The scale. Seven levels, each defined by the kind of work the turn requires,
 * so two people grading the same scenario land in the same place.
 *
 * It ran to five until the top of it stopped being the top. On the 2026-08-12
 * cohort level 5 scored **83%** and level 4 scored **69%** — the hardest tier
 * was easier than the one below it, and seven of the ten level-5 scenarios
 * passed every run. A scale whose last rung is cleared is not measuring a
 * ceiling; it is measuring a floor and calling it a ceiling, and it cannot
 * answer the one question it exists for.
 *
 * The fix is not to relabel the rows that pass — that is the circularity this
 * file was written to avoid. It is that the scale was missing kinds of demand.
 * Levels 6 and 7 name two the first five never described: several independent
 * demands in one turn, and a turn whose loudest signal is wrong.
 */
export const DIFFICULTY_LEVELS: Record<number, { name: string; blurb: string }> = {
  1: {
    name: "reflex",
    blurb: "One step, one plausible answer. Failing it means something is broken, not that the question was hard.",
  },
  2: {
    name: "routine",
    blurb: "A single judgement among near neighbours — which of these tools, whether to speak at all.",
  },
  3: {
    name: "composed",
    blurb: "Two or more constraints have to hold at once, or a fact has to survive a step to be used in the next.",
  },
  4: {
    name: "conflicting",
    blurb: "The signals disagree and one has to win, or the right answer is partly a refusal.",
  },
  5: {
    name: "frontier",
    blurb: "Multi-hop over a long history, or a real dependency between agents: B's turn needs what A found.",
  },
  6: {
    name: "compound",
    blurb:
      "Several independent demands in one turn, each enough to fail it alone — a chain that must end in a refusal, a handoff carrying a fact that was withdrawn.",
  },
  7: {
    name: "misleading",
    blurb:
      "The most authoritative thing present is wrong, and being right means going against it — or saying it cannot be known, while a plausible answer sits in reach.",
  },
  // 8-10 count independent ways to fail one piece of work rather than naming a
  // kind of hardness. Two families reach them by different routes and both keep
  // their names here, because a rung with one exemplar reads as a rule: state
  // loss (a fact is gone, and something plausible is in reach) and orchestration
  // (a machine whose order is not given, and hands that have to be directed).
  8: {
    name: "two-fold",
    blurb:
      "Two demands, either enough to fail it. A fact is gone and a near-miss is in reach; or a machine has to be understood before it can be driven.",
  },
  9: {
    name: "three-fold",
    blurb:
      "Three. Half the turn is reachable and half was lost, and both halves must be reported; or two agents share one machine and must not each do all of it.",
  },
  10: {
    name: "four-fold",
    blurb:
      "Four, and one of them is other people. Declining a colleague with no fact to point at; or directing specialists through a machine you cannot touch yourself.",
  },
};

export const MIN_DIFFICULTY = 1;
/**
 * Ten, and the number is not the point — where the set stops failing is.
 *
 * 8-10 are one ladder rather than three kinds, built on the demand this model
 * measurably cannot meet: a fact evicted from the window comes back invented,
 * with total confidence, every time. `will-not-name-a-number-it-can-no-longer-
 * see` is 0/3 and the two long-standing 0% rows in `long-session` are the same
 * failure. So the top of the scale stacks that one, adding a single independent
 * thing per rung: a near-miss to resist (8), a reachable half to get right
 * anyway (9), and a colleague asking for the impossible half (10).
 *
 * Composing rather than inventing is deliberate. Every level above 5 that named
 * a *new* kind of hardness turned out to guess wrong about what is hard —
 * `misleading` was written as the ceiling and scores 89%. A rung that adds one
 * more independent way to fail a turn the model already fails is harder by
 * construction, and says so without anyone having to predict anything.
 */
export const MAX_DIFFICULTY = 10;

/** `3 composed` — the number is what filters, the name is what a reader uses. */
export function describeDifficulty(level: number): string {
  const entry = DIFFICULTY_LEVELS[level];
  return entry ? `${level} ${entry.name}` : String(level);
}

/**
 * `4`, `4+`, `2-3`, `3,5` — a set of levels, as a predicate.
 *
 * All four forms exist because all four are things you actually want mid-loop:
 * one level while iterating on it, `N+` to run everything at the edge, a range
 * to skip the reflex rows, a list to re-run two specific tiers. Rejecting an
 * unparseable spec loudly matters more here than usual — a filter that silently
 * matched nothing would print "no scenarios matched" and read like an empty set
 * rather than a typo, and one that silently matched *everything* would report a
 * frontier score that quietly included the easy rows.
 */
export function parseDifficultyFilter(spec: string): (level: number) => boolean {
  const wanted = new Set<number>();

  for (const raw of spec.split(",")) {
    const term = raw.trim();
    if (!term) continue;

    const plus = /^(\d+)\+$/.exec(term);
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(term);
    const exact = /^(\d+)$/.exec(term);

    if (plus) {
      for (let n = Number(plus[1]); n <= MAX_DIFFICULTY; n++) wanted.add(n);
    } else if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from > to) throw new Error(`--difficulty range "${term}" runs backwards`);
      for (let n = from; n <= to; n++) wanted.add(n);
    } else if (exact) {
      wanted.add(Number(exact[1]));
    } else {
      throw new Error(`--difficulty "${term}" is not a level, a range, or "N+" (e.g. 4, 4+, 2-3, 3,5)`);
    }
  }

  if (!wanted.size) throw new Error(`--difficulty "${spec}" selected no levels`);

  // A spec naming only levels no scenario can have is a typo, and the empty
  // result it produces is indistinguishable from a set with nothing that hard.
  const reachable = [...wanted].filter((n) => n >= MIN_DIFFICULTY && n <= MAX_DIFFICULTY);
  if (!reachable.length) {
    throw new Error(`--difficulty "${spec}" is outside the ${MIN_DIFFICULTY}-${MAX_DIFFICULTY} scale`);
  }

  return (level: number) => wanted.has(level);
}
