/**
 * One turn, one question, thirty seconds.
 *
 * Almost every question this workstream has asked of a live model has the same
 * shape: *will a character reach for this tool when the situation calls for
 * it?* `poison`, `size_up`, `bind`, `accuse`, `retreat`, `turn` — each one was
 * answered by playing a forty-round run and reading the trace afterwards, at
 * roughly four hours and one sample per answer. Three of those answers turned
 * out to be about harness bugs rather than about models, which is four hours
 * spent measuring the wrong thing.
 *
 * A probe is the same question without the run. It builds a world by replaying
 * a baseline into the exact state that makes the tool correct, hands one
 * character one turn, and records what it called. Thirty seconds and n samples
 * instead of four hours and one.
 *
 * ## What it can and cannot tell you
 *
 * It answers *reachability and salience*: is the tool findable, does its
 * description make sense, does a model in this position think of it. That is
 * exactly the class of defect that has actually bitten — an unpriced action
 * economy, a shadowed tool name, a brief that talked a traitor out of acting.
 *
 * It cannot answer anything about *play*: whether using the tool was wise,
 * whether the party would have coordinated, whether a lie would have worked.
 * Those need a run, and a probe is what stops you spending one on a question a
 * single turn could have answered.
 */

import { createSimulation, simulationDefaults, simulationPolicies } from "./sim/index.js";
import type { Simulation } from "./sim/types.js";

export interface ProbeSetup {
  /** Shown in the report. */
  name: string;
  /** The question, in one line, so a result is readable without the code. */
  asks: string;
  simulation?: string;
  simOptions?: Record<string, unknown>;
  /** Baseline played to reach an interesting world before the character is asked. */
  policy?: string;
  /** How many rounds of baseline play before the probe. */
  warmup?: number;
  /** Bend the world into the exact situation the question is about. */
  arrange?: (sim: Simulation) => string;
  /** Whose turn it is. */
  agent: string;
  /**
   * Whose turn it is, when that depends on the world.
   *
   * Added after the first run of these probes reported "1/6 traitors used the
   * vial" while asking the *rogue* — who is the traitor only when the roll says
   * so. A probe that measures the wrong character is worse than no probe: it is
   * fast, confident and wrong, which is the exact failure this harness exists
   * to stop happening at four-hour granularity.
   */
  agentFor?: (sim: Simulation) => string;
  /** What counts as the model having found the thing. */
  wants: string[];
}

export interface ProbeResult {
  name: string;
  asks: string;
  seed: number;
  called: string[];
  found: boolean;
  said: string;
  arranged: string;
}

/** Build the world a probe asks its question in. Deterministic, no model. */
export function stage(setup: ProbeSetup, seed: number): { sim: Simulation; arranged: string; agent: string } {
  const which = setup.simulation ?? "descent";
  const sim = createSimulation(which, {
    seed,
    days: 40,
    ...simulationDefaults(which),
    ...(setup.simOptions ?? {}),
  });
  const policy = simulationPolicies(which)[setup.policy ?? "rule-based"]?.();
  for (let i = 0; i < (setup.warmup ?? 0) && !sim.done && policy; i++) {
    policy.act(sim);
    sim.advance();
  }
  const arranged = setup.arrange?.(sim) ?? "";
  return { sim, arranged, agent: setup.agentFor?.(sim) ?? setup.agent };
}

/**
 * The prompt a probe puts in front of the model.
 *
 * Deliberately the character's own private view and nothing else — no
 * instruction to use the tool, no hint that a tool is the answer. A probe that
 * says "consider poisoning somebody" measures whether the model can follow an
 * instruction, which was never in doubt. The question is whether the situation
 * alone is enough.
 */
export function probePrompt(sim: Simulation, agent: string): string {
  const view = (sim as unknown as { describeFor?(who: string): string }).describeFor?.(agent) ?? "";
  return `${view}\n\nIt is your turn. Do whatever you think is right.`;
}
