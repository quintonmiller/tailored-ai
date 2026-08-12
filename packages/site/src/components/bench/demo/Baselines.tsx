/**
 * Where the team landed on a scale somebody can reason about.
 *
 * "$1.24M" is not a result. Next to a random policy at $768K, a set-and-forget
 * one at $854K and textbook operations at $1.27M, it is a specific claim about
 * how well six models ran a company. The baselines are ordinary code playing the
 * same economy through the same actions, on the same seed and the same meeting
 * cadence, so this is a comparison rather than an anecdote.
 *
 * They also carry the finding the whole simulation exists for, which is why the
 * chart shows service level beside the money: the two policies with the best
 * service destroy the most value.
 */

import { money } from "@/lib/demo";
import type { DemoSimulation } from "@/lib/demo-types";

const NOTES: Record<string, string> = {
  random: "prices and orders drawn from a hat",
  static: "sensible opening settings, then nobody looks again",
  "fill-the-line": "textbook operations, plus a sales manager who discounts until the factory is full",
  growth: "builds and staffs 20% ahead of demand, and never lets anyone go",
  "reorder-point": "textbook operations: reorder points, production matched to demand, preventative maintenance",
  operator: "textbook operations, plus capacity bought where it actually binds",
};

const TRAPS = new Set(["fill-the-line", "growth"]);

export function BaselineChart({ sim, teamLabel = "the agents" }: { sim: DemoSimulation; teamLabel?: string }) {
  const team = sim.metrics.enterpriseValue ?? 0;
  const rows = [
    ...sim.baselines.map((b) => ({
      name: b.policy,
      value: b.enterpriseValue,
      service: b.serviceLevel,
      team: false,
      note: NOTES[b.policy],
      trap: TRAPS.has(b.policy),
    })),
    {
      name: teamLabel,
      value: team,
      service: sim.metrics.serviceLevel ?? 0,
      team: true,
      note: `six managers, ${sim.days} simulated days, ${sim.daysManaged} of them under management`,
      trap: false,
    },
  ].sort((a, b) => a.value - b.value);

  const max = Math.max(...rows.map((r) => r.value));
  const opening = sim.openingValue;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5">
      <ol className="space-y-3">
        {rows.map((row) => (
          <li key={row.name}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4">
              <span
                className={`font-mono text-sm ${
                  row.team ? "font-semibold text-[var(--color-accent)]" : "text-[var(--color-text)]"
                }`}
              >
                {row.name}
                {row.trap && (
                  <span className="ml-2 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-normal text-amber-300">
                    trap
                  </span>
                )}
              </span>
              <span className="flex items-baseline gap-3 font-mono text-xs tabular-nums">
                <span className="text-[var(--color-text-muted)]">{(row.service * 100).toFixed(0)}% served</span>
                <span className={row.team ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}>
                  {money(row.value)}
                </span>
              </span>
            </div>
            <div className="relative h-2.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
              <div
                className={`h-full rounded-full ${
                  row.team
                    ? "bg-[var(--color-accent)]"
                    : row.trap
                      ? "bg-amber-400/50"
                      : "bg-[var(--color-text-muted)]/45"
                }`}
                style={{ width: `${(row.value / max) * 100}%` }}
              />
            </div>
            {row.note && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{row.note}</p>}
          </li>
        ))}
      </ol>

      {/*
        The opening balance sheet, because "created value" and "destroyed value"
        are the only readings that mean anything here, and neither is visible
        from a final figure alone. Measuring against opening *cash* instead
        counted $660K of machines and stock as value the company had produced.
      */}
      <p className="mt-5 border-t border-[var(--color-bg-tertiary)] pt-4 text-xs text-[var(--color-text-muted)]">
        The company opened at <span className="font-mono text-[var(--color-text)]">{money(opening)}</span>. Anything
        below that line destroyed value over {sim.days} days; anything above it created some.
      </p>
    </div>
  );
}

/**
 * How long the organisation took to act on something only one of them could see.
 *
 * The balance sheet is a lagging measure: by the time enterprise value moves,
 * the cause is weeks old. This is the leading one, and the column that matters
 * is whether the news reached somebody who could act on it — a team that
 * notices quickly and keeps it to itself has done the half a single agent with
 * six tools would have got for free.
 */
export function ResponseTrace({
  rows,
}: {
  rows: Array<{
    day: number;
    kind: string;
    message: string;
    seenBy: string[];
    firstBy?: string;
    firstDay?: number;
    firstWith?: string;
    routedBy?: string;
    routedDay?: number;
    routedWith?: string;
  }>;
}) {
  if (!rows.length) return null;
  return (
    <ol className="space-y-4">
      {rows.map((row) => (
        <li
          key={`${row.day}-${row.kind}`}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5"
        >
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-xs tabular-nums text-[var(--color-text-muted)]">day {row.day}</span>
            <span className="font-mono text-sm text-rose-300">{row.kind.replace(/_/g, " ")}</span>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              visible to {row.seenBy.length ? row.seenBy.join(", ") : "anyone who looks"}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)]">{row.message}</p>

          <ol className="mt-4 space-y-2 border-l border-[var(--color-bg-tertiary)] pl-4">
            {row.firstBy && (
              <li className="font-mono text-xs">
                <span className="tabular-nums text-[var(--color-text-muted)]">day {row.firstDay}</span>{" "}
                <span className="text-[var(--color-text)]">{row.firstBy}</span>{" "}
                <span className="text-[var(--color-text-muted)]">
                  called {row.firstWith} — {(row.firstDay ?? 0) - row.day} days later
                  {row.seenBy.includes(row.firstBy) ? ", inside the function that saw it" : ""}
                </span>
              </li>
            )}
            {row.routedBy ? (
              <li className="font-mono text-xs">
                <span className="tabular-nums text-[var(--color-text-muted)]">day {row.routedDay}</span>{" "}
                <span className="text-emerald-400">{row.routedBy}</span>{" "}
                <span className="text-[var(--color-text-muted)]">
                  called {row.routedWith} — {(row.routedDay ?? 0) - row.day} days later, and could not see the event.
                  The news was routed.
                </span>
              </li>
            ) : (
              <li className="font-mono text-xs text-rose-300">nobody outside the function that saw it ever acted</li>
            )}
          </ol>
        </li>
      ))}
    </ol>
  );
}
