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

import type { MediaStore, Tool } from "@tailored-ai/core";

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
   * False where an unattended tick is a fiction rather than a formality.
   * Nothing happens in a workshop nobody is typing in, so running on would
   * advance the clock past the roster and the round count in the report would
   * stop meaning turns taken.
   *
   * A baseline sweep plays every round, so there is nothing to make comparable
   * — the agents' horizon *is* the run.
   */
  runsOnUnattended?: boolean;

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
   * It exists for anything the scenario could not know when it was written: a
   * role drawn at construction, or a brief selected with `--sim-option`. The
   * workshop's whole genericity rests on it — the task is a value rather than a
   * scenario, so the scenario cannot state it and something has to.
   *
   * Called once, when the config is built. Returning nothing is the normal case
   * and means the role is fully described by the scenario.
   */
  briefFor?(role: string): string | undefined;
  /**
   * The roster has run out. Nothing else is going to happen.
   *
   * The harness ticks the clock *between* rounds, so an N-round run produces
   * N-1 boundaries and a simulation whose only ending is its horizon never
   * reaches it — `done` stays false, `endedBecause` stays undefined, and the
   * trace records a run that stopped for no stated reason. Measured on
   * 2026-08-20: a three-round workshop that announced rounds 0, 1 and 2 and
   * took all 33 of its turns reported two rounds played and an `end` event with
   * no reason on it.
   *
   * A simulation cannot work this out for itself — it is never told how long
   * the roster is — and `runsOnUnattended` is a different question: that one
   * asks whether to *keep playing* without the agents, and answering "no" is
   * not the same as never being told the game is over.
   *
   * Called once, before the closing snapshot, so whatever it decides is in the
   * state the trace and the report both read.
   */
  finish?(): void;
  /**
   * Somewhere to put bytes a tool wants to hand the model.
   *
   * Called once, after the runtime exists and before any turn runs, with the
   * *runtime's own* store — not a second one pointed at the same directory.
   * That matters: the loop hydrates a `MediaRef` by asking its store for the
   * id, so a simulation holding a different instance would produce refs the
   * loop resolves to nothing and silently renders as a text placeholder.
   *
   * Optional because most simulations have no bytes to hand anybody, and
   * undefined is a normal answer even for one that does — `bench` and
   * `rehearse` build simulations with no runtime at all, so a tool that wants
   * an image has to work without one.
   */
  attachMedia?(store: MediaStore | undefined): void;
  /**
   * Something was said in one of the rooms.
   *
   * **For recording, never for deciding.** Same rule as {@link RunContext}: a
   * world whose behaviour changes with what the agents say to each other is no
   * longer a world they are acting on, it is one that reads their minds — and
   * every measurement taken from it would be about the transcript rather than
   * about the work. Nothing in the harness enforces this; it is a rule because
   * the alternative is untestable.
   *
   * It exists because the transcript is the only place "what is this team
   * actually doing right now" is written down, and the simulation is the only
   * thing that knows where to put it. Called for every post as it lands, after
   * the message is in the room, with the day marker already filtered out.
   */
  observePost?(post: { agent?: string; room: string; body: string; to: string[] }): void;

  /**
   * Enough state to continue this run in a new process.
   *
   * A jam is three hours of one GPU, which makes "stop it and pick it up
   * tomorrow" a real requirement rather than a nicety — and until now the only
   * way to free the card was to throw the run away.
   *
   * Taken at round boundaries, never mid-round. `advance()` already runs there,
   * the workspace snapshot is taken there and the arcade heartbeat fires there,
   * so it is the one moment where the world is not half-changed. The cost is
   * losing at most one partial round, which is a much better trade than the
   * bookkeeping mid-turn resume would need.
   *
   * Must be JSON-serialisable, and must not include anything already durable on
   * disk — the workspace, the arcade row and the trace all outlive the process
   * and re-reading them is more honest than carrying a copy that can disagree.
   */
  /**
   * The room subscriptions, so a simulation can let an agent change its own.
   *
   * Handed over the same way the media store is, and for the same reason: the
   * capability belongs to the runtime, the decision about who may use it
   * belongs to the scenario.
   *
   * The motivating measurement: across one jam a quarter of all turns were the
   * watcher correctly declining to run an agent that had nothing to do, and the
   * tester was woken and skipped on 43% of its turns. Being woken constantly is
   * the cost; being absent is not. An agent that can say "only when you need me"
   * removes the cost instead of being told to look busy.
   */
  attachRooms?(
    store: {
      subscribe(input: {
        agent: string;
        roomRef: string;
        deliver?: string;
        wakeOn?: string;
        checkInMinutes?: number | null;
        role?: string | null;
      }): unknown;
    },
    /** Room name to ref, because a subscription is addressed by ref. */
    rooms: ReadonlyMap<string, string>,
  ): void;

  checkpoint?(): unknown;

  /**
   * Take back the state from {@link Simulation.checkpoint}.
   *
   * Called once, after construction and before any turn. A simulation that
   * cannot restore some part of itself should leave that part at its
   * constructed default rather than throw: a resumed run that is slightly wrong
   * about a counter is worth more than a run that will not start.
   */
  restore?(state: unknown): void;
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

/**
 * What is running this simulation, for a simulation that has a reason to care.
 *
 * Almost none of them do, and that is the default assumption: a world whose
 * behaviour changes with the model is not measuring the model. Nothing here may
 * reach a prompt or a rule.
 *
 * It exists for provenance. The workshop publishes its artifact to a site that
 * accumulates over months, and a board of a hundred games where nothing records
 * *which model built which* cannot answer the question it exists to answer.
 * That is a label on the output, not an input to the game.
 *
 * Absent under `bench` and `rehearse`, which run no model at all, so every
 * field has to be optional at the point of use.
 */
export interface RunContext {
  scenario: string;
  model: string;
  provider: string;
  baseUrl: string;
  gitSha?: string;
  taiVersion?: string;
  /** Sampling and budget settings: temperature, maxTokens, thinking, context window. */
  modelMeta?: Record<string, unknown>;
  /** role → agent name, from the scenario. */
  roles?: Record<string, string>;
}

export interface SimulationOptions {
  seed: number;
  /** Simulated days. Short for an agent run, long for a baseline sweep. */
  days?: number;
  /** What is running this. See {@link RunContext} — provenance only, never a rule. */
  run?: RunContext;
  /** Simulation-specific knobs, passed through from the scenario. */
  [key: string]: unknown;
}

export type SimulationFactory = (options: SimulationOptions) => Simulation;

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
  { create: SimulationFactory; policies: Record<string, () => Policy>; report: SimulationReport }
>();

export function registerSimulation(
  name: string,
  create: SimulationFactory,
  policies: Record<string, () => Policy> = {},
  report: SimulationReport = DEFAULT_REPORT,
): void {
  registry.set(name, { create, policies, report });
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
