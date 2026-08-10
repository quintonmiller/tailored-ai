#!/usr/bin/env node
/**
 * Confirm every publishable package actually reached npm, and record what
 * shipped as a git tag and a GitHub release.
 *
 * Why this exists rather than `changesets/action`'s own machinery: that action
 * learns what it published by parsing `changeset publish`'s stdout. This repo
 * publishes with `pnpm publish -r`, because pnpm rewrites `workspace:` ranges
 * into real versions at pack time and `changeset publish` does not — a
 * manifest published with `workspace:*` intact installs as garbage. So the
 * action's `published` / `publishedPackages` outputs are always empty here.
 *
 * Two things depended on those outputs and therefore never ran:
 *
 *   1. The registry verification step, whose own comment said it existed to
 *      catch "`pnpm publish` exits 0 but the registry never received a
 *      tarball". It was gated on `published == 'true'`, so it could only run
 *      when a publish had definitely succeeded — never in the case it was
 *      written for. 0.1.10 shipped all 13 packages with that step skipped, and
 *      a publish that shipped nothing would have gone green the same way.
 *   2. `createGithubReleases`, so no tag or release was created. Before
 *      0.1.10 the newest tag in the repo was 0.1.1, from two months earlier —
 *      nothing in git recorded which commit any release was cut from.
 *
 * This reads the workspace instead of a publish log, so it says the same thing
 * whether the publish ran a second ago or last month, and it is safe to re-run:
 * verification is a registry read, and tagging skips what already exists.
 *
 *   node scripts/verify-release.mjs          # verify only — safe anywhere
 *   node scripts/verify-release.mjs --tag    # verify, then tag and release
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = process.argv.includes("--tag");

/** Every non-private workspace package — the exact set `pnpm publish -r` ships. */
function publishable() {
  const found = [];
  for (const dir of readdirSync("packages")) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8"));
    } catch {
      continue;
    }
    if (pkg.name && pkg.private !== true) found.push({ dir, name: pkg.name, version: pkg.version });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * GitHub rejects a release body over 125,000 characters. Not a theoretical
 * limit: core's 0.1.10 section is 165KB, because it carries 127 changesets.
 * Leave room for the trailing pointer.
 */
const MAX_NOTES = 120_000;

/** The version's own CHANGELOG section, so a release says what changed. */
function releaseNotes({ dir, name, version }) {
  const source = `https://github.com/quintonmiller/tailored-ai/blob/main/packages/${dir}/CHANGELOG.md`;
  let changelog;
  try {
    changelog = readFileSync(`packages/${dir}/CHANGELOG.md`, "utf8");
  } catch {
    return `\`${name}@${version}\``;
  }
  const start = changelog.indexOf(`\n## ${version}\n`);
  if (start === -1) return `\`${name}@${version}\`\n\n[Full changelog](${source})`;

  const rest = changelog.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const section = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (section.length <= MAX_NOTES) return section;

  // Cut at an entry boundary rather than mid-sentence: changesets writes one
  // `- <sha>: ` bullet per change, so the last one that fits is a clean stop.
  const head = section.slice(0, MAX_NOTES);
  const cut = head.lastIndexOf("\n- ");
  return `${(cut === -1 ? head : head.slice(0, cut)).trimEnd()}\n\n_Truncated — GitHub caps a release body at 125,000 characters. [Full changelog](${source})._`;
}

function onRegistry(name, version) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() === version;
  } catch {
    // `npm view` exits non-zero for an unpublished version as well as for a
    // network failure. Both mean "cannot confirm it shipped", which is the
    // answer this script owes its caller either way.
    return false;
  }
}

const packages = publishable();
if (packages.length === 0) {
  console.error("[release] FAIL: found no publishable packages under packages/");
  process.exit(1);
}

const missing = [];
for (const pkg of packages) {
  const ok = onRegistry(pkg.name, pkg.version);
  console.log(`[release] ${ok ? "OK  " : "MISS"} ${pkg.name}@${pkg.version}`);
  if (!ok) missing.push(pkg);
}

if (missing.length > 0) {
  console.error(
    `\n[release] FAIL: ${missing.length} of ${packages.length} package(s) are not on the registry at the version this checkout claims:`,
  );
  for (const pkg of missing) console.error(`  ${pkg.name}@${pkg.version}`);
  console.error("\nThe publish step may have exited 0 without shipping. Re-run it; `pnpm publish` is idempotent.");
  process.exit(1);
}
console.log(`\n[release] All ${packages.length} publishable packages are on the registry at their workspace version.`);

if (!TAG) process.exit(0);

// ---------------------------------------------------------------- tag + release

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

const notesDir = mkdtempSync(join(tmpdir(), "tai-release-notes-"));
let created = 0;
let existed = 0;

for (const pkg of packages) {
  const tag = `${pkg.name}@${pkg.version}`;
  let tagged = true;
  try {
    git("rev-parse", "-q", "--verify", `refs/tags/${tag}`);
  } catch {
    tagged = false;
  }
  if (tagged) {
    console.log(`[release] ${tag} already tagged`);
    existed++;
    continue;
  }

  git("tag", "-a", tag, "-m", tag);
  git("push", "origin", tag);

  const notesFile = join(notesDir, `${pkg.dir}.md`);
  writeFileSync(notesFile, releaseNotes(pkg));
  try {
    execFileSync("gh", ["release", "create", tag, "--title", tag, "--notes-file", notesFile], { stdio: "inherit" });
  } catch (err) {
    // The tag is pushed and the package is on npm; a release page that failed
    // to render is worth reporting but not worth failing a shipped release
    // over. Say so rather than swallowing it.
    console.error(`[release] WARN: tag ${tag} pushed but the GitHub release was not created: ${err.message}`);
  }
  created++;
}

console.log(`\n[release] ${created} tag(s) created, ${existed} already present.`);
