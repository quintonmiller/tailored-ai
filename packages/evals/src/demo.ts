/**
 * One run, cut down to what a page can show.
 *
 * A benchmark report is the record: every request body, every tool result, every
 * post in full. That is the right shape for `regrade` and the wrong shape for a
 * web page — the two runs behind the demonstration pages are 1.5 MB and 4.5 MB,
 * and almost all of it is prompt text nobody will read.
 *
 * The alternative was to hand-copy the interesting numbers into the page, which
 * is how a "demonstration" quietly becomes an illustration: the figures stop
 * being anything in particular the day the scenario changes, and no one can tell
 * because there is nothing to check them against. This keeps the page honest by
 * making the data a build artifact — regenerate it from a report, commit it, and
 * the page renders whatever the run actually did.
 *
 * Baselines are computed here rather than stored, because they are a property of
 * the *economy* rather than of the run: re-running them at extract time means the
 * comparison on the page is against the code as it stands, on the run's own seed.
 */

import { readFileSync } from "node:fs";
import { simulationPolicies } from "./sim/index.js";
import { runPolicy } from "./sim/sweep.js";
import type { SimEvent } from "./sim/types.js";
import type { BenchmarkReport, FactTrace, MilestoneResult, WorldEvent } from "./types.js";

/** Long enough to show an agent actually reasoning, short enough to render. */
const POST_CHARS = 1400;
/** Enough to see what a tool said back, which is where every fact enters the run. */
const RESULT_CHARS = 320;

export interface DemoCall {
  turn: number;
  agent?: string;
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  /** True where the call moved the world or the economy rather than reporting on it. */
  acted?: boolean;
}

export interface DemoPost {
  turn?: number;
  agent?: string;
  room: string;
  body: string;
  truncated?: boolean;
}

export interface Demo {
  scenario: string;
  category: string;
  intent: string;
  difficulty?: number;
  model: string;
  gitSha: string;
  startedAt: string;
  passRate: number;
  passed: boolean;
  checks: Array<{ kind: string; pass: boolean; detail?: string }>;
  agents: string[];
  turns: Array<{ agent: string; room: string }>;
  rooms: string[];
  calls: DemoCall[];
  posts: DemoPost[];
  world?: Record<string, string>;
  worldLog?: WorldEvent[];
  milestones?: MilestoneResult[];
  facts?: FactTrace[];
  simulation?: {
    name: string;
    seed: number;
    days: number;
    daysManaged: number;
    daysPerRound: number;
    endedBecause?: string;
    metrics: Record<string, number>;
    events: SimEvent[];
    dayOfTurn: number[];
    roles: Record<string, string>;
    responses: Record<string, string[]>;
    /** The same economy played by each non-model policy, on this run's seed. */
    baselines: Array<{ policy: string; enterpriseValue: number; serviceLevel: number; bankrupt: number }>;
    openingValue: number;
  };
  usage: { input: number; output: number };
  latencyMs: number;
  rounds: number;
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/**
 * Which calls changed something.
 *
 * Every scenario here has a read surface an order of magnitude larger than its
 * write surface, and the difference is the whole story of a run: the first live
 * factory run made twelve tool calls, all of them reads, and looked busy. A page
 * that renders both the same way would hide exactly that.
 */
function acted(call: { name: string; result?: string }, worldTools: Set<string>, simTools: Set<string>): boolean {
  return worldTools.has(call.name) || simTools.has(call.name);
}

/** Tools a simulation exposes that change the world rather than report on it. */
const WRITE_TOOLS = new Set([
  "set_price",
  "set_production_plan",
  "place_purchase_order",
  "schedule_maintenance",
  "set_workforce",
  "approve_capital_project",
]);

export function extractDemo(reportPath: string, scenarioId: string, runIndex = 0): Demo {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as BenchmarkReport;
  const scenario = report.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) {
    throw new Error(
      `no scenario "${scenarioId}" in ${reportPath} — it has [${report.scenarios.map((s) => s.id).join(", ")}]`,
    );
  }
  const run = scenario.runs[runIndex];
  if (!run) throw new Error(`${scenarioId} has ${scenario.runs.length} run(s); asked for index ${runIndex}`);
  const outcome = run.outcome;

  // Tools that drove the world, read off the transitions rather than guessed, so
  // a scenario's own instruments are classified by what they did in this run.
  const worldTools = new Set((outcome.worldLog ?? []).map((event) => event.tool));

  const sim = outcome.simulation;
  const demo: Demo = {
    scenario: scenario.id,
    category: scenario.category,
    intent: scenario.intent,
    difficulty: scenario.difficulty,
    model: report.meta.model,
    gitSha: report.meta.gitSha,
    startedAt: report.meta.startedAt,
    passRate: scenario.passRate,
    passed: run.pass,
    checks: run.checks.map((c) => ({
      kind: c.kind,
      pass: c.pass,
      ...(c.detail ? { detail: cut(c.detail, 300) } : {}),
    })),
    agents: [...new Set((outcome.turns ?? []).map((t) => t.agent))],
    turns: outcome.turns ?? [],
    rooms: [...new Set(outcome.posts.map((p) => p.room))],
    calls: (outcome.executions ?? []).map((call) => ({
      turn: call.turn ?? 0,
      ...(call.agent ? { agent: call.agent } : {}),
      tool: call.name,
      args: call.args,
      ...(call.result ? { result: cut(call.result, RESULT_CHARS) } : {}),
      ...(acted(call, worldTools, WRITE_TOOLS) ? { acted: true } : {}),
    })),
    posts: outcome.posts.map((post) => ({
      ...(post.turn === undefined ? {} : { turn: post.turn }),
      ...(post.agent ? { agent: post.agent } : {}),
      room: post.room,
      body: cut(post.body, POST_CHARS),
      ...(post.body.length > POST_CHARS ? { truncated: true } : {}),
    })),
    ...(outcome.world ? { world: outcome.world } : {}),
    ...(outcome.worldLog ? { worldLog: outcome.worldLog } : {}),
    ...(run.milestones ? { milestones: run.milestones } : {}),
    ...(run.facts ? { facts: run.facts } : {}),
    usage: { input: outcome.usage.input, output: outcome.usage.output },
    latencyMs: outcome.latencyMs,
    rounds: outcome.requests.filter((r) => !r.auxiliary).length,
  };

  if (sim) {
    const policies = simulationPolicies(sim.name);
    demo.simulation = {
      name: sim.name,
      seed: sim.seed,
      days: sim.days,
      daysManaged: sim.daysManaged,
      daysPerRound: sim.daysPerRound ?? 1,
      ...(sim.endedBecause ? { endedBecause: sim.endedBecause } : {}),
      metrics: sim.metrics,
      events: sim.events,
      dayOfTurn: sim.dayOfTurn,
      roles: sim.roles,
      responses: sim.responses ?? {},
      baselines: Object.entries(policies).map(([policy, make]) => {
        const metrics = runPolicy(sim.name, make(), sim.seed, sim.days, sim.daysPerRound ?? 1);
        return {
          policy,
          enterpriseValue: Math.round(metrics.enterpriseValue ?? 0),
          serviceLevel: metrics.serviceLevel ?? 0,
          bankrupt: metrics.bankrupt ?? 0,
        };
      }),
      // What the company was worth before anyone touched it, so "created" and
      // "destroyed" on the page mean what they say.
      openingValue: Math.round((sim.metrics.enterpriseValue ?? 0) - (sim.metrics.valueCreated ?? 0)),
    };
  }

  return demo;
}
