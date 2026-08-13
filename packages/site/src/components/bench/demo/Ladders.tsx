/**
 * The two ladders every demonstration page needs: how far the team got, and how
 * far each fact travelled.
 *
 * Both exist because a single pass/fail hides the interesting part. A scenario
 * with a fifteen-step dependency graph reports one bit, and that bit is false
 * for every run that gets thirteen steps in — which cannot tell a team that
 * decoded the language and never restored power from one that did nothing.
 */

import type { AgentColour } from "@/lib/demo";
import { FACT_STAGES, milestoneScore, reachedStage } from "@/lib/demo";
import type { DemoFact, DemoMilestone } from "@/lib/demo-types";

const label = (id: string) => id.replace(/[-_]/g, " ");

export function MilestoneLadder({ milestones }: { milestones: DemoMilestone[] }) {
  const { earned, possible, fraction } = milestoneScore(milestones);
  const max = Math.max(...milestones.map((m) => m.points));

  return (
    <div>
      <div className="mb-5 flex items-baseline gap-3">
        <span className="font-mono text-3xl tabular-nums text-[var(--color-accent)]">
          {earned}
          <span className="text-lg text-[var(--color-text-muted)]">/{possible}</span>
        </span>
        <span className="text-sm text-[var(--color-text-muted)]">
          points · {Math.round(fraction * 100)}% of the ladder
        </span>
      </div>

      <ol className="space-y-px">
        {milestones.map((milestone) => (
          <li
            key={milestone.id}
            className={`flex items-center gap-3 rounded px-3 py-2 ${
              milestone.reached ? "bg-[var(--color-bg-secondary)]" : "bg-rose-500/5"
            }`}
          >
            <span
              aria-hidden="true"
              className={`w-4 shrink-0 text-center font-mono text-xs ${
                milestone.reached ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {milestone.reached ? "✓" : "✕"}
            </span>
            <span className={`flex-1 text-sm ${milestone.reached ? "" : "text-[var(--color-text-muted)]"}`}>
              {label(milestone.id)}
              {!milestone.reached && milestone.detail && (
                <span className="mt-0.5 block font-mono text-[11px] leading-snug text-rose-300/80">
                  {milestone.detail}
                </span>
              )}
            </span>
            {/* Weight as a bar, because the points are relative and a scenario is
                free to sum to whatever it likes — a bare "12" means nothing until
                you know the biggest rung. */}
            <span className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)] sm:block">
              <span
                className={`block h-full rounded-full ${milestone.reached ? "bg-emerald-400/70" : "bg-rose-400/40"}`}
                style={{ width: `${(milestone.points / max) * 100}%` }}
              />
            </span>
            <span className="w-6 shrink-0 text-right font-mono text-xs tabular-nums text-[var(--color-text-muted)]">
              {milestone.points}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Where each fact got to: discovered → shared → received → used.
 *
 * The measurement no per-agent check can make. A run can find every fact it
 * needs and still fail, and without this the report says only that the team
 * failed to activate the machine; with it, it says the glyph map was found on
 * turn 6 and never left the archive.
 */
export function FactLadder({ facts, colours }: { facts: DemoFact[]; colours: Map<string, AgentColour> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
        <thead>
          <tr>
            <th className="pb-3 pr-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Fact
            </th>
            {FACT_STAGES.map((stage) => (
              <th
                key={stage}
                className="pb-3 pr-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
              >
                {stage}
              </th>
            ))}
            <th className="pb-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Turns
            </th>
          </tr>
        </thead>
        <tbody>
          {facts.map((fact) => {
            const best = reachedStage(fact);
            return (
              <tr key={fact.name} className="border-t border-[var(--color-bg-tertiary)] align-top">
                <td className="py-3 pr-4">
                  <span className="font-mono text-xs">{label(fact.name)}</span>
                </td>
                {FACT_STAGES.map((stage) => {
                  const step = fact[stage];
                  const agent = step && "agent" in step ? step.agent : undefined;
                  const colour = agent ? colours.get(agent) : undefined;
                  return (
                    <td key={stage} className="py-3 pr-4">
                      {step ? (
                        <span className="flex flex-col gap-0.5">
                          <span className={`font-mono text-xs ${colour?.text ?? "text-[var(--color-text)]"}`}>
                            {agent}
                          </span>
                          <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                            turn {step.turn}
                            {"tool" in step && step.tool ? ` · ${step.tool}` : ""}
                          </span>
                        </span>
                      ) : (
                        <span className="font-mono text-xs text-rose-400/60">—</span>
                      )}
                    </td>
                  );
                })}
                <td className="py-3 text-right">
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      best === "used" ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {fact.latency === null ? "never" : `+${fact.latency}`}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
