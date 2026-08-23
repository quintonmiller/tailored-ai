/**
 * What the jams actually produced, across the board.
 *
 * One run tells you almost nothing here — there is no score, sampling varies,
 * and every conclusion is a case study. What is worth looking at is the *cohort*:
 * whether the numbers that describe a healthy run are moving as the scenario
 * changes underneath them.
 *
 *   pnpm exec tsx packages/evals/scripts/jam-report.ts
 *   pnpm exec tsx packages/evals/scripts/jam-report.ts --limit 8
 *
 * The four columns that matter, and why:
 *
 * - **empty** — turns that produced no tool call and no message. Read from the
 *   trace rather than the metrics, because the simulation never sees a turn.
 *   This was 44% before the "finish the turn" instruction and it is the single
 *   best predictor of whether a run produces anything at all.
 * - **builds** — how many times the team put something on the board, and how
 *   many of those it chose rather than the harness checkpointing for it. All
 *   automatic means the mechanism did not land.
 * - **plays** — `playtest` calls. A team that never runs its game cannot tell a
 *   finished one from a black rectangle, and four jams were lost that way.
 * - **lines** — with the engine skeleton subtracted, so a scaffolded run stays
 *   comparable with one that wrote its own loop.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArcadeStore } from "@tailored-ai/arcade";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const traceDir = join(packageRoot, "results", "traces");

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt === -1 ? 14 : Number(args[limitAt + 1] ?? 14);

/** Turns that produced nothing, per run, keyed by the run id in the filename. */
function emptyTurns(runId: string): { empty: number; turns: number } | undefined {
  if (!existsSync(traceDir)) return undefined;
  // `arcade-28-2026-08-23-10-42-57` -> the trace stamped `2026-08-23-10-42-57`.
  const stamp = runId.replace(/^[a-z]+-\d+-/, "");
  const file = readdirSync(traceDir).find((f) => f.startsWith(stamp));
  if (!file) return undefined;

  let turns = 0;
  let empty = 0;
  let acted = 0;
  let started = false;
  for (const line of readFileSync(join(traceDir, file), "utf8").split("\n")) {
    if (!line) continue;
    let event: { kind?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.kind === "turn") {
      if (started && acted === 0) empty += 1;
      turns += 1;
      acted = 0;
      started = true;
    } else if (event.kind === "call" || event.kind === "post") {
      acted += 1;
    }
  }
  if (started && acted === 0) empty += 1;
  return { turns, empty };
}

const store = new ArcadeStore(join(homedir(), ".tai-arcade"));
const entries = store
  .list({ includeDrafts: true, sort: "recent", limit: LIMIT })
  .slice()
  .reverse();

const row = (cells: string[]) => cells.join("  ");
console.log(
  row([
    "game".padEnd(16),
    "sim".padEnd(18),
    "rnd".padStart(3),
    "files".padStart(5),
    "lines".padStart(5),
    "wr".padStart(2),
    "plays".padStart(5),
    "builds".padStart(6),
    "empty".padStart(6),
    "engine".padEnd(8),
    "state",
  ]),
);
console.log("-".repeat(112));

for (const entry of entries) {
  const m = entry.metrics ?? {};
  const versions = store.versions(entry.id);
  const chosen = versions.filter((v) => !v.auto).length;
  const turns = emptyTurns(entry.id);
  const lines = Number(m.linesInWorkspace ?? 0) - Number(m.scaffoldLines ?? 0);

  console.log(
    row([
      (entry.title ?? entry.slug).slice(0, 16).padEnd(16),
      String(entry.simVersion || "—").slice(0, 18).padEnd(18),
      String(m.roundsPlayed ?? "—").padStart(3),
      String(m.filesPresent ?? "—").padStart(5),
      String(lines || "—").padStart(5),
      String(m.distinctWriters ?? "—").padStart(2),
      String(m.playtestsRun ?? "—").padStart(5),
      `${String(versions.length).padStart(2)}/${String(chosen).padStart(2)}`.padStart(6),
      (turns ? `${Math.round((turns.empty / Math.max(1, turns.turns)) * 100)}%` : "—").padStart(6),
      (Number(m.engineChosen ?? 0) ? "yes" : "—").padEnd(8),
      entry.status === "published" ? (entry.live ? "building" : "published") : "no game",
    ]),
  );
}

console.log("-".repeat(112));
console.log(
  "builds = total/chosen  ·  wr = distinct writers  ·  lines excludes the engine skeleton\n" +
    "empty = turns that produced no tool call and no message",
);
store.close();
