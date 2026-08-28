/**
 * Past runs, read back off the traces they left behind.
 *
 * The broadcast wants to say "best ever", "yesterday", "last run" — which needs
 * a record of every run, and the package already has one. Every run writes an
 * NDJSON trace, and a trace carries everything a scoreboard needs: which
 * scenario, which model, when, what the world ended up as, and how it finished.
 *
 * Read from traces rather than from the JSON reports on purpose. A report is
 * the authority on a run's *score* and is twenty megabytes of prompts and
 * replies; a trace is three hundred kilobytes and is the only artefact that
 * exists for a run that was interrupted. A scoreboard that silently omitted
 * every abandoned run would flatter the history it is drawn from.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { blankFingerprint, canonicaliseOptions, type RunFingerprint, type RunPoint } from "./run-cohort.js";

export type { RunFingerprint, RunPoint } from "./run-cohort.js";

export interface RunRecord {
  file: string;
  scenario: string;
  model: string;
  /** Epoch millis of the first event. */
  startedAt: number;
  /** Epoch millis of the last event. */
  endedAt: number;
  rounds: number;
  turns: number;
  /** The simulation's headline figure, when it had one. */
  score: number | null;
  floor: number | null;
  bosses: number | null;
  survivors: number | null;
  /** Milestone points reached and available, when the scenario declared them. */
  points: number | null;
  outOf: number | null;
  endedBecause: string | null;
  /** No event for twenty seconds and no `end` — a run that was cut off. */
  finished: boolean;
  /** Set on a rehearsal read out of the baselines directory. See `History.baselines`. */
  baseline?: boolean;
  /**
   * Which game this run played. See `run-cohort.ts` — a scoreboard that ranks a
   * floor-31 run against a floor-1 run is not a noisy scoreboard, it is a wrong
   * one, and this is what lets the panel tell them apart.
   */
  fingerprint: RunFingerprint;
  roomsExplored: number | null;
  deaths: number | null;
  /**
   * Where the run stood at the end of each round.
   *
   * The ghost line is drawn from this, and so is every "at the same round"
   * comparison. Bounded by the horizon — forty-odd points for a full descent —
   * so carrying it for every run on file costs a few kilobytes of the poll.
   */
  track: RunPoint[];
}

export interface History {
  runs: RunRecord[];
  best: RunRecord | null;
  previous: RunRecord | null;
  today: { runs: number; best: number | null };
  week: { runs: number; best: number | null };
  /**
   * Baseline-policy rehearsals, kept strictly out of `runs`.
   *
   * A bot's score is not a record — `rehearse` writes to a different directory
   * for exactly that reason — but "where does this run sit against the ladder"
   * is a fair question, so they are reported alongside and never inside. They
   * carry fingerprints like anything else, so the panel can refuse to compare a
   * rehearsal that played a different configuration.
   */
  baselines: RunRecord[];
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A number off a snapshot, from the first of two sources that carries one.
 *
 * Two sources rather than one because the same figure lives in the flat metrics
 * and in the scene depending on how old the trace is, and a scoreboard that
 * only knew about the newer shape would report an older run as unscored.
 */
function pick(
  first: Record<string, unknown> | null | undefined,
  second: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const a = first?.[key];
  if (typeof a === "number") return a;
  const b = second?.[key];
  return typeof b === "number" ? b : null;
}

/**
 * A declared boolean option, as the simulation itself reads one.
 *
 * `--sim-option` cannot know a simulation's schema, so it hands booleans over
 * as the strings `"true"` and `"false"` while a scenario definition hands over
 * real booleans. The simulation's constructor accepts both; a fingerprint that
 * accepted only one would report two identically-launched runs as different.
 */
function truth(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * One trace, reduced.
 *
 * Streaming line by line rather than parsing the file into an array: a long run
 * is thousands of events and the scoreboard needs about six of them, so holding
 * the whole thing costs memory for nothing. Malformed lines are skipped for the
 * same reason `readTrace` skips them — a trace being appended to right now ends
 * in half a JSON object, and this runs against live files.
 */
export function summariseTrace(path: string): RunRecord | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let scenario = "";
  let model = "";
  let startedAt = 0;
  let endedAt = 0;
  let rounds = 0;
  let turns = 0;
  let finished = false;
  let endedBecause: string | null = null;
  let lastScene: Record<string, unknown> | null = null;
  let lastSnapshot: Record<string, unknown> | null = null;
  let points: number | null = null;
  let outOf: number | null = null;

  const fingerprint = blankFingerprint();
  // Whether a `floorMap` key was ever seen, as opposed to seen and null. A
  // trace written before the room graph existed says nothing about layout; one
  // written after says "no maze" by carrying the key with nothing in it.
  let sawFloorMapKey = false;
  let sawFloorMap = false;
  // Surface preparation is the only thing that ever puts the world in `camp`,
  // and nothing ever puts it back, so seeing that phase anywhere in a run is
  // the same statement as "this run was outfitted before it descended".
  let sawCamp = false;
  // Set when the `run` event stated the configuration outright. Everything the
  // scene and the snapshot can only *suggest* is then left alone: a recorded
  // option is what the run was launched with, and an inference is a reading of
  // what it looked like afterwards.
  let declared = false;
  const track = new Map<number, RunPoint>();

  /**
   * The configuration facts a trace that never declared its options can still
   * be read for.
   *
   * Every one of these is an inference from what the run *looked like*, not a
   * statement of what it was launched with, so `run.simulation` overrules all
   * of them. They are kept because they are all that most of the traces on disk
   * have: the field landed after them, and a scoreboard that could only compare
   * runs made since Tuesday would not be much of a scoreboard.
   *
   * The cast survives the arrival of the seed as a second signal rather than a
   * fallback only. It is generated from the seed and nothing else, so it both
   * fills in for an old trace and cross-checks a new one.
   */
  const readScene = (scene: Record<string, unknown>) => {
    if ("floorMap" in scene) {
      sawFloorMapKey = true;
      if (scene.floorMap != null) sawFloorMap = true;
    }
    if (scene.phase === "camp") sawCamp = true;
    if (typeof scene.horizon === "number" && fingerprint.horizon == null) fingerprint.horizon = scene.horizon;
    if (fingerprint.cast == null && Array.isArray(scene.party)) {
      const names = (scene.party as Array<Record<string, unknown>>)
        .map((member) => (member.identity as Record<string, unknown> | undefined)?.generatedName)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
      if (names.length) fingerprint.cast = names.join("/");
    }
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = Number(event.at ?? 0);
    if (!startedAt) startedAt = at;
    endedAt = at;

    switch (event.kind) {
      case "run": {
        scenario = String(event.scenario ?? "");
        model = String(event.model ?? "");
        const ladder = event.milestones as Array<{ id?: string }> | undefined;
        if (ladder?.length) fingerprint.ladder = ladder.map((m) => String(m.id ?? "")).join(",");
        if (typeof event.rounds === "number") fingerprint.horizon = event.rounds;

        // The authoritative half. `run.simulation` is what the run was actually
        // built with, so where it speaks nothing else gets a vote — the
        // inferences below it exist only for the traces written before it did.
        const sim = event.simulation as
          | { name?: unknown; seed?: unknown; days?: unknown; options?: Record<string, unknown> }
          | undefined;
        if (sim && typeof sim === "object") {
          declared = true;
          if (typeof sim.seed === "number") fingerprint.seed = sim.seed;
          if (typeof sim.days === "number") fingerprint.horizon = sim.days;
          const options = sim.options ?? {};
          const floor = Number(options.startFloor);
          // Left for the snapshot to fill when the options do not name it: a
          // simulation that has no floors should not be told it started on one.
          if (Number.isFinite(floor)) fingerprint.startFloor = floor;
          // Absent means off, not unknown. The harness writes the scenario's
          // whole options object, so a flag missing from a declared bag is a
          // flag that was never set — which is exactly how the simulation reads
          // it too.
          fingerprint.maze = truth(options.maze);
          fingerprint.preparation = truth(options.preparation);
          // Everything not broken out above, so an option nobody has thought
          // about yet still splits the cohort the day it starts mattering.
          fingerprint.options = canonicaliseOptions(options);
        }
        break;
      }
      case "round":
        rounds += 1;
        break;
      case "turn":
        turns += 1;
        break;
      case "state": {
        const snapshot = event.snapshot as Record<string, unknown> | undefined;
        if (snapshot) {
          lastSnapshot = snapshot;
          fingerprint.observed = true;
          if (snapshot.scene && typeof snapshot.scene === "object") {
            lastScene = snapshot.scene as Record<string, unknown>;
            readScene(lastScene);
          }
          // Only when the run never said. A declared starting floor is what the
          // simulation was built with; this is where the party happened to be
          // standing when somebody first looked.
          if (fingerprint.startFloor == null && typeof snapshot.startedAtFloor === "number") {
            fingerprint.startFloor = snapshot.startedAtFloor;
          }
          // Keyed by round rather than appended, so the five snapshots one
          // round of five agents publishes collapse to the last one — the
          // round's settled position, not five copies of its middle.
          const round = Number(event.round ?? 0);
          track.set(round, {
            round,
            xp: pick(snapshot, lastScene, "earnedXp") ?? pick(snapshot, lastScene, "objective") ?? 0,
            floor: pick(lastScene, snapshot, "floor") ?? pick(snapshot, null, "floorReached") ?? 0,
            rooms: pick(snapshot, null, "roomsExplored") ?? 0,
            bosses: pick(snapshot, null, "bossesDefeated") ?? pick(snapshot, null, "bosses") ?? 0,
            deaths: pick(snapshot, null, "deaths") ?? 0,
          });
        }
        break;
      }
      case "progress": {
        const milestones = event.milestones as Array<{ reached: boolean; points?: number }> | undefined;
        if (milestones?.length) {
          // Points are not on the live event, so a reached count stands in when
          // that is all there is. The report is the authority on score; this is
          // a scoreboard.
          points = milestones.filter((m) => m.reached).length;
          outOf = milestones.length;
        }
        break;
      }
      case "end":
        finished = true;
        endedBecause = event.reason ? String(event.reason) : null;
        break;
    }
  }

  if (!scenario) return null;

  fingerprint.scenario = scenario;
  if (!declared) {
    fingerprint.maze = sawFloorMapKey ? sawFloorMap : null;
    // Only a run whose world was seen at all can say it was not outfitted; a
    // trace with no scene is silent about it rather than negative.
    fingerprint.preparation = lastScene ? sawCamp : null;
  }

  return {
    file: path.split("/").pop() ?? path,
    scenario,
    model,
    startedAt,
    endedAt,
    rounds,
    turns,
    score: pick(lastSnapshot, lastScene, "earnedXp") ?? pick(lastSnapshot, null, "objective"),
    floor: pick(lastScene, null, "floor") ?? pick(lastSnapshot, null, "floorReached"),
    bosses: pick(lastSnapshot, null, "bossesDefeated") ?? pick(lastSnapshot, null, "bosses"),
    survivors: pick(lastSnapshot, null, "survivors"),
    points,
    outOf,
    endedBecause,
    finished,
    fingerprint,
    roomsExplored: pick(lastSnapshot, null, "roomsExplored"),
    deaths: pick(lastSnapshot, null, "deaths"),
    // Sorted because the map is keyed by round and a trace whose rounds arrive
    // out of order would otherwise produce a ghost line that doubles back.
    track: [...track.values()].sort((a, b) => a.round - b.round),
  };
}

/** Every summarisable trace in a directory, newest first. Returns nothing rather than throwing. */
function readDirectory(dir: string, scenario?: string): RunRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return [];
  }
  return files
    .map((f) => join(dir, f))
    .map((path) => {
      try {
        // Fall back to the file's own timestamp for a trace whose events carry
        // none, so an old or hand-edited file still sorts sensibly.
        const record = summariseTrace(path);
        if (record && !record.startedAt) record.startedAt = statSync(path).mtimeMs;
        return record;
      } catch {
        return null;
      }
    })
    .filter((r): r is RunRecord => r !== null)
    .filter((r) => !scenario || r.scenario === scenario)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export interface HistoryOptions {
  /**
   * Where the baseline rehearsals live, when the caller wants them read.
   *
   * Optional, and a separate argument rather than a second scan of the same
   * directory, because the separation is the safeguard: `rehearse` writes
   * outside `results/traces/` precisely so a bot's score can never become the
   * record to beat. Reading them here puts them in their own list and nowhere
   * near `best`.
   */
  baselineDir?: string;
}

/**
 * Every run on disk for one scenario, ranked and bucketed.
 *
 * `now` is injectable because "today" and "this week" are the only things here
 * that cannot be tested against a fixed set of files otherwise.
 */
export function readHistory(
  dir: string,
  scenario?: string,
  now: number = Date.now(),
  options: HistoryOptions = {},
): History {
  const runs = readDirectory(dir, scenario);
  // Marked on the record itself, not just by which list it is in: the flag is
  // what stops a rehearsal becoming a cohort member downstream, and a caller
  // that merges the two lists must not be able to lose that by merging them.
  const baselines = (options.baselineDir ? readDirectory(options.baselineDir, scenario) : []).map((r) => ({
    ...r,
    baseline: true,
  }));

  const scored = runs.filter((r) => typeof r.score === "number");
  const bestOf = (rows: RunRecord[]) =>
    rows.length ? rows.reduce((best, r) => ((r.score ?? 0) > (best.score ?? 0) ? r : best)) : null;

  const since = (ms: number) => scored.filter((r) => now - r.startedAt <= ms);
  const todayRuns = since(DAY);
  const weekRuns = since(7 * DAY);

  return {
    runs,
    best: bestOf(scored),
    // The previous *finished* run, not merely the previous file: the one the
    // broadcast is inviting a comparison against is the last one that ran to a
    // conclusion.
    previous: runs.filter((r) => r.finished)[0] ?? null,
    today: { runs: todayRuns.length, best: bestOf(todayRuns)?.score ?? null },
    week: { runs: weekRuns.length, best: bestOf(weekRuns)?.score ?? null },
    baselines,
  };
}
