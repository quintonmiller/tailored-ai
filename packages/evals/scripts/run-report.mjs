#!/usr/bin/env node
/**
 * What happened in a run, in one screen.
 *
 * Written because the same twenty node one-liners were being retyped after
 * every run, and because the diagnosis of one four-hour run — five characters
 * at full health on tick 39, five corpses on tick 55, no rounds in between —
 * was sitting in the trace the whole time and took forty minutes of forensics
 * to find.
 *
 * Every line below answers a question that has actually had to be answered by
 * hand during this workstream. The tick-gap check at the bottom is the one that
 * would have caught the manufactured wipe in about a second.
 *
 *   node scripts/run-report.mjs <trace.ndjson>
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: run-report.mjs <trace.ndjson>");
  process.exit(2);
}

const events = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const turns = events.filter((e) => e.kind === "turn");
const calls = events.filter((e) => e.kind === "call");
const states = events.filter((e) => e.kind === "state" && e.snapshot);
const last = states.at(-1)?.snapshot ?? {};
const end = events.find((e) => e.kind === "end");
const run = events.find((e) => e.kind === "run");
const rounds = turns.length ? Math.max(...turns.map((t) => t.round)) + 1 : 0;
const n = (v) => (v === undefined ? "—" : String(v));

console.log(`\n  ${path.split("/").pop()}`);
if (run?.resumedFrom) {
  console.log(`  resumed from ${run.resumedFrom.trace.split("/").pop()} @ round ${run.resumedFrom.round}`);
}
console.log(
  `  ${rounds} agent rounds · tick ${n(last.ticksSurvived)}/${n(run?.simulation?.days)} · ` +
    `floor ${n(last.floor)} · ${n(last.earnedXp)} xp` +
    `${end ? ` · ENDED: ${end.reason}` : " · still running"}`,
);
console.log(`\n  survivors ${n(last.survivors)} · dead ${n(last.permanentDeaths)} · wiped ${last.wiped ? "yes" : "no"}`);

if (last.betrayalInPlay) {
  const sc = states.at(-1)?.snapshot?.scene?.betrayal;
  console.log(
    `  traitors ${n(last.traitors)}${sc?.traitors?.length ? ` (${sc.traitors.join(", ")})` : ""} · ` +
      `turned ${last.turned ? `yes @${last.turnedAt}` : "no"} · traitorWin ${n(last.traitorWin)}`,
  );
  console.log(
    `  reads ${n(last.reads)} (${n(last.readsCorrect)} right) · draughts ${n(last.draughts)} · ` +
      `poisonings ${n(last.poisonings)} · whispers ${n(last.whispers)} · accusations ${n(last.accusations)} · ` +
      `binds ${n(last.binds)} · executions ${n(last.executions)}`,
  );
}

const used = new Map();
for (const c of calls) {
  const names = c.tool === "execute_actions" ? (c.args?.actions ?? []).map((a) => a?.actionType) : [c.tool];
  for (const name of names) if (name) used.set(name, (used.get(name) ?? 0) + 1);
}
const top = [...used.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n  called (${calls.length} calls): ${top.map(([k, v]) => `${k} ${v}`).join(", ")}`);

const refused = calls.filter((c) => c.refused || /^Refused:/.test(String(c.result ?? "")));
if (refused.length) {
  const why = new Map();
  for (const r of refused) {
    const key = `${r.tool}: ${String(r.result).replace(/^Refused:\s*/, "").slice(0, 58)}`;
    why.set(key, (why.get(key) ?? 0) + 1);
  }
  console.log(`\n  refused ${refused.length}:`);
  for (const [k, v] of [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${v}x ${k}`);
}

const silent = calls.filter((c) => String(c.result ?? "").trim() === "");
if (silent.length) {
  console.log(
    `\n  !! ${silent.length} call(s) returned an empty result: ${[...new Set(silent.map((c) => c.tool))].join(", ")}`,
  );
}

/*
 * The check that would have saved four hours.
 *
 * A jump in the simulation's tick with no agent round attached means the world
 * moved while nobody was playing — the shape that turned a healthy party into a
 * wipe when `--rounds` raised the horizon without raising the roster.
 */
const ticks = states.map((s) => s.snapshot.ticksSurvived).filter((t) => typeof t === "number");
let worstGap = 0;
let gapAt = 0;
for (let i = 1; i < ticks.length; i++) {
  if (ticks[i] - ticks[i - 1] > worstGap) {
    worstGap = ticks[i] - ticks[i - 1];
    gapAt = ticks[i - 1];
  }
}
if (worstGap > 1) {
  console.log(
    `\n  !! the world advanced ${worstGap} ticks in one step at tick ${gapAt}, with no agent round in between.` +
      `\n     Something played this run that was not the party — check --rounds against the scenario's roster.`,
  );
}
console.log("");
