/**
 * The Factory, shown rather than described.
 *
 * This scenario has no correct answer, which makes a pass rate close to
 * meaningless: the interesting output is a dollar figure, and a dollar figure
 * means nothing without the scale beside it. So the page leads with the ladder —
 * the same economy played by six non-model policies on the same seed — and then
 * shows what the agents actually did to land where they did.
 */

import type { Metadata } from "next";
import { BaselineChart, ResponseTrace } from "@/components/bench/demo/Baselines";
import { AgentChip, DemoHeader, Finding, Legend, Note, Section } from "@/components/bench/demo/Chrome";
import { MilestoneLadder } from "@/components/bench/demo/Ladders";
import { Swimlane } from "@/components/bench/demo/Timeline";
import { agentColours, formatDuration, milestoneScore, money, readDemo, traceResponses } from "@/lib/demo";

export const metadata: Metadata = {
  title: "The Factory — Benchmark",
  description:
    "Six managers run a manufacturer for sixty simulated days against non-model baseline policies. A worked example of a benchmark scored on an objective rather than an answer.",
};

const DUTIES: Record<string, string> = {
  ceo: "sees the company at a glance; holds headcount and the capital budget. Cannot set a price or place an order.",
  sales: "sees demand, competitor prices and reputation; sets the price. Cannot see a machine or a material.",
  operations: "sees capacity and stock; sets what gets built. Cannot see demand and cannot price anything.",
  "supply-chain": "buys raw material from three suppliers. Cannot see what operations intends to build.",
  maintenance: "sees machine condition; schedules preventative work. Cannot change the plan wearing them out.",
  finance: "sees cash, debt and the borrowing base. Holds no operational lever at all.",
};

export default function TheFactoryPage() {
  const demo = readDemo("the-factory");
  const sim = demo.simulation;
  if (!sim) throw new Error("the-factory demo carries no simulation");

  const colours = agentColours(demo.agents);
  const score = milestoneScore(demo.milestones ?? []);
  const responses = traceResponses(sim, demo.calls);
  const shock = responses.find((r) => r.kind === "demand_shock");
  const acted = demo.calls.filter((c) => c.acted).length;
  const created = sim.metrics.valueCreated ?? 0;
  const beaten = sim.baselines.filter((b) => (sim.metrics.enterpriseValue ?? 0) > b.enterpriseValue);
  const above = [...sim.baselines]
    .sort((a, b) => a.enterpriseValue - b.enterpriseValue)
    .find((b) => b.enterpriseValue >= (sim.metrics.enterpriseValue ?? 0));

  const dayLabel = (turn: number) => {
    const day = sim.dayOfTurn[turn];
    // One label per meeting rather than per turn: six agents share a day, and
    // repeating the number six times turns the axis into noise.
    return turn === 0 || sim.dayOfTurn[turn - 1] !== day ? `d${day}` : null;
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <DemoHeader
        eyebrow="Worked example · simulation"
        title="The Factory"
        standfirst="Six managers run a manufacturer for sixty simulated days. There is no puzzle and no right answer — at the end, the balance sheet says how it went, and six policies that play the same economy without a model say what that number is worth."
        facts={[
          { label: "Enterprise value", value: money(sim.metrics.enterpriseValue ?? 0), tone: "accent" },
          { label: "Value created", value: money(created), tone: created >= 0 ? "good" : "muted" },
          { label: "Orders served", value: `${((sim.metrics.serviceLevel ?? 0) * 100).toFixed(0)}%` },
          { label: "Wall clock", value: formatDuration(demo.latencyMs), tone: "muted" },
        ]}
      />

      <Section
        id="problem"
        title="An objective, not an answer"
        lede={
          <>
            <p>
              Every other scenario in this benchmark asks a yes/no question. That is the right question exactly while
              the answer is sometimes no — and on the orchestration rows it is now reliably yes. A benchmark sitting at
              its own ceiling measures the ceiling.
            </p>
            <p className="mt-3">
              So this one gives an objective instead. Run the company; the score is what it is worth at the end. Cash,
              plus stock, plus machines at their condition, minus debt. Not revenue, not utilisation, not service level
              — and the difference between those matters, because two of the baselines below are built out of exactly
              that confusion.
            </p>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {demo.agents.map((agent) => (
            <div
              key={agent}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4"
            >
              <AgentChip name={agent} colour={colours.get(agent)} />
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">{DUTIES[agent]}</p>
            </div>
          ))}
        </div>
        <Note>
          The split is the benchmark. Every lever that matters sits one function away from the information that
          justifies it, so the only way to run the place well is for them to tell each other things. A team sharing one
          omniscient toolbox is one agent wearing six hats, and would say nothing about a multi-agent framework.
        </Note>
      </Section>

      <Section
        id="ladder"
        title="How well they did"
        lede={
          <p>
            The same economy, the same seed, the same meeting cadence, played by six policies that are ordinary code.
            They exist so the headline figure is a position rather than an anecdote — and because they catch, in
            milliseconds and before a single model call, the failure that would otherwise waste a day of GPU time: a
            simulation with no gradient, where every policy scores the same and the benchmark is measuring noise.
          </p>
        }
      >
        <BaselineChart sim={sim} />
        <Finding>
          Six models running a company for two simulated quarters created {money(created)} and beat {beaten.length} of
          the {sim.baselines.length} baselines
          {above ? (
            <>
              , landing {money(above.enterpriseValue - (sim.metrics.enterpriseValue ?? 0))} short of{" "}
              <span className="font-mono text-base">{above.policy}</span> — a hundred lines of operations heuristics
            </>
          ) : null}
          .
        </Finding>
        <Note>
          The two rows marked <em>trap</em> are the reason this is worth measuring. Both are recognisable management —
          one discounts until the factory is full, the other builds ahead of demand and keeps its crew together — both
          post the highest service levels in the set, and both earn less than the plain reorder-point rule they are
          built on. A benchmark scoring subsystems separately would have called each of them an improvement.
        </Note>
      </Section>

      <Section
        id="what-happened"
        title="What the agents did"
        lede={
          <p>
            Eight meetings across sixty days. Between meetings the factory runs, customers order, suppliers deliver and
            machines wear out — a filled square is a manager who changed something at that meeting, an outlined one is a
            manager who only read their instruments.
          </p>
        }
      >
        <Legend agents={demo.agents} colours={colours} roles={sim.roles} />
        <div className="mt-4">
          <Swimlane
            agents={demo.agents}
            colours={colours}
            calls={demo.calls}
            turnCount={demo.turns.length}
            tickLabel={dayLabel}
            marks={sim.events.map((event) => ({
              turn: demo.turns.findIndex((_, i) => sim.dayOfTurn[i] >= event.day),
              label: `${event.kind.replace(/_/g, " ")}${event.visibleTo?.length ? ` — only ${event.visibleTo.join(", ")} can see it` : ""}`,
              tone: event.kind === "demand_shock" ? ("bad" as const) : undefined,
            }))}
          />
        </div>
        <Finding>
          {acted} of {demo.calls.length} tool calls changed anything. The rest were managers reading their own
          instruments — which is the job, up to the point where it replaces doing something. On an earlier run of this
          scenario the team made twelve calls, all of them reads: it diagnosed the business accurately, wrote it up, and
          changed nothing at all.
        </Finding>
      </Section>

      {shock && (
        <Section
          id="latency"
          title="The thing only one of them could see"
          lede={
            <p>
              The balance sheet is a lagging measure: by the time enterprise value has moved, whatever caused it
              happened weeks ago. This is the leading one — the delay between something happening and the right function
              acting on it. Partway through the run a distributor takes its business elsewhere and demand falls by
              nearly half, for good. Sales gets the call, because in a real company sales takes the call. The three
              responses that matter are the production plan, the headcount and the price, and two of the three belong to
              other people.
            </p>
          }
        >
          <ResponseTrace rows={responses.filter((r) => r.kind === "demand_shock")} />
          <Finding>
            {shock.routedBy ? (
              <>
                Sales cut prices the same day, and {(shock.routedDay ?? 0) - shock.day} days later {shock.routedBy}{" "}
                called <span className="font-mono text-base">{shock.routedWith}</span> — the news reached somebody who
                could not have seen it. The first version of this metric scored that as never routed, because it read
                the flag off the first response only, and a team that told the rest of the company scored the same as
                one that did not.
              </>
            ) : (
              <>
                Sales reacted at once and the news never left sales. Nothing the production plan or the headcount could
                have done was done, which is the difference between somebody noticing and the organisation responding.
              </>
            )}
          </Finding>
        </Section>
      )}

      <Section
        id="score"
        title="The ladder"
        lede={
          <p>
            Partial credit, because a sixty-day company has no single moment of success. The bottom rungs ask whether
            each manager operated its own function at all; the middle ones ask whether the organisation beat
            progressively better ways of not thinking; the top ones ask whether it noticed what went wrong and got word
            to the people who could act.
          </p>
        }
      >
        <MilestoneLadder milestones={demo.milestones ?? []} />
        <Note>
          Run on {demo.model} at commit <span className="font-mono">{demo.gitSha}</span>: {demo.turns.length} turns,{" "}
          {demo.rounds} model round-trips, {demo.usage.input.toLocaleString()} input and{" "}
          {demo.usage.output.toLocaleString()} output tokens for {score.earned} of {score.possible} points. The data
          behind this page is a committed extract of that run; regenerate it with{" "}
          <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs">
            pnpm run eval -- demo &lt;report&gt; --scenario the-factory
          </code>
          .
        </Note>
      </Section>
    </div>
  );
}
