#!/usr/bin/env node
// Prune development-time optional peers from a `pnpm deploy --prod` tree.
//
// `pnpm deploy --prod` drops devDependencies. It does *not* drop
// peerDependencies marked `optional: true` — those stay in the resolved graph
// and get linked into the deployed tree, dragging their transitive closure
// with them. For the self-host image that was ~70 MB of vitest (vite, rollup,
// esbuild x2, lightningcss x2) plus Playwright's driver, none of it reachable
// from the runtime entrypoint. See issue #375.
//
// The rule this encodes, so it needs no hand-kept list of package names:
//
//   An optional peerDependency that is ALSO a devDependency of the same
//   package is a development-time integration. The package resolves it from
//   its own devDependencies during development; a production deploy has
//   dropped those, so nothing in a production tree can legitimately want it.
//
// A genuine runtime optional is declared in `optionalDependencies` and is
// untouched by this script.
//
// Applied ONLY to first-party `@tailored-ai/*` manifests, because the rule
// holds for manifests this repo owns and can verify against their import
// sites, and does not hold in general. `ajv-formats` declares `ajv` as an
// optional peer and a devDependency, and needs it at runtime — the shape is
// identical, the meaning is the opposite. Third-party packages are still
// reclaimed, just transitively: dropping vitest makes vite, rollup, esbuild
// and lightningcss unreachable, and phase 2 collects them.
//
// Usage: node scripts/prune-dev-peers.mjs <deploy-dir> [--dry-run]
//
// Two phases: unlink the dev peers, then garbage-collect every .pnpm entry
// that is no longer reachable from the deploy root. The GC is what actually
// reclaims the space — removing one symlink to vitest frees nothing until the
// 200-odd packages behind it become unreachable too.

// `unlinkSync`, not `rmSync`, for the links: rmSync resolves a symlink-to-dir
// and refuses with EISDIR, which would delete nothing and fail the build.
import {
  readFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const dryRun = process.argv.includes("--dry-run");
const deployDir = resolve(args[0] ?? ".");
const pnpmDir = join(deployDir, "node_modules", ".pnpm");

if (!existsSync(pnpmDir)) {
  console.error(`✖ prune-dev-peers: no node_modules/.pnpm under ${deployDir}`);
  console.error("  Expected the output of `pnpm deploy --legacy`.");
  process.exit(1);
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Every real (non-symlinked) package in the tree, paired with the directory
 * its dependencies are linked into.
 *
 * In pnpm's layout a package's deps are *siblings* of the package, not nested
 * inside it: `.pnpm/<entry>/node_modules/` holds both the real package and
 * symlinks to everything it depends on. Node's resolver walks up from the
 * package dir and finds them there.
 */
function packages() {
  const found = [];
  if (existsSync(join(deployDir, "package.json"))) {
    found.push({ dir: deployDir, depsDir: join(deployDir, "node_modules") });
  }
  for (const entry of readdirSync(pnpmDir)) {
    if (entry === "node_modules" || entry === "lock.yaml") continue;
    const nm = join(pnpmDir, entry, "node_modules");
    if (!existsSync(nm)) continue;
    for (const name of readdirSync(nm)) {
      if (name.startsWith(".")) continue;
      const p = join(nm, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (name.startsWith("@")) {
        // scope dir — the real package is one level down
        for (const sub of readdirSync(p)) {
          const q = join(p, sub);
          if (lstatSync(q).isSymbolicLink()) continue;
          found.push({ dir: q, depsDir: nm });
        }
      } else {
        found.push({ dir: p, depsDir: nm });
      }
    }
  }
  return found;
}

const FIRST_PARTY = /^@tailored-ai\//;

/** Optional peers that are also devDependencies of the same first-party package. */
function devPeersOf(pkg) {
  if (!pkg?.name || !FIRST_PARTY.test(pkg.name)) return [];
  if (!pkg.peerDependenciesMeta || !pkg.devDependencies) return [];
  return Object.entries(pkg.peerDependenciesMeta)
    .filter(([name, meta]) => meta?.optional === true && pkg.devDependencies[name])
    .map(([name]) => name);
}

// ── Phase 1: unlink ─────────────────────────────────────────────────────────
const unlinked = [];
// Under --dry-run nothing is removed, so the reachability walk below has to be
// told which links to pretend are gone. Otherwise a dry run always reports
// zero collectable packages, which is the number that matters.
const severed = new Set();
for (const { dir, depsDir } of packages()) {
  const pkg = readJson(join(dir, "package.json"));
  if (!pkg) continue;
  for (const peer of devPeersOf(pkg)) {
    const link = join(depsDir, peer);
    let st;
    try {
      st = lstatSync(link);
    } catch {
      continue; // already absent — this run is idempotent
    }
    if (!st.isSymbolicLink()) continue;
    unlinked.push(`${pkg.name} -> ${peer}`);
    severed.add(link);
    if (!dryRun) unlinkSync(link);
  }
}

// ── Phase 2: garbage-collect what became unreachable ────────────────────────
// Walk the symlink graph outward from the deploy root. Anything in .pnpm that
// the walk never reaches is dead weight.
const reachable = new Set();
const queue = [join(deployDir, "node_modules")];

function scan(nmDir) {
  let names;
  try {
    names = readdirSync(nmDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === ".pnpm" || name === ".bin" || name.startsWith(".")) continue;
    const p = join(nmDir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (name.startsWith("@") && st.isDirectory() && !st.isSymbolicLink()) {
      scan(p); // scope dir — descend one level
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    if (severed.has(p)) continue; // pruned above, or would have been under --dry-run
    const target = resolve(nmDir, readlinkSync(p));
    const marker = `${pnpmDir}/`;
    if (!target.startsWith(marker)) continue;
    const entry = target.slice(marker.length).split("/node_modules/")[0];
    if (reachable.has(entry)) continue;
    reachable.add(entry);
    queue.push(join(pnpmDir, entry, "node_modules"));
  }
}

while (queue.length) scan(queue.shift());

const removed = [];
for (const entry of readdirSync(pnpmDir)) {
  if (entry === "node_modules" || entry === "lock.yaml") continue;
  if (reachable.has(entry)) continue;
  removed.push(entry);
  if (!dryRun) rmSync(join(pnpmDir, entry), { recursive: true, force: true });
}

// Collecting an entry orphans every link that pointed at it — pnpm's hoist
// directory (.pnpm/node_modules) and the .bin dirs both accumulate these.
//
// Only links into an entry this run removed are cleaned. A blanket
// "unlink anything dangling" sweep would also take the @tailored-ai/
// trusted-actions bin link, which docker/tai/Dockerfile keeps on purpose so
// the image matches the published package's layout.
const removedSet = new Set(removed);
const pointsAtRemoved = (linkPath) => {
  let target;
  try {
    target = resolve(join(linkPath, ".."), readlinkSync(linkPath));
  } catch {
    return false;
  }
  const marker = `${pnpmDir}/`;
  if (!target.startsWith(marker)) return false;
  return removedSet.has(target.slice(marker.length).split("/node_modules/")[0]);
};

let orphanLinks = 0;
function sweepLinks(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      if (!pointsAtRemoved(p)) continue;
      orphanLinks++;
      if (!dryRun) unlinkSync(p);
    } else if (st.isDirectory() && (name.startsWith("@") || name === ".bin")) {
      sweepLinks(p); // scope dirs and bin dirs hold links too
    }
  }
}

sweepLinks(join(deployDir, "node_modules"));
sweepLinks(join(pnpmDir, "node_modules"));
for (const entry of readdirSync(pnpmDir)) {
  if (entry === "node_modules" || entry === "lock.yaml") continue;
  sweepLinks(join(pnpmDir, entry, "node_modules"));
}

// ── Report ──────────────────────────────────────────────────────────────────
const label = dryRun ? "would prune" : "pruned";
if (!unlinked.length) {
  console.log("✓ prune-dev-peers: no development-time optional peers in the deploy tree.");
} else {
  console.log(`✓ prune-dev-peers: ${label} ${unlinked.length} dev-time optional peer link(s):`);
  for (const u of unlinked) console.log(`    ${u}`);
  console.log(`  ${label} ${removed.length} now-unreachable package(s) from .pnpm/`);
  console.log(`  ${label} ${orphanLinks} link(s) left pointing at them`);
}
console.log(`  tree: ${relative(process.cwd(), deployDir) || deployDir}`);
