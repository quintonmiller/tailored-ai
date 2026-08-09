/**
 * One run, in full.
 *
 * The page is built at export time, so the whole report is available without a
 * server; only the fields something renders are serialised into the page. A
 * passing run's request bodies are dropped here rather than shipped and hidden,
 * which is the difference between a 200 kB page and a 2 MB one.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Provenance } from "@/components/bench/Provenance";
import { RateBar, toneForAggregate } from "@/components/bench/Rate";
import { ScenarioList, type ScenarioView } from "@/components/bench/ScenarioList";
import { formatNumber, formatUsd, knownGaps, readRun, runSlugs, usageOf, usdOf } from "@/lib/bench";
import type { BenchmarkReport } from "@/lib/bench-types";

export function generateStaticParams() {
  return runSlugs().map((run) => ({ run }));
}

export async function generateMetadata({ params }: { params: Promise<{ run: string }> }): Promise<Metadata> {
  const { run } = await params;
  if (!runSlugs().includes(run)) return {};
  const { report, label } = readRun(run);
  return {
    title: `${label} — Benchmark`,
    description: `${report.meta.model} scored ${Math.round(report.score.overall * 100)}% across ${report.scenarios.length} scenarios.`,
  };
}

function toView(report: BenchmarkReport, gaps: Map<string, string>): ScenarioView[] {
  return report.scenarios.map((scenario) => ({
    id: scenario.id,
    category: scenario.category,
    intent: scenario.intent,
    knownGap: gaps.get(scenario.id) ?? scenario.knownGap,
    passRate: scenario.passRate,
    passed: scenario.runs.filter((run) => run.pass).length,
    total: scenario.runs.length,
    error: scenario.error,
    runs: scenario.runs.map((run) => ({
      pass: run.pass,
      checks: run.checks,
      reply: run.outcome.reply,
      calls: run.outcome.calls,
      posts: run.outcome.posts,
      // The recorder keeps request bodies for failing runs only; for a passing
      // one it keeps the envelope, which is still worth showing as a size.
      requests: run.pass
        ? []
        : run.outcome.requests.map((request) => ({
            system: request.system,
            messages: request.messages,
            toolCount: request.toolNames.length,
            estimatedTokens: request.estimatedTokens,
          })),
      latencyMs: run.outcome.latencyMs,
      retries: run.outcome.retries,
      providerErrors: run.outcome.providerErrors,
      error: run.outcome.error,
    })),
  }));
}

export default async function BenchRunPage({ params }: { params: Promise<{ run: string }> }) {
  const { run } = await params;
  if (!runSlugs().includes(run)) notFound();

  const { report, label } = readRun(run);
  const gaps = knownGaps();
  const scenarios = toView(report, gaps);
  const categories = Object.entries(report.score.byCategory).sort(([a], [b]) => a.localeCompare(b));
  // Split, never summed. Input and output are priced an order of magnitude
  // apart, so one combined figure cannot tell "the prompt got bigger" from
  // "the model talked more" — and the first is what this benchmark is for.
  const usage = usageOf(report);
  const usd = usdOf(report);
  const retries = report.scenarios.reduce(
    (sum, scenario) => sum + scenario.runs.reduce((runSum, r) => runSum + (r.outcome.retries ?? 0), 0),
    0,
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <Link
        href="/bench"
        className="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
      >
        ← All runs
      </Link>

      <header className="mt-4 mb-8">
        <h1 className="text-3xl font-bold tracking-tight">{label}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <RateBar rate={report.score.overall} tone={toneForAggregate(report.score.overall)} width={200} />
          <span className="font-mono text-2xl tabular-nums">{(report.score.overall * 100).toFixed(1)}%</span>
          <span className="text-sm text-[var(--color-text-muted)]">
            {report.score.passed} of {report.score.total} runs passed every check
          </span>
        </div>
      </header>

      <section className="mb-10 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6">
        <Provenance meta={report.meta} />
        <div className="mt-5 border-t border-[var(--color-bg-tertiary)] pt-4 text-xs text-[var(--color-text-muted)]">
          <span className="tabular-nums">{formatNumber(usage.input)}</span> tokens in
          {usage.cacheRead !== undefined ? <> ({formatNumber(usage.cacheRead)} cached)</> : null} ·{" "}
          <span className="tabular-nums">{formatNumber(usage.output)}</span> out ·{" "}
          {usd === null ? (
            <span title={`No price recorded for ${report.meta.model}`}>cost not priced</span>
          ) : (
            <span
              className="tabular-nums"
              title={`at $${report.meta.cost?.rates.input}/M in, $${report.meta.cost?.rates.output}/M out, as of ${report.meta.cost?.rates.asOf}`}
            >
              {formatUsd(usd)}
            </span>
          )}{" "}
          · {retries} retr{retries === 1 ? "y" : "ies"} · {report.meta.judge ? "judge checks on" : "judge checks off"}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-4 text-xl font-semibold tracking-tight">By category</h2>
        <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {categories.map(([name, bucket]) => (
            <div key={name} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-sm">{name}</span>
              <RateBar rate={bucket.rate} tone={toneForAggregate(bucket.rate)} />
              <span className="font-mono text-xs tabular-nums text-[var(--color-text-muted)]">
                {bucket.passed}/{bucket.total}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold tracking-tight">Scenarios</h2>
        <ScenarioList scenarios={scenarios} />
      </section>
    </div>
  );
}
