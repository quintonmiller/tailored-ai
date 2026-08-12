/**
 * Published benchmark runs, and the same scenarios across every model.
 *
 * The cross-model table is the reason the benchmark exists: a single score
 * answers "how good is it", and the only question anyone actually has is "which
 * of these behaves better, and where". Everything that would make that table
 * lie — different scenario sets, different commits, different repeat counts —
 * is stated above it rather than left to be worked out.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { Provenance, Warnings } from "@/components/bench/Provenance";
import { AbsentCell, KnownGapChip, RateBadge, RateBar, toneForAggregate } from "@/components/bench/Rate";
import {
  comparabilityWarnings,
  currentScenarioIds,
  formatDate,
  formatNumber,
  formatUsd,
  knownGaps,
  listArchivedRuns,
  listRuns,
  noiseFloor,
} from "@/lib/bench";
import type { RunSummary } from "@/lib/bench-types";

export const metadata: Metadata = {
  title: "Benchmark",
  description: "Scenario benchmark results for the invocation message, across models.",
};

/**
 * Scenario order, taken from the run that covers the most of them so the
 * authored grouping survives, with anything only the other runs have appended.
 */
function scenarioRows(runs: RunSummary[]): Array<{ id: string; category: string }> {
  const widest = [...runs].sort((a, b) => b.rates.length - a.rates.length)[0];
  const rows: Array<{ id: string; category: string }> = [];
  const seen = new Set<string>();
  for (const run of [widest, ...runs]) {
    if (!run) continue;
    for (const rate of run.rates) {
      if (seen.has(rate.id)) continue;
      seen.add(rate.id);
      rows.push({ id: rate.id, category: rate.category });
    }
  }
  return rows;
}

function EmptyState() {
  return (
    <p className="text-[var(--color-text-muted)]">
      No published runs. A run reaches this page by being committed to{" "}
      <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-sm">packages/evals/results/</code>.
    </p>
  );
}

export default function BenchIndexPage() {
  const runs = listRuns();
  const archived = listArchivedRuns();
  const gaps = knownGaps();
  const current = currentScenarioIds();
  const warnings = comparabilityWarnings(runs);
  const rows = scenarioRows(runs);

  const byRun = new Map(runs.map((run) => [run.slug, new Map(run.rates.map((r) => [r.id, r]))]));
  const floors = [...new Set(runs.map((r) => r.meta.repeats))].sort((a, b) => a - b);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">Benchmark</h1>
        <p className="mt-3 max-w-3xl text-[var(--color-text-muted)]">
          Each scenario assembles a real invocation message through core — prompt, memory, room transcript, tool
          schemas, the lot — sends it to a live model, and grades what comes back. These are the published runs.
        </p>
      </header>

      {/*
        The table below answers "which model behaves better". It cannot answer
        "is this test worth anything", and a green 3/3 on the hardest row gives a
        reader no way to judge whether the scenario is difficult or merely long.
        These two do: a run, shown.
      */}
      <section className="mb-12 grid gap-4 sm:grid-cols-2">
        {[
          {
            href: "/bench/scenarios/the-machine",
            eyebrow: "Orchestration",
            title: "The Machine",
            blurb:
              "Six agents wake in six rooms of a machine nobody has explained. Five facts each have to travel between a different pair of them, and no agent can finish alone.",
          },
          {
            href: "/bench/scenarios/the-factory",
            eyebrow: "Simulation",
            title: "The Factory",
            blurb:
              "Six managers run a manufacturer for sixty simulated days against policies that play the same economy without a model. Scored on what the company is worth, not on whether a check passed.",
          },
        ].map((card) => (
          <Link
            key={card.href}
            href={card.href}
            prefetch={false}
            className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 transition-colors hover:border-[var(--color-accent)]"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">
              {card.eyebrow}
            </p>
            <h2 className="mt-2 text-lg font-semibold">
              {card.title}
              <span
                aria-hidden="true"
                className="ml-2 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5 inline-block"
              >
                →
              </span>
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">{card.blurb}</p>
          </Link>
        ))}
      </section>

      {runs.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <section className="mb-12 space-y-4">
            {/*
              The card is not itself a link. Provenance carries a link to the
              commit, and an anchor inside an anchor is both invalid and
              ambiguous to click — the run name is the way in.
            */}
            {runs.map((run) => {
              const tone = toneForAggregate(run.score.overall);
              return (
                <article
                  key={run.slug}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6"
                >
                  <div className="mb-5 flex flex-wrap items-baseline justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-semibold">
                        <Link
                          href={`/bench/${run.slug}`}
                          prefetch={false}
                          className="transition-colors hover:text-[var(--color-accent)]"
                        >
                          {run.label}
                          <span aria-hidden="true" className="ml-2 text-[var(--color-text-muted)]">
                            →
                          </span>
                        </Link>
                      </h2>
                      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                        {run.rates.length} scenarios · {run.score.total} runs ·{" "}
                        {/* Next to the score on purpose: what a model costs is half
                            of choosing one, and it was invisible here. */}
                        <span className="tabular-nums">{formatNumber(run.usage.input + run.usage.output)}</span> tokens
                        {run.usd !== null ? (
                          <>
                            {" "}
                            · <span className="tabular-nums">{formatUsd(run.usd)}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <RateBar rate={run.score.overall} tone={tone} width={140} />
                      <RateBadge passed={run.score.passed} runs={run.score.total} />
                    </div>
                  </div>
                  <Provenance meta={run.meta} />
                </article>
              );
            })}
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight">Across models</h2>
            <p className="mt-2 mb-5 max-w-3xl text-sm text-[var(--color-text-muted)]">
              Every cell is the fraction of runs that passed every check, never a verdict.{" "}
              {floors.length === 1
                ? `At ${floors[0]} repeats one flipped run moves a scenario by ${Math.round(noiseFloor(floors[0]) * 100)} points, so a single-cell difference is not yet a finding.`
                : "Repeat counts differ between these runs, so a one-run move is worth different amounts in different columns."}
            </p>

            {warnings.length > 0 && (
              <div className="mb-6">
                <Warnings warnings={warnings} />
              </div>
            )}

            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] lg:overflow-x-visible">
              <table className="w-full border-collapse text-left">
                <thead>
                  {/*
                    Sticky under the site header: with 58 rows the column you are
                    reading stops having a name about two screens in, and a cell
                    that says 2/3 is worthless if you cannot tell which model it
                    belongs to.
                  */}
                  <tr className="bg-[var(--color-bg-secondary)]">
                    <th className="sticky top-16 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Scenario
                    </th>
                    {runs.map((run) => (
                      <th
                        key={run.slug}
                        className="sticky top-16 z-10 whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
                      >
                        {run.meta.model}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const gap = gaps.get(row.id);
                    const removed = !current.has(row.id);
                    const newCategory = index === 0 || rows[index - 1].category !== row.category;
                    return (
                      <tr
                        key={row.id}
                        className={`border-t border-[var(--color-bg-tertiary)] ${newCategory ? "border-t-[var(--color-border)]" : ""}`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs">{row.id}</span>
                            {gap && <KnownGapChip gap={gap} />}
                            {removed && (
                              <span
                                className="text-[11px] text-[var(--color-text-muted)]"
                                title="This scenario is in a published report but no longer in the scenario set."
                              >
                                retired
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{row.category}</div>
                        </td>
                        {runs.map((run) => {
                          const rate = byRun.get(run.slug)?.get(row.id);
                          return (
                            <td key={run.slug} className="whitespace-nowrap px-4 py-2.5">
                              {rate ? (
                                <RateBadge passed={rate.passed} runs={rate.runs} knownGap={gap} />
                              ) : (
                                <AbsentCell reason={`Not in this run's scenario set (${run.meta.scenarioSetHash}).`} />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="mt-4 max-w-3xl text-xs leading-relaxed text-[var(--color-text-muted)]">
              <span className="text-sky-400">Known gap</span> marks a scenario that asserts the behaviour we want rather
              than the behaviour we have. Those rows are meant to be red, and stay red until the linked issue is closed
              — open a run to read which one.
            </p>
          </section>

          {archived.length > 0 && (
            <section className="mt-14">
              <h2 className="text-xl font-semibold tracking-tight">Earlier runs</h2>
              <p className="mt-2 mb-5 max-w-3xl text-sm text-[var(--color-text-muted)]">
                Superseded cohorts, kept so a model getting better or worse across commits is visible rather than
                overwritten. They are not held to the one-commit rule above and are not comparable with it — read each
                against the commit it names.
              </p>
              <ul className="divide-y divide-[var(--color-bg-tertiary)] border-y border-[var(--color-bg-tertiary)]">
                {archived.map((run) => (
                  <li key={run.slug} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3 text-sm">
                    <Link
                      href={`/bench/${run.slug}`}
                      prefetch={false}
                      className="font-medium text-[var(--color-text)] underline decoration-[var(--color-bg-tertiary)] underline-offset-4 transition-colors hover:decoration-[var(--color-text-muted)]"
                    >
                      {run.label}
                    </Link>
                    <span className="font-mono tabular-nums text-[var(--color-text-muted)]">
                      {Math.round(run.score.overall * 100)}%
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {run.score.passed}/{run.score.total} runs · {run.rates.length} scenarios
                    </span>
                    <span className="ml-auto font-mono text-xs text-[var(--color-text-muted)]">
                      {run.meta.gitSha}
                      {run.meta.gitDirty && <span className="text-amber-500"> +uncommitted</span>}
                      {" · "}
                      {formatDate(run.meta.startedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
