/**
 * Reading published benchmark runs at build time.
 *
 * The site is a static export, so everything here runs once during `next build`
 * and nothing reaches the browser except the values a page actually renders.
 * Two directories feed it, and the split matters:
 *
 *   `packages/evals/results/*.json`    — what a run produced. A record: never
 *                                        edited, never re-interpreted.
 *   `packages/evals/scenarios/*.yaml`  — what the scenarios currently say. Read
 *                                        for annotations only, so that closing
 *                                        a gap updates every page that mentions
 *                                        it without re-running anything.
 *
 * Which runs get published is decided by `packages/evals/.gitignore`, which
 * tracks `results/baseline-work-*.json` and ignores everything else — so a run
 * reaches this page by being committed, not by existing on somebody's disk.
 * The deployed site is built by CI from a clean checkout, which is what makes
 * that true rather than merely intended. A local `next build` will happily show
 * your own uncommitted runs, and that is the point of running one.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { BenchmarkReport, PublishedRun, RunSummary } from "./bench-types";

/**
 * `next build` runs with the package directory as cwd, under both
 * `pnpm --filter @tailored-ai/site build` and `pnpm -r run build`.
 */
const EVALS_DIR = resolve(process.cwd(), "../evals");
const RESULTS_DIR = join(EVALS_DIR, "results");
const SCENARIOS_DIR = join(EVALS_DIR, "scenarios");

function slugOf(filename: string): string {
  return filename.replace(/\.json$/, "");
}

/** `baseline-work-luna` → `work-luna`. The prefix is on every file and carries nothing. */
function labelOf(slug: string): string {
  return slug.replace(/^baseline-/, "");
}

/**
 * Only the fields a page would otherwise render as `undefined`. A report that
 * fails this is a broken file, and a broken file should stop the build rather
 * than publish a page full of blanks.
 */
function validate(file: string, report: BenchmarkReport): void {
  const missing: string[] = [];
  if (!report.meta?.model) missing.push("meta.model");
  if (!report.meta?.scenarioSetHash) missing.push("meta.scenarioSetHash");
  if (typeof report.meta?.repeats !== "number") missing.push("meta.repeats");
  if (typeof report.score?.overall !== "number") missing.push("score.overall");
  if (!Array.isArray(report.scenarios)) missing.push("scenarios");
  if (missing.length) throw new Error(`${file}: not a benchmark report — missing ${missing.join(", ")}`);
}

function readReport(file: string): BenchmarkReport {
  const report = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as BenchmarkReport;
  validate(file, report);
  return report;
}

function reportFiles(): string[] {
  if (!existsSync(RESULTS_DIR)) {
    throw new Error(
      `no benchmark results at ${RESULTS_DIR}. The site reads them from the evals package; ` +
        "if that package moved, update EVALS_DIR in src/lib/bench.ts.",
    );
  }
  return readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/**
 * Scenario id → why it is expected to be red.
 *
 * Read from the current scenario files rather than from the report, so a gap
 * that has since been closed stops being advertised on every historical page.
 * A report predating the field is annotated correctly for the same reason.
 */
export function knownGaps(): Map<string, string> {
  const gaps = new Map<string, string>();
  if (!existsSync(SCENARIOS_DIR)) return gaps;
  for (const file of readdirSync(SCENARIOS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const parsed = YAML.parse(readFileSync(join(SCENARIOS_DIR, file), "utf8"));
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (entry?.id && entry?.knownGap) gaps.set(String(entry.id), String(entry.knownGap));
    }
  }
  return gaps;
}

/** Every scenario id in the current set, so a page can tell "removed" from "not run here". */
export function currentScenarioIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(SCENARIOS_DIR)) return ids;
  for (const file of readdirSync(SCENARIOS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const parsed = YAML.parse(readFileSync(join(SCENARIOS_DIR, file), "utf8"));
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) if (entry?.id) ids.add(String(entry.id));
  }
  return ids;
}

/** Newest first. Summaries only — the full reports are hundreds of kilobytes each. */
export function listRuns(): RunSummary[] {
  const runs = reportFiles().map((file) => {
    const report = readReport(file);
    const slug = slugOf(file);
    return {
      slug,
      label: labelOf(slug),
      meta: report.meta,
      score: report.score,
      rates: report.scenarios.map((s) => ({
        id: s.id,
        category: s.category,
        passRate: s.passRate,
        runs: s.runs.length,
        passed: s.runs.filter((r) => r.pass).length,
      })),
    } satisfies RunSummary;
  });
  runs.sort((a, b) => (a.meta.startedAt < b.meta.startedAt ? 1 : -1));
  return runs;
}

export function runSlugs(): string[] {
  return reportFiles().map(slugOf);
}

export function readRun(slug: string): PublishedRun {
  const report = readReport(`${slug}.json`);
  return { slug, label: labelOf(slug), report };
}

/**
 * The smallest pass-rate move the sample can express: one flipped run.
 *
 * The same quantity `compare.ts` calls the noise floor. Stated on the page
 * rather than left to the reader, because at three repeats a single resampled
 * run moves a scenario by 33 points and reads exactly like a regression.
 */
export function noiseFloor(repeats: number): number {
  return repeats > 0 ? 1 / repeats : 1;
}

/**
 * Why a side-by-side view might not be one.
 *
 * The pairwise version lives in `packages/evals/src/compare.ts` and exists to
 * answer "did my change break something", so *there* a differing model is a
 * warning. Here a differing model is the entire point, and the things that
 * spoil the comparison are different scenario sets, different code, different
 * repeat counts, and different clients.
 */
export function comparabilityWarnings(runs: RunSummary[]): string[] {
  if (runs.length < 2) return [];
  const warnings: string[] = [];
  const distinct = <T>(values: T[]) => [...new Set(values)];

  const sets = distinct(runs.map((r) => r.meta.scenarioSetHash));
  if (sets.length > 1) {
    warnings.push(
      `These runs used ${sets.length} different scenario sets (${sets.join(", ")}). Per-scenario rows still ` +
        "line up, but the overall scores are not comparable — they are averages over different questions.",
    );
  }

  const shas = distinct(runs.map((r) => r.meta.gitSha));
  if (shas.length > 1) {
    warnings.push(
      `These runs were produced by ${shas.length} different commits (${shas.join(", ")}). A difference between ` +
        "them is a difference in the model and in the code at once.",
    );
  }

  const repeats = distinct(runs.map((r) => r.meta.repeats));
  if (repeats.length > 1) {
    warnings.push(
      `Repeat counts differ (${repeats.join(", ")}), so the noise floors differ: one flipped run is worth ` +
        `${repeats.map((n) => `${Math.round(100 / n)} points at ${n}`).join(", ")}.`,
    );
  }

  const providers = distinct(runs.map((r) => r.meta.provider ?? "openai_compatible"));
  if (providers.length > 1) {
    warnings.push(
      `Different provider clients (${providers.join(", ")}). A provider plugin and the generic client build ` +
        "different requests, so some of any difference belongs to the client rather than the model.",
    );
  }

  return warnings;
}

/**
 * Formatting is pinned to a locale and a timezone throughout, so the same
 * report produces the same bytes on any machine. `toLocaleString()` with no
 * arguments reads the host's locale, which makes a page's contents depend on
 * which runner built it.
 */
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

/** Stable across machines and timezones — a static page must not depend on where it was built. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
