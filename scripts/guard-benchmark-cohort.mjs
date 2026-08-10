#!/usr/bin/env node
/**
 * The published benchmark runs must be a *cohort*: one commit, clean tree, one
 * file per model.
 *
 * A score is only a statement about the code if every model answered the same
 * code. The site once published a 44-scenario run beside a 58-scenario one and
 * ranked the smaller model above the larger, purely because it had never sat the
 * harder categories — and both runs recorded a commit that was not on `main`,
 * from a working tree nobody can reconstruct. Neither fact was visible in the
 * number.
 *
 * So the rule is checked where it can be enforced rather than remembered:
 *
 *   - every `results/baseline-*.json` shares one `gitSha`
 *   - none of them was produced from a dirty tree
 *   - that SHA is reachable from `main`, so a reader can check it out
 *
 * Older cohorts live under `results/history/` and are deliberately *not*
 * checked. They are the record of what was true then, including the parts that
 * were sloppy; rewriting them to satisfy a rule invented later would destroy the
 * only evidence of how the benchmark has changed.
 *
 * The other half of the rule — that a published run still describes the
 * scenarios it is rendered beside — is
 * `packages/evals/src/__tests__/published-cohort.test.ts`, because it needs the
 * scenario loader and this runs before the build. This file used to read
 * `meta.scenarioSetHash` into a variable and never compare it, which is exactly
 * the gap that let a stale 0% sit on a public page under a corrected intent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(repoRoot, "packages/evals/results");

function reachableFromMain(sha) {
  for (const ref of ["origin/main", "main"]) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, ref], { cwd: repoRoot, stdio: "ignore" });
      return true;
    } catch {
      // Not an ancestor of this ref, or the ref does not exist here. Try the next.
    }
  }
  return false;
}

if (!existsSync(resultsDir)) {
  console.log("guard-benchmark-cohort: no results directory, nothing to check.");
  process.exit(0);
}

const files = readdirSync(resultsDir).filter((f) => f.startsWith("baseline-") && f.endsWith(".json"));

if (files.length === 0) {
  console.log("guard-benchmark-cohort: no published baselines, nothing to check.");
  process.exit(0);
}

const runs = files.map((file) => {
  const meta = JSON.parse(readFileSync(join(resultsDir, file), "utf8")).meta ?? {};
  return { file, sha: meta.gitSha, dirty: !!meta.gitDirty, model: meta.model };
});

const problems = [];

const shas = [...new Set(runs.map((r) => r.sha))];
if (shas.length > 1) {
  problems.push(
    `the published runs come from ${shas.length} different commits, so their scores are not a statement about one version of the code:\n` +
      runs.map((r) => `      ${r.file}  ${r.sha}`).join("\n") +
      "\n    Re-run the whole set on one commit, or move the older ones to results/history/.",
  );
}

const dirty = runs.filter((r) => r.dirty);
if (dirty.length) {
  problems.push(
    `produced from a working tree with uncommitted changes, so the commit they name does not describe what actually ran:\n` +
      dirty.map((r) => `      ${r.file}  ${r.sha} +uncommitted`).join("\n") +
      "\n    Re-run from a clean checkout.",
  );
}

// Advisory rather than fatal: a fresh clone in CI may not have the ref, and a
// baseline committed in the same PR that produced it is not yet on main.
const unreachable = shas.filter((sha) => sha && !reachableFromMain(sha));

const models = runs.map((r) => r.model);
const duplicated = models.filter((m, i) => models.indexOf(m) !== i);
if (duplicated.length) {
  problems.push(
    `more than one published run for the same model (${[...new Set(duplicated)].join(", ")}). ` +
      "A cohort is one run per model; keep the newest and archive the rest.",
  );
}

if (problems.length === 0) {
  const label = shas[0] ? ` at ${shas[0]}` : "";
  console.log(`guard-benchmark-cohort: ${runs.length} published run(s)${label}, one cohort, clean.`);
  if (unreachable.length) {
    console.log(`  note: ${unreachable.join(", ")} is not reachable from main here — expected inside its own PR.`);
  }
  process.exit(0);
}

console.error(`\nguard-benchmark-cohort: the published benchmark runs are not a cohort.\n`);
for (const problem of problems) console.error(`  - ${problem}\n`);
console.error("Published runs must share one commit and a clean tree, so a reader can reproduce them.");
console.error("Older runs belong in packages/evals/results/history/, which is not checked.\n");
process.exit(1);
