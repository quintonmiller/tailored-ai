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
};

export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 7;

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
