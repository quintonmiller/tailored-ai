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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSimulation, simulationPolicies } from "../src/sim/index.js";
import { fileSink } from "../src/trace.js";
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
const sim = createSimulation("workshop", { seed: 1, days: rounds, brief, root, stamp: "rehearsal" }) as WorkshopSimulation;
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

const metrics = sim.metrics();
console.log(`wrote ${out}`);
console.log(`  artifact  ${sim.root}`);
console.log(`  ${turn} turns, ${metrics.filesPresent} files, ${metrics.linesInWorkspace} lines`);
console.log(`  watch it: npx tsx src/cli.ts watch --trace ${out.replace(`${packageRoot}/`, "")}`);
