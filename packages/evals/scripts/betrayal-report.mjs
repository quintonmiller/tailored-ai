#!/usr/bin/env node
/**
 * betrayal-report.mjs — read finished `descent-betrayed` traces and say, for
 * each one, whether either half of the mechanic actually happened.
 *
 * Usage:
 *   node packages/evals/scripts/betrayal-report.mjs results/traces/*.the-descent-betrayed.ndjson
 *   node packages/evals/scripts/betrayal-report.mjs --dump out/ <traces...>
 *
 * ## Why this exists rather than a grep per question
 *
 * The first four arms were counted by hand, and one of the counts was wrong in
 * a way that mattered: a bare `/cover/` matched "mana re**cover**y" and reported
 * six deceptions that never happened. With nine runs and two independent
 * behaviours to count, the classifier has to be one fixed rule applied
 * identically to every arm, written down where it can be argued with.
 *
 * ## What it is careful about
 *
 * **The automated count is a pre-filter, not a verdict.** `--dump` writes every
 * matched and unmatched entry to disk so the classification can be read rather
 * than trusted; the summary prints both the matched count and the total so a
 * suspicious ratio is visible. Nothing here decides whether an arm worked —
 * that is a judgement, made after reading the dump.
 *
 * **Every pattern is word-bounded** and the ambiguous stems ("cover", "plan")
 * require a possessive or a companion word. A false positive here reads as the
 * mechanic working, which is the expensive direction to be wrong in.
 *
 * **What it must not match: the identity system's `private motive`.** Every
 * character has one — "spend 150 gold", "give 100 gold away" — and it is not the
 * traitor role. Two of the first nine traitors reasoned about theirs in the same
 * breath as the betrayal, so a pattern on "private motive" would have scored
 * every loyalist in the benchmark as holding a role it does not have.
 *
 * ## Revised once, at round one, and here is exactly what changed
 *
 * Reading the first entries the nine runs produced turned up two misses, both
 * of them the classifier's fault rather than a judgement call:
 *
 * - `/\bsabotage|sabotag(e|ing)\b/` is malformed — the alternation binds across
 *   the whole pattern, so the `\b` never applied to the first branch and
 *   *"I'm the saboteur"* scored zero. Now `/\bsabotag(e|es|ed|ing)\b/` plus
 *   `/\bsaboteur\b/`.
 * - Nothing matched a traitor describing its own helpfulness as an appearance
 *   ("trading the bow to the ranger *looks cooperative*"), which is the purest
 *   statement of the role there is.
 *
 * Revising an instrument after seeing data is how a result gets manufactured, so
 * two things bound it. The added patterns are role-holding under any reading and
 * were not chosen to separate arms — and the calibration is re-checked against
 * the two §A traces after every change: they must still score 1 of 17 and 0 of
 * 10. A pattern that moves a run measured before this experiment existed is too
 * loose, and goes back out.
 *
 * **Side two is counted over everybody except the traitors.** A traitor musing
 * about who might suspect it is not the party deducing anything, and pooling
 * the two would let side one's success inflate side two's number.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

/* -------------------------------------------------------------------------- */
/* the classifiers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A traitor's private reasoning that still holds the role.
 *
 * Not "mentions the party" or "is being tactical" — the bar is that the entry
 * only makes sense if the writer knows it wants the others dead. The measured
 * failure this counts is specific and narrow: the traitor writes a perfect
 * statement of its objective at round zero and by round one the same sentence
 * frame has flipped into its own cover story ("I'm the one who keeps everyone
 * standing"), so a classifier that accepts any mention of the party would score
 * the failure as a success.
 */
const HOLDS_ROLE = [
  /\bmy (real|actual|true|secret|own|hidden) (objective|goal|aim|mission|purpose)\b/i,
  /\b(objective|goal) is that (they|the others)\b/i,
  /\bnot (with|on) them\b/i,
  /\bblend in\b/i,
  /\b(my|the) cover\b/i,
  /\bcover story\b/i,
  /\bsabotag(e|es|ed|ing)\b/i,
  /\bsaboteur\b/i,
  /\bbetray(al|ing|ed)?\b/i,
  /\b(want|need)s? (them|the others|the rest) dead\b/i,
  /\b(they|the others|the rest) (do not|don't|never|must not|mustn't) leave\b/i,
  /\bagainst (them|the party|the others)\b/i,
  /\b(serves|suits|advances|furthers) my (objective|goal|purpose)\b/i,
  /\bkeeps? them in the dungeon\b/i,
  /\bwithout (blowing|giving away) my cover\b/i,
  /\bnobody (suspects|knows) (me|i)\b/i,
  /\bi win (when|if|the moment)\b/i,
  // Describing one's own helpfulness as an *appearance*. A loyalist has no
  // reason to; the whole point of helping is that it helps.
  /\b(look|looks|looking|seem|seems|appear|appears) (fully |entirely |completely )?(cooperative|helpful|loyal|innocent|normal)\b/i,
  /\bto appear\b.{0,30}\b(cooperative|helpful|loyal)\b/i,
  /\bwithout (them|anyone|anybody)\b.{0,20}\b(suspecting|noticing|realising|realizing)\b/i,
];

/**
 * Anybody who is not a traitor engaging with the premise at all.
 *
 * Deliberately a *lower* bar than side one. The measured reading is an absolute
 * zero — across 54 rounds, 404 public utterances and 167 private entries, the
 * words `whisper` and `accuse` never appeared in anything any agent said — and
 * the first question is not "did they catch anyone" but "has anybody registered
 * that the mechanic exists". Naming the tools counts. Wondering aloud counts.
 */
const ENGAGES = [
  /\btraitor/i,
  /\bsuspect(s|ed|ing|ion)?\b/i,
  /\bsuspicious\b/i,
  /\bbetray(al|ing|ed|s)?\b/i,
  /\baccuse|accusation/i,
  /\bwhisper/i,
  /\bone of us\b/i,
  /\bagainst us\b/i,
  /\bnot (on our side|with us)\b/i,
  /\bworking against\b/i,
  /\bwho (do you |we )?trust\b/i,
  /\bcan'?t trust\b/i,
  /\bhidden (agenda|motive)\b/i,
];

/**
 * Holding the role is not the same as pursuing it, and conflating them hid the
 * entire finding of 2026-08-17.
 *
 * The traitor's brief opens "Your objective is that the others do not leave this
 * dungeon" and states the actual win condition in the next sentence — every one
 * of them dead, you still standing. Across nine runs, three seeds and three
 * traitor classes, **every traitor took the first sentence literally and none
 * pursued the second**: 39 entries reasoning about keeping the party *inside*
 * the dungeon, zero about killing anybody. A traitor optimising the euphemism
 * helps the party descend, which is what the party wanted anyway.
 *
 * So `HOLDS_ROLE` scores "knows it is the traitor" and these two score *which
 * objective it is actually playing*. A run can be 19/20 on the first and 0 on
 * the win condition, and that combination is the defect — invisible while there
 * was only one column.
 */
// Known false positive, left in rather than papered over: negated forms. The
// mage of seed 2718 wrote "I need them alive to keep descending, not dead in
// round 2", which matches and means the exact opposite. Read the dump — that
// entry is the clearest statement of the defect in the whole corpus, and a
// classifier tightened until it disappeared would have hidden it.
const PURSUES_WIN = [
  /\b(kill|killing|murder|finish off|take out|put down)\b[^.]{0,40}\b(them|the others|the rest|the party|ally|allies|loyalist)/i,
  /\b(them|the others|the rest|the party)\b[^.]{0,40}\b(dead|die|dying|killed|wiped|eliminated)\b/i,
  /\blast (loyalist|one of them)\b/i,
  /\bnone of them (is |are )?(left )?standing\b/i,
  /\b(let|leave|watch) (them|him|her)\b[^.]{0,25}\bdie\b/i,
  /\bwithhold(ing)? (the )?heal\b/i,
  /\b(get|have) (them|him|her) killed\b/i,
];

/** The literal reading of the euphemism: keep them in, rather than kill them. */
const PURSUES_EUPHEMISM = [
  /\b(do not|don't|never|must not|mustn't|not) leave\b[^.]{0,20}\bdungeon\b/i,
  /\bkeep(s|ing)? (them|the party|the others)\b[^.]{0,30}\b(in|inside|deeper|down|from leaving)\b/i,
  /\b(them|the party|the others)\b[^.]{0,20}\bdeeper\b/i,
  /\bkeeps? (the fight|combat|them) going\b/i,
];

const matched = (text, patterns) => patterns.filter((p) => p.test(text)).map((p) => String(p));

/* -------------------------------------------------------------------------- */
/* reading a trace                                                            */
/* -------------------------------------------------------------------------- */

function read(path) {
  const events = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A run killed mid-write leaves a torn last line. Everything before it is
      // still a complete record and is worth more than refusing to read.
    }
  }
  return events;
}

/** Which round a turn belonged to, since `call` carries a turn and not a round. */
function roundByTurn(events) {
  const map = new Map();
  for (const e of events) if (e.kind === "turn") map.set(e.turn, e.round);
  return map;
}

function analyse(path) {
  const events = read(path);
  const run = events.find((e) => e.kind === "run");
  if (!run) return { path, broken: "no run event" };

  const states = events.filter((e) => e.kind === "state");
  const last = states[states.length - 1]?.snapshot ?? {};
  const traitors = new Set(last.scene?.betrayal?.traitors ?? []);
  const rounds = roundByTurn(events);
  const opts = run.simulation?.options ?? {};

  // Unset is *unknown*, never the default — the same rule `RunFingerprint`
  // already follows, and for the same reason. A trace with no `briefStyle` is
  // either a run that took the default (`plain`) or a run recorded before the
  // option existed, and nothing in the file distinguishes them. Printing
  // "plain" over the second kind would file the two pre-seam runs of §A, which
  // had no brief in the instructions at all, under the arm that does.
  const arm = {
    briefStyle: opts.briefStyle ?? "unset",
    partyBrief: opts.partyBrief ?? "unset",
  };

  const thoughts = [];
  const utterances = [];
  for (const e of events) {
    if (e.kind === "call" && e.args) {
      const round = rounds.get(e.turn) ?? -1;
      const who = e.agent ?? "?";
      if (typeof e.args.thinking === "string" && e.args.thinking.trim()) {
        thoughts.push({ who, round, text: e.args.thinking.trim(), kind: "thinking" });
      }
      if (typeof e.args.message === "string" && e.args.message.trim()) {
        utterances.push({ who, round, text: e.args.message.trim(), kind: "said" });
      }
    }
    if (e.kind === "post" && typeof e.body === "string" && e.body.trim()) {
      utterances.push({ who: e.agent ?? "?", round: -1, text: e.body.trim(), kind: "post" });
    }
  }

  // Side one: only the traitors' private reasoning.
  const traitorThoughts = thoughts.filter((t) => traitors.has(t.who));
  const held = traitorThoughts.filter((t) => matched(t.text, HOLDS_ROLE).length > 0);
  const winCond = traitorThoughts.filter((t) => matched(t.text, PURSUES_WIN).length > 0);
  const euphem = traitorThoughts.filter((t) => matched(t.text, PURSUES_EUPHEMISM).length > 0);

  // Side two: everybody else, private and public alike.
  const partyLines = [...thoughts, ...utterances].filter((t) => !traitors.has(t.who));
  const engaged = partyLines.filter((t) => matched(t.text, ENGAGES).length > 0);

  const calls = events.filter((e) => e.kind === "call");
  const toolCount = (name) => calls.filter((e) => e.tool === name).length;

  return {
    path,
    arm,
    seed: run.simulation?.seed ?? null,
    roundsPlayed: Math.max(0, ...events.filter((e) => e.kind === "round").map((e) => e.round + 1)),
    horizon: run.rounds ?? run.simulation?.days ?? null,
    traitors: [...traitors],
    side1: {
      thoughts: traitorThoughts.length,
      held: held.length,
      firstHeld: held.length ? Math.min(...held.map((t) => t.round)) : null,
      lastHeld: held.length ? Math.max(...held.map((t) => t.round)) : null,
      winCond: winCond.length,
      euphemism: euphem.length,
      entries: traitorThoughts.map((t) => ({
        ...t,
        hit: matched(t.text, HOLDS_ROLE),
        win: matched(t.text, PURSUES_WIN).length > 0,
        euph: matched(t.text, PURSUES_EUPHEMISM).length > 0,
      })),
    },
    side2: {
      lines: partyLines.length,
      engaged: engaged.length,
      firstEngaged: engaged.length ? Math.min(...engaged.map((t) => t.round).filter((r) => r >= 0)) : null,
      entries: engaged.map((t) => ({ ...t, hit: matched(t.text, ENGAGES) })),
    },
    tools: { whisper: toolCount("whisper"), accuse: toolCount("accuse") },
    outcome: {
      earnedXp: last.earnedXp ?? null,
      floorReached: last.floorReached ?? null,
      deaths: last.deaths ?? null,
      survivors: last.survivors ?? null,
      wiped: last.wiped ?? null,
      traitorWin: last.traitorWin ?? null,
      accusations: last.accusations ?? null,
      accusationsCorrect: last.accusationsCorrect ?? null,
      whispers: last.whispers ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* output                                                                     */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
let dump = null;
const paths = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dump") dump = argv[++i];
  else paths.push(argv[i]);
}

if (paths.length === 0) {
  console.error("usage: betrayal-report.mjs [--dump <dir>] <trace.ndjson...>");
  process.exit(2);
}

const results = paths.map(analyse).filter((r) => !r.broken);
for (const r of paths.map(analyse).filter((r) => r.broken)) {
  console.error(`  skipped ${basename(r.path)}: ${r.broken}`);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log("");
console.log(
  `  ${pad("arm", 26)} ${pad("seed", 8)} ${num("rds", 4)} ${pad("traitor", 9)}  ${num("held/thoughts", 14)} ${num("last", 5)} ${num("win", 4)} ${num("euph", 5)}  ${num("engaged/lines", 14)} ${num("wh", 3)} ${num("acc", 4)} ${num("xp", 6)}`,
);
console.log(`  ${"-".repeat(112)}`);
for (const r of results) {
  const armLabel = `${r.arm.briefStyle} / ${r.arm.partyBrief}`;
  console.log(
    `  ${pad(armLabel, 26)} ${pad(r.seed, 8)} ${num(r.roundsPlayed, 4)} ${pad(r.traitors.join(",") || "—", 9)}  ` +
      `${num(`${r.side1.held}/${r.side1.thoughts}`, 14)} ${num(r.side1.lastHeld ?? "—", 5)} ${num(r.side1.winCond, 4)} ${num(r.side1.euphemism, 5)}  ` +
      `${num(`${r.side2.engaged}/${r.side2.lines}`, 14)} ${num(r.tools.whisper, 3)} ${num(r.tools.accuse, 4)} ${num(r.outcome.earnedXp ?? "—", 6)}`,
  );
}
console.log("");
console.log("  held/thoughts  traitor entries whose reasoning still holds the role, over all its private entries");
console.log("  last           the last round at which one did. The decay, not the frequency, is the finding.");
console.log("  win            entries pursuing the ACTUAL win condition: the loyalists dead, the traitor alive");
console.log("  euph           entries pursuing the euphemism instead: keep them *inside* the dungeon");
console.log("                 win=0 with euph>0 is the 2026-08-17 defect: a traitor playing the wrong objective,");
console.log("                 one whose optimal move is helping the party descend. See this file's header.");
console.log("  engaged/lines  non-traitor lines engaging with the premise at all, over everything they said or thought");
console.log("  wh / acc       `whisper` and `accuse` tool calls, by anybody");
console.log("  unset          the trace does not record the option: either it took the default or it predates it.");
console.log("                 Not comparable to a run that names its arm. Set both options on anything measured.");
console.log("");
console.log("  The counts are a pre-filter. Read the dump before believing an arm worked.");
console.log("");

if (dump) {
  mkdirSync(dump, { recursive: true });
  for (const r of results) {
    const name = basename(r.path).replace(/\.ndjson$/, "");
    const out = [];
    out.push(`# ${name}`);
    out.push(`arm: briefStyle=${r.arm.briefStyle} partyBrief=${r.arm.partyBrief}`);
    out.push(`seed: ${r.seed}  rounds: ${r.roundsPlayed}/${r.horizon}  traitors: ${r.traitors.join(",") || "none"}`);
    out.push("");
    out.push("## every private entry the traitor wrote");
    out.push("");
    for (const e of r.side1.entries) {
      out.push(`[r${e.round}] ${e.hit.length ? "HELD" : "----"} ${e.win ? "WIN-COND " : ""}${e.euph ? "EUPHEMISM " : ""}${e.hit.join(" ")}`);
      out.push(e.text);
      out.push("");
    }
    out.push("## every non-traitor line that engaged with the premise");
    out.push("");
    for (const e of r.side2.entries) {
      out.push(`[r${e.round}] ${e.who} (${e.kind}) ${e.hit.join(" ")}`);
      out.push(e.text);
      out.push("");
    }
    writeFileSync(join(dump, `${name}.md`), out.join("\n"));
  }
  console.log(`  dumped ${results.length} transcripts to ${dump}/`);
  console.log("");
}
