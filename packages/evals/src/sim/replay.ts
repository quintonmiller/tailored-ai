/**
 * Rebuilding a world from the trace a run already wrote.
 *
 * Testing a mechanic that unlocks on round eleven used to cost a full run to
 * reach round eleven — twenty-six minutes of GPU to ask a ninety-second
 * question. Nothing about that was necessary: a simulation is deterministic
 * given its seed, its options and the sequence of calls made against it, and
 * the trace records all three. Replaying the calls with no model attached puts
 * the world back where it was in about a second.
 *
 * This is a framework capability rather than a dungeon one. It reads `call`
 * events and a simulation name; it knows nothing about floors, traitors or
 * caches, and any simulation whose tools are pure functions of the world gets
 * it for free.
 *
 * **It is not a state file.** There is deliberately no serialisation format to
 * keep in step with the simulation — a snapshot written by one version and
 * loaded by another is a class of bug that replay simply does not have. The
 * cost is that replay only reaches states some run actually reached, which is
 * the right constraint for a benchmark: a hand-authored state is a state no
 * party could have played into.
 */

import { readFileSync } from "node:fs";
import type { Tool } from "@tailored-ai/core";
import { createSimulation, type Simulation } from "./index.js";

interface TraceCall {
  kind: "call";
  turn: number;
  agent?: string;
  tool: string;
  args?: Record<string, unknown>;
}

interface TraceTurn {
  kind: "turn";
  turn: number;
  round: number;
  agent: string;
}

export interface ReplayResult {
  sim: Simulation;
  /** The round the world is now at the *start* of. */
  round: number;
  /** Calls replayed, and how many the simulation refused this time around. */
  replayed: number;
  refused: number;
  /**
   * Counters that came out different from the run this replayed.
   *
   * Empty is the normal case and the one worth insisting on. A non-empty list
   * means the rebuilt world is not the world the trace describes, which makes
   * every number measured on top of it a number about nothing. The usual cause
   * is an override that reaches world generation.
   */
  drift: string[];
}

/**
 * Counters compared between the replayed world and the recorded one.
 *
 * Deliberately the cheap scalar ones. A deep equality check would fail on
 * things that are allowed to differ — object identity, per-run narration — and
 * a check that cries wolf is a check that gets turned off.
 */
const FIDELITY_KEYS = [
  "earnedXp",
  "floorReached",
  "floorsCleared",
  "roomsExplored",
  "enemiesDefeated",
  "elitesDefeated",
  "goldSpent",
  "deaths",
  "partyLevel",
  "tick",
];

/**
 * What a run was configured with, read back out of its own first event.
 *
 * Read from the trace rather than passed in, because the whole point is to
 * reproduce *that* run: a seed or an option supplied by hand is how a resumed
 * world quietly stops being the world it claims to continue.
 */
export function replayConfig(tracePath: string): {
  name: string;
  seed: number;
  days?: number;
  options: Record<string, unknown>;
  resumedFrom?: { trace: string; round: number };
} {
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as {
      kind: string;
      resumedFrom?: { trace: string; round: number };
      simulation?: { name: string; seed: number; days?: number; options?: Record<string, unknown> };
    };
    if (event.kind === "run" && event.simulation) {
      // `days` sits beside the options bag rather than inside it, and it is not
      // cosmetic: it is the horizon, which the difficulty ramp reads. Rebuilding
      // without it produced a world that matched for four rounds and then drifted.
      return {
        name: event.simulation.name,
        seed: event.simulation.seed,
        ...(event.simulation.days === undefined ? {} : { days: event.simulation.days }),
        options: event.simulation.options ?? {},
        ...(event.resumedFrom ? { resumedFrom: event.resumedFrom } : {}),
      };
    }
  }
  throw new Error(`${tracePath} has no run event, so nothing says which simulation it was`);
}

/**
 * Play a trace back into a fresh simulation, stopping at the start of `round`.
 *
 * Refusals are counted rather than thrown. A replayed call can legitimately be
 * refused where the original was not — the commonest cause is a tool whose
 * result depended on something outside the simulation — and one refusal in a
 * thousand calls is worth knowing about without being worth abandoning a world
 * for. A replay that refuses *most* of what it replays is a broken replay, and
 * the count is what lets a caller tell those apart.
 */
export async function replayTrace(
  tracePath: string,
  round: number,
  daysPerRound = 1,
  overrides: Record<string, unknown> = {},
): Promise<ReplayResult> {
  const { name, seed, days, options, resumedFrom } = replayConfig(tracePath);
  // A trace from a resumed run describes only its own half of the world. Play
  // its parent first, then this one on top, however deep the chain goes — which
  // is what makes "resume from where the accusation landed" work when the
  // accusation itself happened in a resumed run.
  const parent = resumedFrom
    ? await replayTrace(resumedFrom.trace, resumedFrom.round, daysPerRound, overrides)
    : undefined;
  // Overrides layered on the recorded options, because the point of resuming is
  // usually to ask what a *different* configuration does in a world that is
  // otherwise the same — "what would this party have done at round fourteen if
  // the vigil existed". An override that reaches world generation breaks that
  // premise silently, so `drift` below checks rather than trusts.
  const sim =
    parent?.sim ?? createSimulation(name, { seed, ...(days === undefined ? {} : { days }), ...options, ...overrides });

  const turns = new Map<number, TraceTurn>();
  const callsByTurn = new Map<number, TraceCall[]>();
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { kind: string };
    if (event.kind === "turn") {
      const t = event as unknown as TraceTurn;
      turns.set(t.turn, t);
    } else if (event.kind === "call") {
      const c = event as unknown as TraceCall;
      const list = callsByTurn.get(c.turn) ?? [];
      list.push(c);
      callsByTurn.set(c.turn, list);
    }
  }

  const byName = new Map<string, Tool>();
  for (const tool of sim.sharedTools()) byName.set(tool.name, tool);
  for (const list of Object.values(sim.tools())) for (const tool of list) byName.set(tool.name, tool);

  let replayed = parent?.replayed ?? 0;
  let refused = parent?.refused ?? 0;
  // A continued trace numbers its own rounds from zero, so "round 3 of this
  // trace" is the parent's stopping point plus three. Without the offset the
  // replay would try to wind a world backwards.
  const base = parent?.round ?? 0;
  let reached = base;
  const ordered = [...turns.values()].sort((a, b) => a.turn - b.turn);

  for (const turn of ordered) {
    if (base + turn.round >= base + round) break;
    // The harness advances when it moves to a new round, so round 0 is played
    // against the world as constructed and every later round against a world
    // that has ticked exactly once per round behind it.
    while (reached < base + turn.round && !sim.done) {
      for (let i = 0; i < daysPerRound && !sim.done; i++) sim.advance();
      reached += 1;
    }
    if (sim.done) break;
    for (const call of callsByTurn.get(turn.turn) ?? []) {
      const tool = byName.get(call.tool);
      if (!tool) continue;
      replayed += 1;
      try {
        // Awaited. These are async, and the first version of this replay was
        // not: `void tool.execute(...)` returned a promise nobody held, so every
        // effect that landed after an await was lost and every refusal was
        // swallowed. The world matched for zero rounds and reported zero
        // refusals, which is the most misleading pair of numbers it could have
        // produced.
        await (tool as unknown as { execute(a: unknown, c: unknown): Promise<unknown> }).execute(call.args ?? {}, {
          agentName: call.agent,
        });
      } catch {
        refused += 1;
      }
    }
  }

  while (reached < base + round && !sim.done) {
    for (let i = 0; i < daysPerRound && !sim.done; i++) sim.advance();
    reached += 1;
  }

  return { sim, round: reached, replayed, refused, drift: driftAgainst(tracePath, sim, reached - base) };
}

/**
 * Which counters disagree with what the original run recorded at this round.
 *
 * The check exists because the first version of this replay diverged from round
 * one while reporting zero refusals — the tools are async and it was not
 * awaiting them — and there was nothing in the result that said so. A rebuilt
 * world that quietly is not the world it claims to be is the one failure mode
 * this capability must not have.
 */
function driftAgainst(tracePath: string, sim: Simulation, round: number): string[] {
  let recorded: Record<string, unknown> | undefined;
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as {
      kind: string;
      round?: number;
      resolved?: boolean;
      snapshot?: Record<string, unknown>;
    };
    if (event.kind === "state" && event.resolved === true && event.round === round - 1) recorded = event.snapshot;
  }
  if (!recorded) return [];
  const mine = sim.snapshot() as Record<string, unknown>;
  return FIDELITY_KEYS.filter(
    (k) => recorded[k] !== undefined && JSON.stringify(mine[k]) !== JSON.stringify(recorded[k]),
  );
}
