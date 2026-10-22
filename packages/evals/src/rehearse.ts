/**
 * A trace from a bot, so the viewer can be developed without model time.
 *
 * A real run of this scenario is two hundred agent turns and about fifty
 * minutes. Iterating on a broadcast against that is not iteration; it is one
 * attempt an hour. A baseline policy plays the same simulation through the same
 * public API and writes the same trace format in under a second, which is the
 * difference between a viewer that gets ten passes and one that gets one.
 *
 * Written to `results/rehearsals/` rather than `results/traces/` on purpose:
 * `readHistory` scans the traces directory, and a bot's score sitting in the
 * scoreboard as a record would be a lie about what any agent has ever done.
 * Point `eval watch --trace` at one of these to develop against it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreMilestones } from "./graders.js";
import { loadScenarios } from "./schema.js";
import type { DescentSimulation } from "./sim/descent/index.js";
import { createSimulation, simulationPolicies } from "./sim/index.js";
import { fileSink } from "./trace.js";
import type { RunOutcome, Scenario } from "./types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface RehearsalOptions {
  out: string;
  policy?: string;
  /**
   * Anything else the simulation accepts, applied last.
   *
   * Missing until 2026-08-18, and missing silently: `descent.sh --rehearse
   * investigator --sim-option reveal=social` played thirty rounds, wrote a
   * trace, printed a score and reported the social layer switched off, because
   * the flag was parsed by the shell script, forwarded to a command that had no
   * such option, and dropped. The same shape of fault ate `brief-style=none`
   * earlier the same day. An option a caller can pass and nothing reads is
   * worse than one that does not exist — it produces a measurement of the arm
   * you did not run.
   */
  simOptions?: Record<string, unknown>;
  seed?: number;
  rounds?: number;
  startFloor?: number;
  /**
   * Whether the rehearsal plays the maze the scenario actually uses.
   *
   * Off by default, which preserves every existing rehearsal fixture, but the
   * broadcast is developed against these traces and half of what it draws — the
   * floor graph, room movement, environments, locks, gates — does not exist on
   * a corridor floor. A viewer verified only against the default was verified
   * against a game nobody plays.
   */
  maze?: boolean;
  preparation?: boolean;
  /**
   * Which registered dungeon to play.
   *
   * `descent-betrayed` is the same class with the hidden-traitor layer on, and
   * a rehearsal is the only way to see the panels it adds without spending a
   * model-hour. Hardcoding "descent" here meant the broadcast's newest panel
   * could only be verified against a live run, which is the exact cost this
   * command exists to avoid.
   */
  simulation?: string;
  /** Turned on by the `descent-betrayed` factory; overridable for the control arm. */
  traitors?: number | "roll";
  /** Whether the trace carries who the traitors are. Off for a run somebody should watch blind. */
  revealTraitors?: boolean;
}

export async function rehearse(options: RehearsalOptions): Promise<{ turns: number; floor: number; earned: number }> {
  const out = options.out;
  /*
   * Start the file empty.
   *
   * `fileSink` appends, which is right for a run — every run writes once to its
   * own timestamped path. A rehearsal writes to a *fixed* path named after its
   * policy and is meant to replace what was there, so three refreshes of
   * `descent-rule-based.ndjson` left three whole runs concatenated in one file.
   * Anything reading it then saw the oldest run's header and a mixture of every
   * run's states, which is worse than either.
   */
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");
  const write = fileSink(out);
  const rounds = options.rounds ?? 40;
  // The concrete class, because a rehearsal drives the policy against the same
  // public API an agent's tools wrap — a bot that reached past it would produce a
  // trace of a game the agents are not playing.
  const which = options.simulation ?? "descent";
  const sim = createSimulation(which, {
    seed: options.seed ?? 1000,
    days: rounds,
    startFloor: options.startFloor ?? 31,
    ...(options.maze ? { maze: true } : {}),
    ...(options.preparation ? { preparation: true } : {}),
    ...(options.traitors === undefined ? {} : { traitors: options.traitors }),
    ...(options.revealTraitors === undefined ? {} : { revealTraitors: options.revealTraitors }),
    ...(options.simOptions ?? {}),
  }) as DescentSimulation;
  const policies = simulationPolicies(which);
  const wanted = options.policy ?? (which === "descent-betrayed" ? "loyal-party" : "rule-based");
  const make = policies[wanted];
  if (!make) throw new Error(`${which} has no policy "${wanted}". Known: ${Object.keys(policies).join(", ")}`);
  const policy = make();

  /**
   * The milestone ladder, scored by the graders the real run uses.
   *
   * A fixture whose ladder is permanently empty is worse than no fixture: it
   * teaches whoever is building the viewer that the panel does not work. The
   * partial outcome below is the same shape the worker's live scorer builds — a
   * simulation and its metrics, and nothing else, which is all a `sim_metric`
   * milestone reads.
   */
  const partial = (s: DescentSimulation, turns: number) => ({
    reply: "",
    posts: [],
    calls: [],
    executions: [],
    requests: [],
    turns: Array.from({ length: turns }, () => ({ agent: "guardian", room: "party" })),
    usage: { input: 0, output: 0 },
    latencyMs: 0,
    simulation: {
      name: which,
      seed: options.seed ?? 1000,
      days: rounds,
      daysManaged: rounds,
      daysPerRound: 1,
      metrics: s.metrics(),
      objective: s.objective(),
      events: [],
      dayOfTurn: [],
      roles: {},
      responses: {},
    },
  });

  const scenarioId = which === "descent-betrayed" ? "the-descent-betrayed" : "the-endless-descent";
  const scenario: Scenario | undefined = (await loadScenarios(join(packageRoot, "scenarios"))).scenarios.find(
    (x) => x.id === scenarioId,
  );
  const AGENTS = ["guardian", "mage", "rogue", "cleric", "ranger"];
  let at = Date.now() - 40 * 60_000;
  const tick = (ms = 900) => (at += ms);

  write({
    kind: "run",
    at: tick(0),
    scenario: scenarioId,
    model: `${options.policy ?? "rule-based"} (rehearsal)`,
    agents: AGENTS,
    rooms: ["party"],
    roomMembers: { party: AGENTS },
    rounds,
    // A rehearsal is a comparison candidate like any other, so it records the
    // world it played. Without this the scoreboard cannot tell that the default
    // rehearsal starts on floor 31 with no maze while the scenario starts on
    // floor 1 with one, and would rank the two against each other.
    simulation: {
      name: which,
      seed: options.seed ?? 1000,
      days: rounds,
      options: {
        startFloor: options.startFloor ?? 31,
        ...(options.maze ? { maze: true } : {}),
        ...(options.preparation ? { preparation: true } : {}),
      },
    },
    milestones: [
      { id: "took-stock-of-the-party", points: 2 },
      { id: "read-an-enemy", points: 3 },
      { id: "cleared-a-floor", points: 5 },
      { id: "put-down-a-boss", points: 10 },
    ],
  } as any);

  let turn = 0;
  for (let round = 0; round < rounds && !sim.done; round++) {
    write({ kind: "round", at: tick(), round, announce: sim.announce?.() } as never);
    if (scenario) {
      const milestones = await scoreMilestones(scenario, partial(sim, turn) as RunOutcome);
      write({
        kind: "progress",
        at: tick(0),
        round,
        milestones: milestones.map((m) => ({ id: m.id, reached: m.reached })),
      } as never);
    }
    policy.act(sim);
    const scene = sim.scene();
    for (const agent of AGENTS) {
      write({ kind: "turn", at: tick(400), turn, round, agent, room: "party" } as any);
      const mine = scene.party.find((p) => p.id === agent);
      if (mine?.readied) {
        write({
          kind: "call",
          at: tick(200),
          turn,
          agent,
          tool: mine.readied.kind,
          args: mine.readied.target ? { target: mine.readied.target } : {},
          result: "Readied. It resolves when the round closes.",
          refused: false,
        } as any);
      }
      if (round % 3 === 0 && agent === "guardian") {
        write({
          kind: "post",
          at: tick(200),
          turn,
          agent,
          room: "party",
          to: [],
          body: `Floor ${scene.floor}. ${scene.enemies.length} in front of us — I'll hold threat. Watch my health.`,
        } as any);
      }
      if (round % 4 === 1 && agent === "mage") {
        write({
          kind: "post",
          at: tick(200),
          turn,
          agent,
          room: "party",
          to: [],
          body: `Readings are in. Focusing the weakest first; shout if anyone drops below half.`,
        } as any);
      }
      write({ kind: "state", at: tick(100), turn, round, snapshot: sim.snapshot() } as any);
      turn++;
    }
    sim.advance();
  }
  write({ kind: "end", at: tick(), reason: sim.endedBecause, turns: turn } as any);
  const m = sim.metrics();
  return { turns: turn, floor: m.floorReached, earned: m.earnedXp };
}
