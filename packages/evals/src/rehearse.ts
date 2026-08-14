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
  seed?: number;
  rounds?: number;
  startFloor?: number;
}

export async function rehearse(options: RehearsalOptions): Promise<{ turns: number; floor: number; earned: number }> {
  const out = options.out;
  const write = fileSink(out);
  const rounds = options.rounds ?? 40;
  // The concrete class, because a rehearsal drives the policy against the same
  // public API an agent's tools wrap — a bot that reached past it would produce a
  // trace of a game the agents are not playing.
  const sim = createSimulation("descent", {
    seed: options.seed ?? 1000,
    days: rounds,
    startFloor: options.startFloor ?? 31,
  }) as DescentSimulation;
  const policy = simulationPolicies("descent")[options.policy ?? "rule-based"]();

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
      name: "descent",
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

  const scenario: Scenario | undefined = (await loadScenarios(join(packageRoot, "scenarios"))).scenarios.find(
    (x) => x.id === "the-endless-descent",
  );
  const AGENTS = ["guardian", "mage", "rogue", "cleric", "ranger"];
  let at = Date.now() - 40 * 60_000;
  const tick = (ms = 900) => (at += ms);

  write({
    kind: "run",
    at: tick(0),
    scenario: "the-endless-descent",
    model: `${options.policy ?? "rule-based"} (rehearsal)`,
    agents: AGENTS,
    rooms: ["party"],
    roomMembers: { party: AGENTS },
    rounds,
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
