/**
 * Watching a run happen, instead of reading what it did afterwards.
 *
 * A benchmark run against a local model is an hour long and produces a six
 * megabyte report at the end of it. Everything interesting — a team agreeing on
 * a plan and then failing to execute it, a fact that reaches the wrong room, a
 * tool refusing for a reason nobody reads — happens in the middle, and until
 * now the only way to see any of it was to wait for the end and grep JSON.
 *
 * Worse, it hid a real defect for a full sixty-seven-minute run: six roles were
 * silently sharing one tool implementation, and the transcript read as a team
 * hallucinating its own capabilities. Live, with the tool results beside the
 * messages, it would have been obvious in round two.
 *
 * ## Why a callback and a file rather than a socket
 *
 * The harness emits; it does not write. A run happens inside a worker process,
 * and the harness has no business knowing whether anybody is watching or where
 * the output goes — the same argument that moved the clock's announcement out
 * of the harness and into the simulation. So `HarnessOptions.trace` is an
 * optional sink, the worker points it at a file, and anything that wants to
 * watch tails the file. No ports, no lifecycle, and a trace of a finished run
 * is the same artefact as a trace of a running one.
 *
 * NDJSON because it is append-only and readable while it is being written,
 * which is the entire requirement.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Simulation } from "./sim/types.js";

export type TraceEvent =
  /** Once, first. Everything a viewer needs before any turns arrive. */
  | {
      kind: "run";
      at: number;
      scenario: string;
      intent?: string;
      model: string;
      agents: string[];
      rooms: string[];
      /**
       * Who is subscribed to each room.
       *
       * A viewer scoped to one room has to be able to say who is in it — a room
       * is a membership list before it is a transcript, and "which two of these
       * six can hear each other" is most of what a reader of a multi-room run
       * is trying to work out.
       */
      roomMembers?: Record<string, string[]>;
      /** Which simulation role each agent plays, when there is one. */
      roles?: Record<string, string>;
      /** Rounds the roster gets. */
      rounds?: number;
      /** The values that have to travel, so a viewer can show where each got to. */
      facts?: Record<string, { value: string; discoverableBy?: string[]; requiredBy?: string[] }>;
      milestones?: Array<{ id: string; points: number }>;
    }
  | { kind: "round"; at: number; round: number; day?: number; announce?: string }
  | { kind: "turn"; at: number; turn: number; round: number; agent: string; room: string }
  | {
      kind: "call";
      at: number;
      turn: number;
      agent?: string;
      tool: string;
      args: Record<string, unknown>;
      result: string;
      /** The machinery said no. Worth its own colour: it is how a puzzle teaches. */
      refused: boolean;
    }
  | { kind: "post"; at: number; turn: number; agent?: string; room: string; to: string[]; body: string }
  /** The simulation's own view of itself, after a turn or a resolved boundary. */
  | {
      kind: "state";
      at: number;
      turn: number;
      round: number;
      snapshot: Record<string, unknown>;
      /** True when this state was emitted after the world clock advanced. */
      resolved?: boolean;
      /** The simulation's account of that resolution. */
      announce?: string;
    }
  /** Recomputed each round by the real graders, so live and final never disagree. */
  | {
      kind: "progress";
      at: number;
      round: number;
      milestones: Array<{ id: string; reached: boolean }>;
      facts?: unknown;
    }
  | { kind: "end"; at: number; reason?: string; turns: number };

export type TraceSink = (event: TraceEvent) => void;

/**
 * Complete a simulation and close its trace without letting those two views
 * disagree about the final world state.
 *
 * Ordering is the contract: resolve to the horizon, publish the authoritative
 * snapshot, then publish `end`. Emitting `end` first used to omit the final
 * round from broadcasts and history while the report quietly included it.
 */
export function finishSimulationTrace(
  sim: Simulation | undefined,
  write: TraceSink | undefined,
  position: { turn: number; round: number; turns: number },
): void {
  if (sim) {
    // Only where an unattended world still means something. See
    // `Simulation.runsOnUnattended`: for the factory it does — an abandoned
    // company keeps paying wages, and an eight-round agent run has to be
    // scored over the same sixty days its baselines were swept over, or every
    // team that stopped early is flattered. For the workshop it does not:
    // nothing happens in a directory nobody is typing in, and ticking the
    // clock past the roster would make the round count stop meaning turns
    // taken.
    let guard = 0;
    if (sim.runsOnUnattended !== false) while (!sim.done && guard++ < 10_000) sim.advance();
    // Then tell it the run is over, whichever of those two paths it took. See
    // `Simulation.finish` — a simulation is never told how long the roster is,
    // so without this the one whose only ending is the horizon never learns it
    // reached it.
    sim.finish?.();
    const announce = sim.announce?.();
    write?.({
      kind: "state",
      at: Date.now(),
      turn: position.turn,
      round: position.round,
      snapshot: sim.snapshot(),
      resolved: true,
      ...(announce ? { announce } : {}),
    });
  }
  write?.({
    kind: "end",
    at: Date.now(),
    ...(sim?.endedBecause ? { reason: sim.endedBecause } : {}),
    turns: position.turns,
  });
}

/**
 * A sink that appends to a file.
 *
 * Synchronous appends on purpose. The alternative is a stream whose buffer is
 * discarded when the worker exits — the same failure the result file was moved
 * to disk to avoid — and a trace that loses its last few seconds is a trace
 * that loses the end of the run, which is the part you were waiting for.
 */
export function fileSink(path: string): TraceSink {
  mkdirSync(dirname(path), { recursive: true });
  return (event) => {
    try {
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    } catch {
      // A trace is instrumentation. It must never be able to fail a run.
    }
  };
}

/** Read a trace, whole or half-written. */
export function readTrace(path: string): TraceEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: TraceEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // The last line of a file being appended to is routinely half a JSON
      // object. Dropping it is correct: it arrives complete a moment later.
    }
  }
  return events;
}

/** Did the machinery say no? Used to colour a call without the viewer guessing. */
export function looksRefused(result: string): boolean {
  return /^Refused:|^refused\b|not authorised|preconditions not met/i.test(result.trim());
}
