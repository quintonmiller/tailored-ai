/**
 * Who did what, when.
 *
 * A transcript answers this and nobody reads a transcript. The thing worth
 * seeing at a glance is the *shape* of a run: which agents acted and which only
 * talked, whether work moved between them or piled up on one, and where in the
 * run the machinery finally gave way.
 *
 * Two views, because the runs measure different things. `Swimlane` is one row
 * per agent against a shared clock — turns for a puzzle, simulated days for an
 * economy. `Transitions` is the machinery's own account: what actually changed,
 * in order, including the calls it refused.
 */

import type { AgentColour } from "@/lib/demo";
import { callsByTurn } from "@/lib/demo";
import type { DemoCall, DemoWorldEvent } from "@/lib/demo-types";

export function Swimlane({
  agents,
  colours,
  calls,
  turnCount,
  /** Column heading per turn. Turn numbers by default; days for a simulation. */
  tickLabel,
  /** Marks under the axis — a machine failing, a customer leaving. */
  marks,
}: {
  agents: string[];
  colours: Map<string, AgentColour>;
  calls: DemoCall[];
  turnCount: number;
  tickLabel?: (turn: number) => string | null;
  marks?: Array<{ turn: number; label: string; tone?: "bad" | "good" }>;
}) {
  const byTurn = callsByTurn(calls);
  const turns = Array.from({ length: turnCount }, (_, i) => i);
  const markAt = new Map<number, Array<{ label: string; tone?: "bad" | "good" }>>();
  for (const mark of marks ?? []) {
    const list = markAt.get(mark.turn);
    if (list) list.push(mark);
    else markAt.set(mark.turn, [mark]);
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <div className="min-w-[46rem]">
        <table className="w-full border-collapse">
          <tbody>
            {agents.map((agent) => {
              const colour = colours.get(agent);
              return (
                <tr key={agent}>
                  <th className="w-28 py-1 pr-3 text-right align-middle">
                    <span className={`font-mono text-xs font-normal ${colour?.text ?? ""}`}>{agent}</span>
                  </th>
                  {turns.map((turn) => {
                    const mine = (byTurn.get(turn) ?? []).filter((c) => c.agent === agent);
                    const changed = mine.some((c) => c.acted);
                    if (!mine.length) {
                      return (
                        <td key={turn} className="px-px py-1">
                          <span className="block h-6 rounded-sm bg-[var(--color-bg-tertiary)]/50" />
                        </td>
                      );
                    }
                    return (
                      <td key={turn} className="px-px py-1">
                        {/*
                          A call that changed something is filled; one that only
                          looked is outlined. The distinction is the finding on
                          both of these pages — the first live factory run made
                          twelve calls, all of them reads, and looked busy.
                        */}
                        <span
                          title={`${agent}, turn ${turn}: ${mine.map((c) => c.tool).join(", ")}`}
                          className={`flex h-6 items-center justify-center rounded-sm border font-mono text-[10px] tabular-nums ${
                            changed
                              ? `${colour?.bg ?? "bg-white"} border-transparent text-[var(--color-bg)]`
                              : `${colour?.border ?? "border-[var(--color-border)]"} ${colour?.text ?? ""} bg-transparent`
                          }`}
                        >
                          {mine.length}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr>
              <td className="pr-3" />
              {turns.map((turn) => (
                <td key={turn} className="px-px pt-1 text-center">
                  <span className="block font-mono text-[9px] tabular-nums text-[var(--color-text-muted)]">
                    {tickLabel ? (tickLabel(turn) ?? "") : turn}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        {markAt.size > 0 && (
          <ul className="mt-3 space-y-1 border-t border-[var(--color-bg-tertiary)] pt-3">
            {[...markAt.entries()]
              .sort((a, b) => a[0] - b[0])
              .flatMap(([turn, list]) =>
                list.map((mark) => (
                  <li key={`${turn}-${mark.label}`} className="flex gap-2 font-mono text-[11px]">
                    <span className="w-16 shrink-0 text-right text-[var(--color-text-muted)]">
                      {tickLabel ? (tickLabel(turn) ?? `turn ${turn}`) : `turn ${turn}`}
                    </span>
                    <span className={mark.tone === "bad" ? "text-rose-300" : "text-[var(--color-text-muted)]"}>
                      {mark.label}
                    </span>
                  </li>
                )),
              )}
          </ul>
        )}

        <p className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-[var(--color-bg-tertiary)] pt-3 text-[11px] text-[var(--color-text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-[var(--color-text-muted)]" /> changed something
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm border border-[var(--color-text-muted)]" /> only looked
          </span>
          <span>the number is how many tools that agent called</span>
        </p>
      </div>
    </div>
  );
}

/**
 * The machinery's own account of the run.
 *
 * `world_state` is a claim about the machine rather than about the transcript,
 * which is what makes a puzzle with more than one solution gradeable — and it
 * makes this list the honest record of the solve. A refusal is in here too, and
 * is the most interesting row on the page: nobody was told the order, so being
 * turned away is how they learned it.
 */
export function Transitions({ log, colours }: { log: DemoWorldEvent[]; colours: Map<string, AgentColour> }) {
  return (
    <ol className="overflow-hidden rounded-xl border border-[var(--color-border)]">
      {log.map((event, index) => {
        const colour = event.agent ? colours.get(event.agent) : undefined;
        const sets = Object.entries(event.sets ?? {});
        return (
          <li
            key={`${event.turn}-${event.tool}-${index}`}
            className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--color-bg-tertiary)] px-4 py-2.5 last:border-b-0 ${
              event.applied ? "bg-[var(--color-bg-secondary)]" : "bg-rose-500/10"
            }`}
          >
            <span className="w-12 shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]">
              turn {event.turn ?? "—"}
            </span>
            <span className={`w-16 shrink-0 font-mono text-xs ${colour?.text ?? "text-[var(--color-text-muted)]"}`}>
              {event.agent ?? "—"}
            </span>
            <span className="font-mono text-xs">{event.tool}</span>
            {sets.length > 0 ? (
              <span className="font-mono text-xs text-emerald-400">
                {sets.map(([key, value]) => `${key} → ${value}`).join(", ")}
              </span>
            ) : event.applied ? (
              <span className="font-mono text-xs text-[var(--color-text-muted)]">no change</span>
            ) : (
              <span className="font-mono text-xs text-rose-300">
                refused · {event.effect.replace(/^blocked: /, "")}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
