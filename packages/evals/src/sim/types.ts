/**
 * What a simulation benchmark is, and why it is code rather than YAML.
 *
 * Every scenario in this package so far asks a yes/no question: did the agent
 * pick the right tool, reach the right state, get the right answer. That is the
 * right question while the answer is sometimes no, and it stops being useful the
 * moment it is reliably yes — which, on the orchestration rows, it now is. A
 * benchmark whose ceiling has been reached measures nothing but its own
 * ceiling.
 *
 * A simulation replaces the question with an *objective*. There is no
 * predetermined solution and no final riddle: at the end of the run the
 * simulated bank account, customers, machines and orders say how well the
 * organisation performed, and the evaluator never has to judge whether a chain
 * of reasoning was sound. Better and worse become continuous, so the benchmark
 * keeps discriminating long after "can it do this at all" has been answered.
 *
 * ## Why not the `world:` seam
 *
 * `world:` is a state machine over strings, driven declaratively from YAML. An
 * economy needs arithmetic, a clock, stochastic draws and interacting
 * subsystems. Expressing that declaratively means inventing a programming
 * language inside YAML, badly. So a simulation is a TypeScript module in a
 * registry, and the YAML says only which one to run and with what seed.
 *
 * ## What a simulation owes the harness
 *
 * Tools, a clock, and numbers. Nothing else — it does not know about rooms,
 * agents, prompts or grading, and the harness does not know about factories.
 * The seam is deliberately narrow so a second simulation costs one file.
 */

import type { Tool } from "@tailored-ai/core";

/** Numbers a run produced. Free-form, because each simulation has its own economics. */
export type SimMetrics = Record<string, number>;

/**
 * One thing that happened in the world without anyone asking for it.
 *
 * Recorded separately from the agents' own actions because the interesting
 * question about a disruption is not that it happened — the seed decided that —
 * but how long the organisation took to respond to it. See `latency.ts`.
 */
export interface SimEvent {
  day: number;
  kind: string;
  /** What an agent would see if it looked. Plain prose: this reaches a prompt. */
  message: string;
  /** Which agents can observe it directly. Empty means anyone who looks. */
  visibleTo?: string[];
}

export interface Simulation {
  /**
   * Whether running the world on to its horizon with nobody acting means
   * anything.
   *
   * True by default, because for the factory it does: a company that is
   * abandoned keeps paying wages, and scoring an eight-round agent run against
   * a baseline swept over sixty days requires the same sixty days on both
   * sides. Truncating instead would flatter every team that stopped early.
   *
   * False for the descent, where it is not a formality but a fiction. An
   * unattended party standing in a room with monsters in it is simply eaten,
   * so every tick past the agents' last round manufactures damage nobody chose
   * to take. Measured twice on 2026-08-19: once when `--rounds` raised the
   * horizon and left the roster behind (16 unattended ticks, a healthy party on
   * tick 39 and five corpses on tick 55), and again with the roster correct,
   * where two ticks of overrun turned four survivors and an executed traitor
   * into "the party was wiped out on floor 3". The state said four alive; the
   * end reason said a wipe; both were reading the same field at different
   * times.
   *
   * A baseline sweep plays every round, so there is nothing to make comparable
   * — the agents' horizon *is* the run.
   */
  runsOnUnattended?: boolean;

  /**
   * Move the run's own end, after the world has been built.
   *
   * Only for resuming. `days` cannot simply be overridden on the replay path,
   * because in `descent` the horizon is an *input to difficulty* —
   * `vigilScale(tick, horizon)` scales enemy power by the fraction of the
   * horizon spent, deliberately, so that whatever the round limit is the
   * dungeon is 4.8x by the end of it. Rebuilding a played world at a different
   * horizon therefore regenerates its encounters at a different strength, the
   * replay stops matching what was recorded, and the drift guard throws — which
   * is correct, because that world is not the one that was played.
   *
   * So a resumed run replays at the recorded horizon and moves it afterwards.
   * The consequence is worth stating wherever such a run is reported: the
   * rounds before the seam were played under the old pressure curve and the
   * ones after are played under the new one, so it is a hybrid and is not
   * comparable with a clean run at either length.
   *
   * Optional, and simulations that have no notion of a movable horizon simply
   * do not implement it; the harness refuses the request rather than pretending
   * it worked.
   */
  setHorizon?(days: number): void;

  readonly name: string;
  /** Days elapsed, from 0. */
  readonly day: number;
  /** True once the run is over — the horizon was reached, or the company died. */
  readonly done: boolean;
  /** Why it ended, once it has. */
  readonly endedBecause?: string;
  /**
   * The instruments, keyed by the agent allowed to hold them.
   *
   * Per-agent rather than a flat list, because *nobody gets complete
   * information or complete control* is the whole point: the sales manager can
   * see demand history and set a price, and cannot look at machine condition.
   * A team that shares one omniscient toolbox is one agent with six prompts.
   */
  tools(): Record<string, Tool[]>;
  /** Tools every agent holds — reading the clock, closing the day. */
  sharedTools(): Tool[];
  /** Advance one day. Returns what the world did overnight. */
  advance(): SimEvent[];
  /**
   * One line, posted in every room at the top of each round.
   *
   * Load-bearing rather than decoration. `pollOnce` runs no turn when a room
   * has nothing new in it, so on a round where nobody happened to post, every
   * agent would sleep while the harness advanced the clock to the horizon
   * without them — and the report would show a team that chose to say nothing,
   * which is precisely the thing this benchmark is supposed to distinguish from
   * a team that was never woken.
   *
   * It belongs to the simulation because it is the simulation's world being
   * described. The harness used to write this sentence itself, which meant the
   * runner knew a factory had customers and books; every simulation after the
   * first would have inherited that or forced the runner to grow a branch per
   * world.
   *
   * Say only what the whole team may know. Anything the simulation deliberately
   * gave to one role is a leak if it goes here.
   */
  announce?(): string | undefined;
  /** Everything that has happened, in order. */
  readonly events: SimEvent[];
  /**
   * What acting on an event looks like: event kind → the tools whose use counts
   * as a response. Feeds the organisational-latency metric in `latency.ts`.
   *
   * Declared by the simulation rather than inferred, because the alternative is
   * to treat any later tool call as a response — which reports a latency of zero
   * for everything and reads as a perfect score. An event with no entry here is
   * simply not traced.
   *
   * The entries worth writing are the ones a *different* function answers than
   * the one that can see the event. Those are what make the number about the
   * organisation instead of about an individual.
   */
  readonly responses?: Record<string, string[]>;
  /**
   * Extra standing instructions for one role, decided by the simulation.
   *
   * The only durable channel a simulation has to an agent. Everything else it
   * says arrives as a tool result — which the model reads as *what happened*,
   * not as *what it wants* — and that asymmetry is not a matter of wording.
   *
   * Measured on `the-descent-betrayed`, seed 610357. The traitor's objective was
   * delivered thirteen times, correctly scoped to one agent, as the first line
   * of its own tool output. Across nineteen rounds its private reasoning
   * referenced the role zero times and it played a textbook loyal cleric, while
   * roughly fifteen hundred words of "the party does not last long without you"
   * sat in its system prompt. One line of transient data against a persistent
   * instruction is not a fair fight, and repeating the line does not make it
   * one — a run with the reminder scored the same as one without.
   *
   * So a simulation that assigns a role at construction can put it where the
   * scenario's own instructions live. Called once, when the config is built.
   * Returning nothing is the normal case and means the role is fully described
   * by the scenario.
   */
  briefFor?(role: string): string | undefined;
  /** The numbers the benchmark reports. Called once, at the end. */
  metrics(): SimMetrics;
  /** The headline figure, so a report can rank runs without knowing the domain. */
  objective(): number;
  /** Enough state for a baseline policy to decide, and for a report to explain. */
  snapshot(): Record<string, unknown>;
}

/**
 * A policy that plays without a model.
 *
 * The most valuable part of this whole design, and the cheapest. A score of
 * $1.31M means nothing on its own; next to a random policy at $402K, a static
 * one at $711K and a greedy optimiser at $1.08M it means something specific.
 * Baselines also catch the failure that would otherwise waste a week: a
 * simulation with no gradient, where every policy scores the same and the
 * benchmark is measuring noise. They run in milliseconds, so that check is
 * free and should happen before a single model call.
 */
export interface Policy {
  readonly name: string;
  /** Called once per day, before the day advances. Mutates the world through its own tools. */
  act(sim: Simulation): void;
}

export interface SimulationOptions {
  seed: number;
  /** Simulated days. Short for an agent run, long for a baseline sweep. */
  days?: number;
  /** Simulation-specific knobs, passed through from the scenario. */
  [key: string]: unknown;
}

export type SimulationFactory = (options: SimulationOptions) => Simulation;

/**
 * The options a simulation is *meant* to be played at — the configuration its
 * scenario runs, declared once by the simulation itself.
 *
 * This exists because a simulation's constructor defaults and the configuration
 * anybody is actually measured against are two different things, and nothing
 * connected them. `descent` construct-defaults to a shallow start with no maze;
 * its scenario plays floor one with a maze and a preparation phase. Swept at the
 * construct-defaults the ladder reads oracle 1,455 against rule-based 1,450 — a
 * five-point gap that says the information advantage is worthless. Swept at the
 * scenario's own options the same code reads 714 against 666. Both are true
 * statements about *a* game; only the second is about the game being played.
 *
 * So `bench` and `rehearse` start from this and let explicit flags override,
 * which makes the numbers in the docs reproducible from a bare command instead
 * of from a five-flag incantation nobody remembers.
 */
export type SimulationDefaults = Record<string, unknown>;

/**
 * How a simulation wants its baseline ladder printed.
 *
 * Declared by the simulation rather than known by the reporter, for the same
 * reason the round announcement moved out of the harness: `eval bench` used to
 * render every ladder in dollars with a bankruptcy column, which is the
 * factory's vocabulary and nobody else's. A dungeon ranked by experience came
 * out as `$0` in every row.
 *
 * Absent means "rank by `objective()`, print it as a number" — which is always
 * correct, because every simulation has an objective by contract.
 */
export interface SimulationReport {
  /** The metric that ranks a run. Defaults to `objective`. */
  key: string;
  /** How to render one value of that metric. */
  format?: (value: number) => string;
  /** Extra columns. `mean` averages the metric; `rate` reports how often it was non-zero. */
  columns?: Array<{ label: string; key: string; kind: "mean" | "rate" }>;
}

export const DEFAULT_REPORT: SimulationReport = { key: "objective" };

const registry = new Map<
  string,
  {
    create: SimulationFactory;
    policies: Record<string, () => Policy>;
    report: SimulationReport;
    defaults: SimulationDefaults;
    knobs: string[];
  }
>();

/**
 * Options every simulation accepts, whatever else it declares.
 *
 * The runner sets these, not the experimenter, so they are never a typo worth
 * reporting.
 */
export const UNIVERSAL_KNOBS = ["seed", "days"] as const;

export function registerSimulation(
  name: string,
  create: SimulationFactory,
  policies: Record<string, () => Policy> = {},
  report: SimulationReport = DEFAULT_REPORT,
  defaults: SimulationDefaults = {},
  knobs: string[] = [],
): void {
  registry.set(name, { create, policies, report, defaults, knobs });
}

/**
 * Every option key this simulation reads.
 *
 * Declared, and checked against the source by `sim-knobs.test.ts`, because the
 * options bag is opaque by design: `createSimulation` takes a
 * `Record<string, unknown>` and a key it does not recognise is simply never
 * read. On 2026-08-18 a betrayal run was launched with
 * `--sim-option brief-style=none`, which the simulation reads as `briefStyle`.
 * The unknown key was stored verbatim in the trace, the arm silently fell back
 * to its default, and 26 minutes of GPU measured a different experiment than
 * the one that was asked for — with the trace recording the typo as though it
 * were the setting.
 *
 * `defaults` counts as declared: a knob with a played value is a knob.
 */
export function simulationKnobs(name: string): string[] {
  const entry = registry.get(name);
  if (!entry) return [];
  return [...new Set([...UNIVERSAL_KNOBS, ...Object.keys(entry.defaults), ...entry.knobs])];
}

/**
 * Which of these option keys the simulation will never read, and what the
 * closest thing it does read is.
 *
 * Case- and separator-insensitive, because `brief-style`, `brief_style` and
 * `briefstyle` are all the same mistake and all of them should name the fix
 * rather than just the failure.
 */
export function unknownSimOptions(name: string, keys: string[]): Array<{ key: string; suggestion?: string }> {
  const known = simulationKnobs(name);
  if (known.length === 0) return [];
  const canon = (k: string) => k.toLowerCase().replace(/[-_\s]/g, "");
  const byCanon = new Map(known.map((k) => [canon(k), k]));
  return keys
    .filter((k) => !known.includes(k))
    .map((key) => {
      const hit = byCanon.get(canon(key));
      return hit ? { key, suggestion: hit } : { key };
    });
}

/**
 * The configuration this simulation's scenario plays it at. Empty means the
 * construct-defaults are the played configuration, which is true of any
 * simulation that has only one shape.
 */
export function simulationDefaults(name: string): SimulationDefaults {
  return registry.get(name)?.defaults ?? {};
}

export function simulationReport(name: string): SimulationReport {
  return registry.get(name)?.report ?? DEFAULT_REPORT;
}

export function createSimulation(name: string, options: SimulationOptions): Simulation {
  const entry = registry.get(name);
  if (!entry) throw new Error(`unknown simulation "${name}". Known: ${[...registry.keys()].join(", ") || "(none)"}`);
  return entry.create(options);
}

export function simulationPolicies(name: string): Record<string, () => Policy> {
  return registry.get(name)?.policies ?? {};
}

export function listSimulations(): string[] {
  return [...registry.keys()];
}
