#!/usr/bin/env node
/*
 * Every game the jam has ever made, in one column, so sameness is visible.
 *
 * The single most useful thing anybody did to this benchmark was read fifteen
 * pitches next to each other. Individually each entry looked fine; stacked, two
 * teams had independently produced a game called SEAM for two different themes,
 * and every pitch began "you are the". No metric in `metrics()` reports that —
 * `filesPresent` and `linesInWorkspace` are identical whether the team built the
 * same game again or something nobody has seen.
 *
 * So this is deliberately not a score. It prints what a person needs in order to
 * notice a pattern, and the diversifier next to it, because the question after
 * 2026-08-23 is whether varying the *form* constraint actually varies the game.
 *
 * Usage:
 *   node scripts/jam-shelf.mjs            # every entry
 *   node scripts/jam-shelf.mjs --since 30 # seeds 30 and up
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const home = process.env.ARCADE_HOME ?? join(homedir(), ".tai-arcade");
const dbPath = flag("--db") ?? join(home, "arcade.db");
if (!existsSync(dbPath)) {
  console.error(`no arcade database at ${dbPath}`);
  process.exit(1);
}

const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: true });

// `diversifier` is an additive column; a database written before 2026-08-23 does
// not have it, and reading it would throw rather than return null.
const columns = new Set(db.prepare("PRAGMA table_info(entries)").all().map((c) => c.name));
const div = columns.has("diversifier") ? "diversifier" : "NULL AS diversifier";

const since = Number(flag("--since") ?? Number.NEGATIVE_INFINITY);
const rows = db
  .prepare(`SELECT seed, theme, ${div}, title, tagline, genre, created_at FROM entries ORDER BY seed, created_at`)
  .all()
  .filter((r) => r.title && (r.seed ?? Number.NEGATIVE_INFINITY) >= since);

if (!rows.length) {
  console.log("nothing on the shelf yet");
  process.exit(0);
}

const pad = (v, n) => String(v ?? "").padEnd(n).slice(0, n);
console.log(
  `${pad("seed", 5)} ${pad("theme", 20)} ${pad("diversifier", 15)} ${pad("title", 15)} ${pad("genre", 12)} pitch`,
);
console.log("-".repeat(120));
for (const r of rows) {
  console.log(
    `${pad(r.seed, 5)} ${pad(r.theme, 20)} ${pad(r.diversifier ?? "—", 15)} ${pad(r.title, 15)} ${pad(r.genre, 12)} ${String(r.tagline ?? "").replace(/\s+/g, " ").slice(0, 60)}`,
  );
}

/*
 * The two tells of the collapse, counted rather than eyeballed.
 *
 * Neither is a quality measure and neither should become one. They are here
 * because they are the exact shape the fifteen-run collapse took, so a cohort
 * that still trips them has not moved, whatever else improved.
 */
const youAre = rows.filter((r) => /^you are\b|\byou are the\b/i.test(r.tagline ?? "")).length;
const oneWord = rows.filter((r) => /^\S+$/.test((r.title ?? "").trim())).length;
const titles = rows.map((r) => (r.title ?? "").trim().toUpperCase());
const repeated = [...new Set(titles.filter((t, i) => titles.indexOf(t) !== i))];

console.log(`\n${rows.length} entries`);
console.log(`  ${youAre} pitched as "you are the ..."  (${Math.round((youAre / rows.length) * 100)}%)`);
console.log(`  ${oneWord} single-word titles           (${Math.round((oneWord / rows.length) * 100)}%)`);
console.log(`  repeated titles: ${repeated.length ? repeated.join(", ") : "none"}`);
