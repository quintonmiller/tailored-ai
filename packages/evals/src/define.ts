/**
 * Writing a scenario in TypeScript.
 *
 * YAML got this package a long way and stops exactly where the interesting
 * scenarios start. Three limits, each of which cost real time before this
 * existed:
 *
 *   **Nothing is checked until you run it.** A misspelled assertion key, a role
 *   that does not exist, a milestone pointing at a fact nobody declared — all
 *   are ordinary text to an editor. The zod schema catches them, but only after
 *   a `pnpm run eval` that may already have spent an hour of GPU time on the
 *   scenarios before it in the file.
 *
 *   **Nothing can be shared.** Six managers with near-identical agent blocks is
 *   six copies, and the day one of them changes, five of them silently do not.
 *
 *   **Nothing can be generated.** The thing a benchmark most wants is the same
 *   scenario over ten seeds, which in YAML is ten hand-maintained copies whose
 *   only difference is a number. That is not a scenario set, it is a
 *   transcription exercise with a defect rate.
 *
 * So scenarios are authored as TypeScript here, and YAML remains one loader that
 * produces the same objects. Nothing downstream changes: `loadScenarios` returns
 * `Scenario[]` either way, and every grader, worker and report already speaks
 * that shape.
 *
 * ## Why a scenario is still data
 *
 * The obvious next step — let a scenario carry a closure, a custom grader, an
 * inline predicate — is deliberately not taken, and the reason is not
 * conservatism. Three things this benchmark depends on are only true of data:
 *
 *   `regrade` re-scores a finished run against today's assertions with no model.
 *   A closure cannot be recovered from a report, so any scenario carrying one
 *   would silently opt out of re-grading — the feature most used when iterating.
 *
 *   `fingerprintScenario` digests what a scenario measures, so a published
 *   number can be told apart from the questions it answered. `JSON.stringify`
 *   drops functions without complaint, so a scenario whose logic lived in a
 *   closure would keep its fingerprint while changing its meaning. That is the
 *   exact failure the fingerprint exists to prevent.
 *
 *   Every scenario runs in its own process, because the room-backend registry is
 *   a module singleton. Closures do not cross that boundary.
 *
 * Logic that genuinely needs to be code has a seam of its own: a `simulation:`
 * is a registered TypeScript module, and `tools:` plus `world:` cover the rest.
 * The scenario says which one to run; the module does the thinking.
 */

import { validateScenario } from "./schema.js";
import type { Scenario } from "./types.js";

/**
 * One scenario, checked twice: by the compiler as you write it, and by the same
 * zod schema the YAML loader uses, at import time.
 *
 * The second check is not redundant. TypeScript cannot express "exactly one
 * assertion per `expect` entry", "every wake agent is declared", or "a world
 * goal is reachable from some rule" — and those are the rules whose violation
 * produces a scenario that passes while measuring nothing.
 */
export function defineScenario(spec: Scenario): Scenario {
  return validateScenario(spec, spec.id);
}

/** Several at once, so a file can export a family without repeating the call. */
export function defineScenarios(...specs: Scenario[]): Scenario[] {
  return specs.map((spec) => defineScenario(spec));
}

/**
 * The same scenario over several seeds, which is the shape a benchmark wants and
 * the shape YAML cannot express.
 *
 * One run of a stochastic simulation ranks nothing — a machine that was going to
 * fail either did or did not, and that is worth more than most of the decisions
 * in the run. The baseline sweeps already know this and average over sixty
 * seeds. An agent run cannot afford sixty, but it can afford five, and five
 * scenarios differing only in a seed is exactly the sort of thing that should be
 * written once.
 *
 * The id gets the seed appended, so every row in the report is still its own
 * scenario and a single bad seed is visible rather than averaged away.
 */
export function seedVariants(base: Scenario, seeds: readonly number[]): Scenario[] {
  if (!base.simulation) throw new Error(`seedVariants needs a scenario with a \`simulation:\` — "${base.id}" has none`);
  return seeds.map((seed) =>
    defineScenario({
      ...base,
      id: `${base.id}-seed${seed}`,
      simulation: { ...base.simulation, seed } as NonNullable<Scenario["simulation"]>,
    }),
  );
}
