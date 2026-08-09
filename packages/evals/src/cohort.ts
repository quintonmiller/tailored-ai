/**
 * Whether a published result still describes the scenario it is published
 * beside.
 *
 * The site reads each scenario's intent and `knownGap` from *today's* files and
 * pairs them with the committed report — deliberately, so closing a gap updates
 * every page without re-running anything. The cost is that a scenario which
 * keeps its id and changes what it sends or grades renders an old number under
 * a new description, and nothing notices: coverage matches, because the id
 * never moved, and coverage is what the page checks.
 *
 * It has already happened. `notices-a-truncated-tool-result` was changed to run
 * `tools: [read]` once its 0% turned out to be the harness measuring its own
 * stub, and the published 0% stayed on a public page underneath the corrected
 * intent. The digest had moved; `scripts/guard-benchmark-cohort.mjs` read it
 * into a variable and never compared it.
 */

import type { BenchmarkReport } from "./types.js";

export interface CohortStaleness {
  /** Scenarios the report scored whose definition has since changed. */
  changed: string[];
  /**
   * Set when the report predates per-scenario digests and its set hash has
   * moved. All such a report can tell us is *that* something changed.
   */
  setHashMoved?: { recorded: string; current: string };
}

/**
 * What is stale about one published report, given the current scenario set.
 *
 * A scenario the report scored that **no longer exists** is deliberately not
 * flagged: the question was withdrawn, and the page renders it as absent rather
 * than as a score under the wrong heading. Stale means "same id, different
 * question", which is the case a reader cannot detect.
 */
export function cohortStaleness(
  report: Pick<BenchmarkReport, "meta">,
  current: { hash: string; fingerprints: Record<string, string> },
): CohortStaleness {
  const recorded = report.meta.scenarioFingerprints;

  if (!recorded) {
    return report.meta.scenarioSetHash === current.hash
      ? { changed: [] }
      : { changed: [], setHashMoved: { recorded: report.meta.scenarioSetHash, current: current.hash } };
  }

  const changed = Object.entries(recorded)
    .filter(([id, fingerprint]) => id in current.fingerprints && current.fingerprints[id] !== fingerprint)
    .map(([id]) => id)
    .sort();

  return { changed };
}

/** True when there is nothing to report — the shape callers branch on. */
export function isFresh(staleness: CohortStaleness): boolean {
  return staleness.changed.length === 0 && !staleness.setHashMoved;
}

/**
 * Both remedies are honest, and the choice is a real one: re-running says "this
 * is what the current questions score", archiving says "we are not publishing a
 * number for these questions right now". Publishing the stale one says neither.
 */
export const COHORT_REMEDY =
  "Either re-run the cohort on this commit, or move it to results/history/ " +
  "(archived cohorts are deliberately exempt — they record what was true then).";

export function describeStaleness(file: string, staleness: CohortStaleness): string {
  if (staleness.setHashMoved) {
    const { recorded, current } = staleness.setHashMoved;
    return (
      `${file} records set ${recorded}, the scenarios are now ${current}. ` +
      "It predates per-scenario digests, so which scenario moved cannot be recovered from it."
    );
  }
  return (
    `${file} reports results for ${staleness.changed.length} scenario(s) whose definition has changed since: ` +
    staleness.changed.join(", ")
  );
}
