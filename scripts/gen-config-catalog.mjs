#!/usr/bin/env node
/**
 * Generate `docs/config-catalog.md` from `DEFAULT_CONFIG`, and say which fields
 * nothing reads.
 *
 * This exists for one recurring defect: a key lands in `AgentConfig`, gets a
 * default, gets documented, gets set by a user — and nothing ever consumes it.
 * It is indistinguishable from a working feature, because the only symptom is
 * that behaviour did not change. Two settings shipped that way (#335), and
 * per-agent shape checks have been inert more than once.
 *
 * The catalog makes the whole surface visible in one file, with a read count
 * beside each field. **A zero is the finding.** The count is a heuristic, not a
 * proof: it matches a leaf key used as a property access or a quoted key across
 * `packages/<pkg>/src`, so a field reached only through dynamic indexing can
 * read as zero when it is fine, and a common word like `path` will match code
 * that has nothing to do with config. Treat a zero as "go and look", not as a
 * verdict — which is why this reports rather than fails.
 *
 * What DOES fail the build is drift: `--check` compares the generated catalog
 * to the committed one, so a config change that skips the regeneration is
 * caught in CI rather than discovered months later.
 *
 *   node scripts/gen-config-catalog.mjs           # write docs/config-catalog.md
 *   node scripts/gen-config-catalog.mjs --check   # fail if it is stale
 *
 * Requires a build (`pnpm run build`) — it imports the compiled config module
 * rather than re-parsing the TypeScript, so the catalog always describes what
 * actually ships.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "config-catalog.md");
const CHECK = process.argv.includes("--check");

const { DEFAULT_CONFIG } = await import(
  new URL("../packages/core/dist/config.js", import.meta.url).href
).catch((err) => {
  console.error("gen-config-catalog: could not import the built config module.");
  console.error("Run `pnpm run build` first.\n");
  throw err;
});

/**
 * Collect every source file once. Read-site counting runs this list per field,
 * so re-reading from disk each time would make the script quadratic in IO for
 * no benefit.
 *
 * `config.ts` is excluded on purpose: it is where fields are *defined*, and
 * counting the definition as a read would hide exactly the fields this is
 * looking for. Tests are excluded for the same reason — a field read only by
 * its own test is still a field production ignores.
 */
function sourceFiles() {
  const files = [];
  const skip = new Set(["node_modules", "dist", "ui-dist", "__tests__", ".turbo", "coverage"]);
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) files.push(full);
    }
  };
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // Package without a src/ directory (site, ui-only). Nothing to scan.
    }
  }
  const configTs = join(ROOT, "packages", "core", "src", "config.ts");
  return files.filter((f) => f !== configTs).map((f) => ({ path: f, text: readFileSync(f, "utf8") }));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Files that reference the field by its dotted tail (`server.port`). Much
 * stricter than the leaf alone, and the column that actually distinguishes
 * "read as config" from "that word appears somewhere".
 */
function pathCount(files, path) {
  const segments = path.split(".");
  const tail = segments.length > 1 ? segments.slice(-2) : segments;
  // Optional chaining is the dominant access pattern for config in this
  // codebase (`config.tools.memory?.enabled`), so a literal dotted match would
  // report almost everything as unread. Tolerate `?.` between segments.
  const re = new RegExp(tail.map(escape).join("\\??\\."));
  let n = 0;
  for (const f of files) {
    if (re.test(f.text)) n++;
  }
  return n;
}

function readCount(files, leaf) {
  const property = new RegExp(`\\.${escape(leaf)}\\b`);
  const quoted = new RegExp(`["'\`]${escape(leaf)}["'\`]`);
  let n = 0;
  for (const f of files) {
    if (property.test(f.text) || quoted.test(f.text)) n++;
  }
  return n;
}

/** Flatten DEFAULT_CONFIG into dotted paths. */
function flatten(value, prefix, out) {
  const entries = Object.entries(value);
  if (entries.length === 0 && prefix) {
    out.push({ path: prefix, leaf: prefix.split(".").pop(), type: "object", def: "{}" });
    return;
  }
  for (const [key, v] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, path, out);
    } else {
      out.push({
        path,
        leaf: key,
        type: Array.isArray(v) ? "array" : v === null ? "null" : typeof v,
        def: render(v),
      });
    }
  }
}

function render(v) {
  if (v === null) return "`null`";
  if (Array.isArray(v)) return v.length === 0 ? "`[]`" : `\`${JSON.stringify(v).slice(0, 60)}\``;
  if (typeof v === "string") {
    const trimmed = v.length > 60 ? `${v.slice(0, 57)}…` : v;
    return v === "" ? '`""`' : `\`${trimmed.replace(/\|/g, "\\|").replace(/\n/g, " ")}\``;
  }
  return `\`${String(v)}\``;
}

const fields = [];
flatten(DEFAULT_CONFIG, "", fields);
const files = sourceFiles();
for (const f of fields) {
  f.reads = readCount(files, f.leaf);
  f.pathReads = pathCount(files, f.path);
}

// Only flag when BOTH signals are silent. A zero Path alone is common and
// benign — `cfg?.tickSeconds`, `opts.shellTimeoutMs` and `config.debounceMs`
// are all real reads through a destructured or aliased binding — and a list
// that is mostly false positives is a list nobody reads twice.
const unread = fields.filter((f) => f.reads === 0 && f.pathReads === 0);
const sections = new Map();
for (const f of fields) {
  const top = f.path.split(".")[0];
  if (!sections.has(top)) sections.set(top, []);
  sections.get(top).push(f);
}

const lines = [];
lines.push("<!-- Generated by scripts/gen-config-catalog.mjs — do not edit by hand.");
lines.push("     Regenerate with `pnpm run gen:config-catalog`; CI verifies freshness. -->");
lines.push("");
lines.push("# Config catalog");
lines.push("");
lines.push(
  "Every field in `DEFAULT_CONFIG`, which [CLAUDE.md](../CLAUDE.md) makes the single",
  "source of truth for defaults. Generated, so it cannot drift from the code.",
);
lines.push("");
lines.push("**Reads** counts source files under `packages/<pkg>/src` that mention the leaf");
lines.push("key as a property access or a quoted key. **Path** is the stricter signal: files");
lines.push("containing the dotted tail (`server.port`). Both exclude `config.ts` itself and tests.");
lines.push("Neither is a proof. A common word matches unrelated code, and a Path of 0 with");
lines.push("a non-zero Reads usually just means the field is destructured or aliased at the");
lines.push("call site. A field with **0 in both** is the one to go and look at: a field");
lines.push("nothing consumes is indistinguishable from a working feature, because the only");
lines.push("symptom is that behaviour never changed (#335).");
lines.push("");
lines.push(`Fields: **${fields.length}** · with no read site found: **${unread.length}**`);
lines.push("");

if (unread.length > 0) {
  lines.push("## No read site found");
  lines.push("");
  lines.push("Nothing matched either signal. Verify before concluding — but this is the");
lines.push("shape of a field that parses, documents, and does nothing.");
  lines.push("");
  lines.push("| Field | Default | Reads | Path |");
  lines.push("| --- | --- | --- | --- |");
  for (const f of unread) lines.push(`| \`${f.path}\` | ${f.def} | ${f.reads} | ${f.pathReads} |`);
  lines.push("");
}

lines.push("## Every field");
lines.push("");
for (const [section, list] of [...sections.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`### \`${section}\``);
  lines.push("");
  lines.push("| Field | Type | Default | Reads | Path |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const f of list.sort((a, b) => a.path.localeCompare(b.path))) {
    const flag = (n) => (n === 0 ? "**0**" : String(n));
    lines.push(`| \`${f.path}\` | ${f.type} | ${f.def} | ${flag(f.reads)} | ${flag(f.pathReads)} |`);
  }
  lines.push("");
}

const generated = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;

if (CHECK) {
  let committed = "";
  try {
    committed = readFileSync(OUT, "utf8");
  } catch {
    console.error("gen-config-catalog: docs/config-catalog.md is missing. Run `pnpm run gen:config-catalog`.");
    process.exit(1);
  }
  if (committed !== generated) {
    console.error("gen-config-catalog: docs/config-catalog.md is stale.");
    console.error("A config field changed without the catalog being regenerated.");
    console.error("Run `pnpm run gen:config-catalog` and commit the result.");
    process.exit(1);
  }
  console.log(`gen-config-catalog: catalog is current (${fields.length} fields, ${unread.length} unmatched).`);
} else {
  writeFileSync(OUT, generated);
  console.log(`gen-config-catalog: wrote docs/config-catalog.md — ${fields.length} fields, ${unread.length} unmatched.`);
}
