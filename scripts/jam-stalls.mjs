#!/usr/bin/env node
/*
 * Which agents are thinking themselves out of a turn, and how often.
 *
 * A jam turn that produces no tool call and no post looks identical in the
 * trace whether the watcher declined to run the agent (correct, free) or the
 * model ran and was truncated mid-reasoning (a wasted round and a minute of
 * GPU). The trace cannot tell them apart, and for a long time nobody could:
 * the session home was a mkdtemp that got deleted in a `finally`.
 *
 * Making runs resumable kept the home, and the home has `token_usage`. A
 * completion that comes back at exactly `--max-tokens` is a truncated one, and
 * an assistant row whose content is empty next to it means every one of those
 * tokens went into reasoning that never reached a tool call.
 *
 * That is the whole diagnosis, and it takes one query:
 *
 *   node scripts/jam-stalls.mjs packages/evals/results/sessions/seed-33
 *
 * Pass --cap to match a run that used something other than 16384.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--cap");
if (!target) {
  console.error("usage: node scripts/jam-stalls.mjs <session-dir-or-db> [--cap 16384]");
  process.exit(1);
}
const dbPath = target.endsWith(".db") ? target : join(target, "home", "agent.db");
if (!existsSync(dbPath)) {
  console.error(`no session database at ${dbPath}`);
  process.exit(1);
}

const cap = Number(flag("--cap", 16384));
const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: true });

const rows = db
  .prepare(
    `SELECT agent,
            COUNT(*)                              AS calls,
            SUM(completion_tokens >= ?)           AS capped,
            ROUND(AVG(completion_tokens))         AS avg_out,
            MAX(prompt_tokens)                    AS max_in,
            SUM(completion_tokens)                AS total_out
       FROM token_usage
      GROUP BY agent
      ORDER BY capped DESC, calls DESC`,
  )
  .all(cap);

if (!rows.length) {
  console.log("no model calls recorded yet");
  process.exit(0);
}

const pad = (v, n) => String(v ?? "").padStart(n);
console.log(`cap ${cap}\n`);
console.log("agent        calls   capped        avg out   max in    wasted");
for (const r of rows) {
  const pct = Math.round((r.capped / Math.max(1, r.calls)) * 100);
  console.log(
    `${String(r.agent).padEnd(12)}${pad(r.calls, 5)}${pad(r.capped, 8)} ${pad(`${pct}%`, 5)}${pad(r.avg_out, 10)}${pad(r.max_in, 9)}${pad(r.capped * cap, 10)}`,
  );
}

const calls = rows.reduce((n, r) => n + r.calls, 0);
const capped = rows.reduce((n, r) => n + r.capped, 0);
const wasted = capped * cap;
const out = rows.reduce((n, r) => n + r.total_out, 0);
console.log(
  `\n${capped} of ${calls} completions truncated (${Math.round((capped / calls) * 100)}%), ` +
    `about ${wasted.toLocaleString()} of ${out.toLocaleString()} output tokens spent on turns that did nothing.`,
);

/*
 * `max in` is here to kill the obvious wrong theory before somebody spends an
 * afternoon on it. The intuition is that the truncating agent is the one whose
 * history got too long — and it is not. Measured on seed 32: the lead capped on
 * every call with a 9k prompt while the interface, at 17k, capped on two of
 * seven. The roles that truncate are the ones with no file to write, not the
 * ones with the most to read.
 */
