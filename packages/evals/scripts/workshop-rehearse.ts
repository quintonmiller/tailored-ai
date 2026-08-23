/**
 * A workshop trace from a bot, so the viewer can be looked at without spending
 * two hours of model time.
 *
 * Separate from `src/rehearse.ts` on purpose. That module is the descent's:
 * hardcoded party, scene beats, floor and experience in its return type, and a
 * `--policy` flag whose rungs are that dungeon's ladder. Generalising it would
 * be a real refactor of a file that is under active development elsewhere, and
 * the whole value of a rehearsal is that it is cheap. This is forty lines that
 * emit the same trace shape.
 *
 *     npx tsx scripts/workshop-rehearse.ts
 *     npx tsx src/cli.ts watch --trace results/rehearsals/workshop.ndjson
 *
 * Written to `results/rehearsals/` rather than `results/traces/`, which is the
 * boundary `readHistory` respects: a bot's run must never be able to appear on
 * a scoreboard as something an agent did.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSimulation, simulationPolicies } from "../src/sim/index.js";
import { fileSink } from "../src/trace.js";
import { ArcadeStore } from "@tailored-ai/arcade";
import type { WorkshopSimulation } from "../src/sim/workshop/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(packageRoot, "results", "rehearsals", "workshop.ndjson");
const brief = process.argv.find((a) => a.startsWith("--brief="))?.slice("--brief=".length) ?? "arcade";
const rounds = Number(process.argv.find((a) => a.startsWith("--rounds="))?.slice("--rounds=".length) ?? 20);

mkdirSync(dirname(out), { recursive: true });
// Start empty: a rehearsal writes to a fixed path and is meant to replace what
// was there, while `fileSink` appends because a real run writes once to its own
// timestamped file.
writeFileSync(out, "");
const write = fileSink(out);

const root = join(packageRoot, "results", "rehearsals", "workshop-workspace");
/*
 * A throwaway arcade, so the rehearsal exercises the claim/submit path.
 *
 * Without one the desk is never constructed, `submit_version` and `claim_file`
 * do not exist, and the script's steps for them are silently swallowed — which
 * is a no-model run that reports success while testing none of the code most
 * likely to be wrong.
 *
 * Pointed at `results/` rather than `~/.tai-arcade` on purpose: a rehearsal must
 * never add a scripted bot's output to the board a person reviews.
 */
const arcadeHome = join(packageRoot, "results", "rehearsals", "arcade");
rmSync(arcadeHome, { recursive: true, force: true });
const sim = createSimulation("workshop", {
  seed: 1,
  days: rounds,
  brief,
  root,
  stamp: "rehearsal",
  arcadeHome,
}) as WorkshopSimulation;
const policy = simulationPolicies("workshop").scripted();

const ROOMS: Record<string, string[]> = {
  studio: ["lead", "builder", "interface", "author", "tester"],
  build: ["lead", "builder", "tester"],
  craft: ["lead", "interface", "author"],
};

// Backdated so the file does not look live to `watch`'s staleness check the
// moment it is written.
let at = Date.now() - 40 * 60_000;
const tick = (ms = 700): number => (at += ms);

write({
  kind: "run",
  at: tick(0),
  scenario: "the-workshop",
  model: "scripted (rehearsal)",
  agents: ROOMS.studio,
  rooms: Object.keys(ROOMS),
  roomMembers: ROOMS,
  rounds,
  simulation: { name: "workshop", seed: 1, days: rounds, options: { brief } },
});

let turn = 0;
for (let round = 0; round < rounds && !sim.done; round++) {
  write({ kind: "round", at: tick(), round, day: sim.day, announce: sim.announce() });
  policy.act(sim);
  for (const [room, members] of Object.entries(ROOMS)) {
    for (const agent of members) {
      write({ kind: "turn", at: tick(300), turn, round, agent, room });
      const files = sim.workspace.list().filter((f) => !f.planned);
      if (agent === "lead" && room === "studio") {
        write({
          kind: "post",
          at: tick(150),
          turn,
          agent,
          room,
          to: [],
          body: `Round ${round + 1}. ${files.length} files up, ${files.reduce((s, f) => s + f.lines, 0)} lines.`,
        });
      }
      write({ kind: "state", at: tick(100), turn, round, snapshot: sim.snapshot() });
      turn++;
    }
  }
  sim.advance();
}
write({ kind: "end", at: tick(), reason: sim.endedBecause, turns: turn });

// Publishing is where the version history, the entry row and the playable copy
// all have to agree, and it is the last thing a run does — so a rehearsal that
// stops short of it leaves the most breakable step untested.
await sim.finish?.();

const metrics = sim.metrics();
console.log(`wrote ${out}`);
console.log(`  artifact  ${sim.root}`);
console.log(`  ${turn} turns, ${metrics.filesPresent} files, ${metrics.linesInWorkspace} lines`);
console.log(
  `  submitted ${metrics.arcadeSubmits ?? 0} build(s), ${metrics.arcadeAutoSubmits ?? 0} automatic; ` +
    `${metrics.claims ?? 0} claims, ${metrics.ownershipRefusals ?? 0} ownership refusals`,
);

const board = new ArcadeStore(arcadeHome);
for (const entry of board.list({ includeDrafts: true })) {
  const builds = board.versions(entry.id);
  console.log(`  board     ${entry.slug} — ${entry.status}, ${builds.length} build(s) kept`);
  for (const b of builds) {
    console.log(`              ${b.version}${b.auto ? " (auto)" : ""}${b.round === null ? "" : ` r${b.round + 1}`} — ${b.notes}`);
  }
}
board.close();

console.log(`  watch it: npx tsx src/cli.ts watch --trace ${out.replace(`${packageRoot}/`, "")}`);
