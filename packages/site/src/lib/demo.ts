/**
 * Loading a demonstration dataset, and the small arithmetic every page does on it.
 *
 * Read from disk at build time rather than imported, matching `bench.ts`: the
 * files are build artifacts of another package and a missing one should fail the
 * build with a sentence saying how to regenerate it, not with a module
 * resolution error.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Demo, DemoCall, DemoFact, DemoMilestone, DemoSimulation, FactStage } from "./demo-types";

const DATA_DIR = join(process.cwd(), "src", "data");

export function readDemo(scenario: string): Demo {
  const path = join(DATA_DIR, `demo-${scenario}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `no demonstration data at ${path}. Regenerate it from a benchmark report:\n` +
        `  pnpm --filter @tailored-ai/evals run eval -- demo <report.json> --scenario ${scenario} ` +
        `--out packages/site/src/data/demo-${scenario}.json`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Demo;
}

/**
 * A stable colour per agent, assigned by position in the roster.
 *
 * By position rather than by name because these pages exist to make *who did
 * what* legible at a glance, and that only works if one agent is one colour
 * everywhere on the page — the timeline, the ladder and the transcript all have
 * to agree.
 */
const PALETTE = [
  { text: "text-lime-300", bg: "bg-lime-300", soft: "bg-lime-300/15", border: "border-lime-300/40" },
  { text: "text-sky-300", bg: "bg-sky-300", soft: "bg-sky-300/15", border: "border-sky-300/40" },
  { text: "text-violet-300", bg: "bg-violet-300", soft: "bg-violet-300/15", border: "border-violet-300/40" },
  { text: "text-amber-300", bg: "bg-amber-300", soft: "bg-amber-300/15", border: "border-amber-300/40" },
  { text: "text-rose-300", bg: "bg-rose-300", soft: "bg-rose-300/15", border: "border-rose-300/40" },
  { text: "text-teal-300", bg: "bg-teal-300", soft: "bg-teal-300/15", border: "border-teal-300/40" },
];

export type AgentColour = (typeof PALETTE)[number];

export function agentColours(agents: string[]): Map<string, AgentColour> {
  return new Map(agents.map((agent, index) => [agent, PALETTE[index % PALETTE.length]]));
}

export const FACT_STAGES: FactStage[] = ["discovered", "shared", "received", "used"];

/** How far a fact got. The first missing stage is the diagnosis. */
export function reachedStage(fact: DemoFact): FactStage | null {
  let best: FactStage | null = null;
  for (const stage of FACT_STAGES) {
    if (fact[stage]) best = stage;
    else break;
  }
  return best;
}

export function milestoneScore(milestones: DemoMilestone[]): { earned: number; possible: number; fraction: number } {
  const possible = milestones.reduce((sum, m) => sum + m.points, 0);
  const earned = milestones.filter((m) => m.reached).reduce((sum, m) => sum + m.points, 0);
  return { earned, possible, fraction: possible ? earned / possible : 0 };
}

/** Calls grouped by turn, so a timeline can render one column per turn. */
export function callsByTurn(calls: DemoCall[]): Map<number, DemoCall[]> {
  const out = new Map<number, DemoCall[]>();
  for (const call of calls) {
    const list = out.get(call.turn);
    if (list) list.push(call);
    else out.set(call.turn, [call]);
  }
  return out;
}

export function money(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * How long the organisation took to act on each event, and whether the news ever
 * left the function that could see it.
 *
 * A copy of the evals package's `traceResponses` rather than an import, for the
 * same reason `bench-types.ts` mirrors its types: the site reads that package's
 * output and never its code. The rule it encodes is worth restating — the first
 * response and the first *routed* response are different measurements, and
 * reading only the first scores a team where sales reacts and tells nobody the
 * same as one where the whole company turns.
 */
export function traceResponses(sim: DemoSimulation, calls: DemoCall[]): ResponseRow[] {
  return sim.events
    .filter((event) => (sim.responses[event.kind] ?? []).length > 0)
    .map((event) => {
      const answering = new Set(sim.responses[event.kind]);
      const seenBy = event.visibleTo ?? [];
      const watchers = new Set(seenBy.map((role) => sim.roles[role]).filter(Boolean));
      const answers = calls.filter((call) => answering.has(call.tool) && (sim.dayOfTurn[call.turn] ?? -1) >= event.day);
      const first = answers[0];
      const routed = watchers.size ? answers.find((call) => call.agent && !watchers.has(call.agent)) : undefined;
      return {
        day: event.day,
        kind: event.kind,
        message: event.message,
        seenBy,
        ...(first ? { firstBy: first.agent, firstDay: sim.dayOfTurn[first.turn], firstWith: first.tool } : {}),
        ...(routed ? { routedBy: routed.agent, routedDay: sim.dayOfTurn[routed.turn], routedWith: routed.tool } : {}),
      };
    });
}

export interface ResponseRow {
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
}

/** Human wording for a tool name, for prose that should not read like an API. */
export function prettyTool(tool: string): string {
  return tool.replace(/_/g, " ");
}
