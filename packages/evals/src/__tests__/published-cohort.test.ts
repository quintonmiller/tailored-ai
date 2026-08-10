import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COHORT_REMEDY, cohortStaleness, describeStaleness, isFresh } from "../cohort.js";
import { fingerprintScenario, loadScenarios } from "../schema.js";
import type { BenchmarkReport } from "../types.js";

/**
 * A published result must still describe the scenario it is published beside.
 *
 * Two halves, and the split is deliberate. The synthetic cases below prove the
 * comparison *catches* things; the pass over `results/` proves the committed
 * cohort is currently clean. Only the first would survive the cohort being
 * fresh — a check that just asserts "no problems today" passes whether or not
 * it works.
 *
 * This lives in the test suite rather than in `scripts/guard-benchmark-cohort.mjs`
 * because it needs the scenario loader, and that guard runs before the build.
 * The two are halves of one rule: the guard checks that published runs share
 * one clean commit, this checks that they still describe the current questions.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const resultsDir = join(packageRoot, "results");
const scenarioDir = join(packageRoot, "scenarios");

const CURRENT = { hash: "abc123", fingerprints: { a: "aaa", b: "bbb", c: "ccc" } };

function meta(over: Partial<BenchmarkReport["meta"]>): Pick<BenchmarkReport, "meta"> {
  return { meta: { scenarioSetHash: "abc123", ...over } as BenchmarkReport["meta"] };
}

describe("spotting a published run that no longer matches its scenarios", () => {
  it("names the scenario whose definition moved", () => {
    const report = meta({ scenarioFingerprints: { a: "aaa", b: "OLD" } });

    const staleness = cohortStaleness(report, CURRENT);

    expect(staleness.changed).toEqual(["b"]);
    expect(isFresh(staleness)).toBe(false);
    expect(describeStaleness("baseline-x.json", staleness)).toContain("whose definition has changed since: b");
  });

  it("is quiet when every covered scenario still matches", () => {
    expect(isFresh(cohortStaleness(meta({ scenarioFingerprints: { a: "aaa", b: "bbb" } }), CURRENT))).toBe(true);
  });

  it("ignores a scenario that has since been deleted", () => {
    // The question was withdrawn, which the page renders as absent. That is a
    // different thing from a score sitting under the wrong heading, and
    // flagging it would make deleting a scenario require a re-run.
    const staleness = cohortStaleness(meta({ scenarioFingerprints: { a: "aaa", gone: "zzz" } }), CURRENT);

    expect(isFresh(staleness)).toBe(true);
  });

  it("does not care that the run covered only part of the set", () => {
    // A `--filter`ed run records the digest of the whole set it loaded. Judging
    // it on scenarios it never ran is why the set hash alone is the wrong tool.
    expect(isFresh(cohortStaleness(meta({ scenarioFingerprints: { a: "aaa" } }), CURRENT))).toBe(true);
  });

  it("falls back to the set hash for a report written before fingerprints existed", () => {
    const staleness = cohortStaleness(meta({ scenarioSetHash: "a971de16862c" }), CURRENT);

    expect(staleness.setHashMoved).toEqual({ recorded: "a971de16862c", current: "abc123" });
    expect(describeStaleness("old.json", staleness)).toContain("predates per-scenario digests");
  });

  it("passes an old report whose set hash still matches", () => {
    expect(isFresh(cohortStaleness(meta({ scenarioSetHash: "abc123" }), CURRENT))).toBe(true);
  });
});

describe("the committed cohort", () => {
  const published = existsSync(resultsDir)
    ? readdirSync(resultsDir).filter((f) => f.startsWith("baseline-") && f.endsWith(".json"))
    : [];

  it("still describes the current scenarios", () => {
    if (!published.length) return; // Nothing published; the shell guard says so too.

    const current = loadScenarios(scenarioDir);
    const problems = published
      .map((file) => {
        const report = JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as BenchmarkReport;
        const staleness = cohortStaleness(report, current);
        return isFresh(staleness) ? null : describeStaleness(file, staleness);
      })
      .filter(Boolean);

    // Appended rather than joined: with a single problem a separator never
    // renders, and the remedy is the half of the message worth reading.
    expect(problems.length ? `${problems.join("\n")}\n  ${COHORT_REMEDY}` : "").toBe("");
  });

  it("records a fingerprint for every scenario it scored", () => {
    for (const file of published) {
      const report = JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as BenchmarkReport;
      if (!report.meta.scenarioFingerprints) continue; // Older report; covered above.
      for (const scenario of report.scenarios) {
        expect(report.meta.scenarioFingerprints[scenario.id], `${file} → ${scenario.id}`).toBeTruthy();
      }
    }
  });
});

describe("scenario fingerprints", () => {
  it("are distinct per scenario and cover the whole set", () => {
    const { scenarios, fingerprints } = loadScenarios(scenarioDir);

    expect(Object.keys(fingerprints)).toHaveLength(scenarios.length);
    expect(new Set(Object.values(fingerprints)).size).toBe(scenarios.length);
  });

  it("track what a scenario measures, not how it is annotated", () => {
    // The rule the set digest already follows, per scenario: editing an
    // `intent` or adding a `knownGap` must not invalidate every published run,
    // or nobody will annotate anything.
    const { scenarios, fingerprints } = loadScenarios(scenarioDir);
    const subject = scenarios[0];

    const annotated = fingerprintScenario({ ...subject, intent: "reworded", knownGap: "#999 — new note" });

    expect(annotated).toBe(fingerprints[subject.id]);
  });
});
