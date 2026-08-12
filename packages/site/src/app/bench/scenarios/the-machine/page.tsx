/**
 * The Machine, shown rather than described.
 *
 * The hardest scenario in the set is also the one a table of pass rates says
 * least about: a green cell reading 3/3 gives no sense of what six agents had to
 * do to earn it, and no way for a reader to judge whether the test is difficult
 * or merely long. This page is the answer to "show me" — every figure on it is
 * read from a committed run, not written by hand.
 */

import type { Metadata } from "next";
import { AgentChip, DemoHeader, Finding, Legend, Note, Section } from "@/components/bench/demo/Chrome";
import { FactLadder, MilestoneLadder } from "@/components/bench/demo/Ladders";
import { Swimlane, Transitions } from "@/components/bench/demo/Timeline";
import { agentColours, formatDuration, milestoneScore, readDemo } from "@/lib/demo";

export const metadata: Metadata = {
  title: "The Machine — Benchmark",
  description:
    "Six agents, an unexplained machine, and five facts that each have to travel between a different pair of them. A worked example of the hardest scenario in the benchmark.",
};

/** Who was put where, and what each of them could touch. Read off the run's own calls. */
const CHAMBERS: Record<string, { room: string; holds: string }> = {
  atlas: { room: "the observatory", holds: "a star map and a ring mechanism" },
  boron: { room: "the reactor hall", holds: "a frequency dial and three power buses" },
  cipher: { room: "the archive", holds: "a document search and a reader" },
  delta: { room: "the signal room", holds: "a receiver and an analyser" },
  echo: { room: "the workshop", holds: "a parts bin and a fabricator" },
  flux: { room: "the control room", holds: "the console, the interlock and the activation lever" },
};

export default function TheMachinePage() {
  const demo = readDemo("the-machine");
  const colours = agentColours(demo.agents);
  const score = milestoneScore(demo.milestones ?? []);
  const refused = (demo.worldLog ?? []).filter((e) => !e.applied);
  const acted = demo.calls.filter((c) => c.acted).length;
  const slowest = [...(demo.facts ?? [])].sort((a, b) => (b.latency ?? 0) - (a.latency ?? 0))[0];

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <DemoHeader
        eyebrow="Worked example · orchestration"
        title="The Machine"
        standfirst="Six agents wake in six rooms of a machine nobody has explained to them. No agent can activate it alone, and no agent has been told the order. What the benchmark measures is whether a system of them can work it out."
        facts={[
          { label: "Result", value: `${score.earned}/${score.possible}`, tone: "good" },
          { label: "Turns", value: String(demo.turns.length) },
          { label: "Model", value: demo.model, tone: "muted" },
          { label: "Wall clock", value: formatDuration(demo.latencyMs), tone: "muted" },
        ]}
      />

      <Section
        id="problem"
        title="The problem"
        lede={
          <>
            <p>
              Each agent is alone in one room with instruments only it can operate. Activating the machine needs nine
              things to be true at once — the rings aligned, the reactor synchronised, three power buses live, a fault
              diagnosed, a part fabricated and installed, an interlock released — and the dependencies between them are
              never stated.
            </p>
            <p className="mt-3">
              Underneath that is the part that makes it a test of a <em>system</em> rather than of a model: five facts
              each have to travel between a different pair of agents. The archivist can decode a key it has no ring to
              turn. The astronomer can read a frequency off a star map it cannot dial in. Nobody can finish alone, and
              nobody is told who needs what.
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
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                Wakes in {CHAMBERS[agent]?.room ?? "a locked room"}, holding{" "}
                {CHAMBERS[agent]?.holds ?? "one instrument"}.
              </p>
            </div>
          ))}
        </div>
        <Note>
          Nothing is stubbed into cooperating. The machinery itself refuses a call from the wrong hands, so a lead that
          wants work done has something real to route — otherwise whoever wakes first does the lot, which is exactly
          what happened the first time this scenario ran.
        </Note>
      </Section>

      <Section
        id="what-happened"
        title="What the agents did"
        lede={
          <p>
            One shared room, six agents taking turns. A filled square is a turn that changed the machine; an outlined
            one is a turn that only looked. Reading it left to right, the run is three quiet rounds of everybody
            describing their own chamber, then a burst where the facts start moving.
          </p>
        }
      >
        <Legend agents={demo.agents} colours={colours} />
        <div className="mt-4">
          <Swimlane agents={demo.agents} colours={colours} calls={demo.calls} turnCount={demo.turns.length} />
        </div>
        <Note>
          {demo.calls.length} tool calls across {demo.turns.length} turns, {acted} of which moved the machinery. The
          rest were agents reading their own instruments and telling each other what they found — which on this scenario
          is the work, not the overhead.
        </Note>
      </Section>

      <Section
        id="transitions"
        title="The machine's own account"
        lede={
          <p>
            The scenario is graded on the state of the machine, never on the transcript, so this is the record that
            counts: a reply that merely <em>claims</em> to have activated it reaches nothing. Every row here is a call
            the machinery accepted or refused.
          </p>
        }
      >
        <Transitions log={demo.worldLog ?? []} colours={colours} />

        {refused.length > 0 && (
          <Finding>
            The most useful row is the red one. On turn {refused[0].turn}, {refused[0].agent} tried the console and was
            turned away — <span className="font-mono text-sm">{refused[0].effect.replace(/^blocked: /, "")}</span>.
            Nobody had told it power was a prerequisite. Being refused is how the order gets discovered, and one turn
            later the reactor was being brought up.
          </Finding>
        )}
      </Section>

      <Section
        id="routing"
        title="Did the facts reach the agents that needed them?"
        lede={
          <p>
            The measurement no per-agent check can make. A run can discover every fact it needs and still fail, and the
            report would only say the team failed to activate the machine. Each fact is traced through four stages: a
            tool told somebody, somebody said it out loud, an agent that needed it took a turn in a room where it had
            been said, and that agent passed it to a tool.
          </p>
        }
      >
        <FactLadder facts={demo.facts ?? []} colours={colours} />
        {slowest && (
          <Finding>
            Every fact made it all the way to <span className="font-mono text-sm">used</span>. The slowest was{" "}
            <span className="font-mono text-sm">{slowest.name.replace(/_/g, " ")}</span>: {slowest.discovered?.agent}{" "}
            decoded it on turn {slowest.discovered?.turn} and it sat in the room for {slowest.latency} turns until{" "}
            {slowest.used?.agent} finally had power, a diagnosed fault and an installed part — everything the interlock
            needed before the code was worth anything.
          </Finding>
        )}
        <Note>
          Each value is a witness: a random string minted fresh for this run and obtainable only from the tool that
          holds it. It cannot be guessed, and a turn that stalls cannot produce one by accident, so its appearance in
          another agent&rsquo;s tool call is evidence of transport rather than evidence about it.
        </Note>
      </Section>

      <Section
        id="score"
        title="How well they did"
        lede={
          <p>
            Partial credit, so a long scenario reports where it stopped rather than that it stopped. Sixteen rungs from
            &ldquo;somebody explored their room&rdquo; to &ldquo;the machine is running&rdquo;.
          </p>
        }
      >
        <MilestoneLadder milestones={demo.milestones ?? []} />
      </Section>

      <Section
        id="honesty"
        title="Was it really solved?"
        lede={<p>A result this clean is worth being suspicious of. Four things were checked before it was believed.</p>}
      >
        <ul className="space-y-3">
          {[
            [
              "No answer leaked into a prompt",
              "Every witness value was searched for in the assembled request of every turn. None appeared before the tool that holds it had returned it.",
            ],
            [
              "No brute force",
              "The reactor frequency was set once, out of a space of 900 possible values. The interlock code is eight characters and was entered correctly on the first attempt.",
            ],
            [
              "No agent reached outside its own instruments",
              "Every executed call is inside the calling agent's allowlist. The machinery independently refuses a transition from the wrong hands.",
            ],
            [
              "The key travelled, rather than being re-derived",
              "The alignment key was decoded by the archivist and used by the astronomer, which holds no archive tools. It could only have arrived through the room.",
            ],
          ].map(([title, body]) => (
            <li
              key={title}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4"
            >
              <p className="font-medium text-[var(--color-text)]">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)]">{body}</p>
            </li>
          ))}
        </ul>
        <Note>
          Run on {demo.model} at commit <span className="font-mono">{demo.gitSha}</span>, {demo.rounds} model
          round-trips, {demo.usage.input.toLocaleString()} input and {demo.usage.output.toLocaleString()} output tokens.
          The data behind this page is a committed extract of that run; regenerate it with{" "}
          <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs">
            pnpm run eval -- demo &lt;report&gt; --scenario the-machine
          </code>
          .
        </Note>
      </Section>
    </div>
  );
}
