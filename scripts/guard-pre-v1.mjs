#!/usr/bin/env node
// Pre-V1 release guard.
//
// The project deliberately stays on 0.x until a maintainer cuts a real V1
// (see docs/publishing.md, "Pre-1.0 versioning rule"). This guard makes that
// intent enforceable instead of conventional: it fails CI before anything can
// escape 0.x, so a stray changeset — or an unattended agent — cannot ship a
// 1.0.0 the way it did on 2026-06-09.
//
// Two checks, both offline:
//   1. Every publishable (non-private) package.json version must be < 1.0.0.
//   2. Every .changeset/*.md must bump @tailored-ai/* packages `patch` only.
//      Pre-1.0 a `minor`/`major` on a fixed-group / peer-depended package
//      escalates the whole locked group to 1.0.0 — that is the incident.
//
// When the deliberate V1 lands, relax/remove this guard as part of the cut.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

/** Recursively collect package.json paths under a dir, skipping node_modules. */
function findPackageJsons(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) findPackageJsons(full, acc);
    else if (ent.name === "package.json") acc.push(full);
  }
  return acc;
}

// --- Check 1: no publishable package may be >= 1.0.0 ---
for (const file of findPackageJsons(join(root, "packages"))) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if (pkg.private || !pkg.name || !pkg.version) continue;
  const major = Number(String(pkg.version).split(".")[0]);
  if (!Number.isInteger(major)) {
    errors.push(`${pkg.name}: unparseable version "${pkg.version}"`);
  } else if (major >= 1) {
    errors.push(
      `${pkg.name}@${pkg.version}: version >= 1.0.0 — the project stays on 0.x until a deliberate V1.`,
    );
  }
}

// --- Check 2: every changeset bump must be `patch` ---
let changesetFiles = [];
try {
  changesetFiles = readdirSync(join(root, ".changeset")).filter(
    (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md",
  );
} catch {
  /* no .changeset dir — nothing to check */
}
for (const f of changesetFiles) {
  const body = readFileSync(join(root, ".changeset", f), "utf8");
  const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!front) continue;
  for (const line of front[1].split(/\r?\n/)) {
    const m = line.match(/^\s*["']?(@tailored-ai\/[^"':]+)["']?\s*:\s*(\w+)/);
    if (m && m[2] !== "patch") {
      errors.push(
        `.changeset/${f}: "${m[1]}: ${m[2]}" — pre-V1 every bump must be \`patch\` ` +
          `(a minor/major escalates the fixed group to 1.0.0).`,
      );
    }
  }
}

if (errors.length) {
  console.error("\n✖ pre-V1 release guard failed:\n");
  for (const e of errors) console.error("  - " + e);
  console.error(
    "\nThe project intentionally stays on 0.x. Keep every publishable version " +
      "< 1.0.0 and mark every changeset `patch`. See docs/publishing.md.\n",
  );
  process.exit(1);
}

console.log(
  "✓ pre-V1 guard: all publishable versions < 1.0.0 and all changesets are patch.",
);
