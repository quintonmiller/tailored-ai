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
}

export interface History {
  runs: RunRecord[];
  best: RunRecord | null;
  previous: RunRecord | null;
  today: { runs: number; best: number | null };
  week: { runs: number; best: number | null };
}

const DAY = 24 * 60 * 60 * 1000;

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
      case "run":
        scenario = String(event.scenario ?? "");
        model = String(event.model ?? "");
        break;
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
          if (snapshot.scene && typeof snapshot.scene === "object") {
            lastScene = snapshot.scene as Record<string, unknown>;
          }
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

  const num = (source: Record<string, unknown> | null, key: string): number | null => {
    const value = source?.[key];
    return typeof value === "number" ? value : null;
  };

  return {
    file: path.split("/").pop() ?? path,
    scenario,
    model,
    startedAt,
    endedAt,
    rounds,
    turns,
    score: num(lastSnapshot, "earnedXp") ?? num(lastScene, "earnedXp") ?? num(lastSnapshot, "objective"),
    floor: num(lastScene, "floor") ?? num(lastSnapshot, "floorReached"),
    bosses: num(lastSnapshot, "bossesDefeated") ?? num(lastSnapshot, "bosses"),
    survivors: num(lastSnapshot, "survivors"),
    points,
    outOf,
    endedBecause,
    finished,
  };
}

/**
 * Every run on disk for one scenario, ranked and bucketed.
 *
 * `now` is injectable because "today" and "this week" are the only things here
 * that cannot be tested against a fixed set of files otherwise.
 */
export function readHistory(dir: string, scenario?: string, now: number = Date.now()): History {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return { runs: [], best: null, previous: null, today: { runs: 0, best: null }, week: { runs: 0, best: null } };
  }

  const runs = files
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
  };
}
