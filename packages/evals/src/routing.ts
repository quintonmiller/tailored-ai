/**
 * Where each fact got to.
 *
 * Every other measurement in this package is about one agent: did it pick the
 * right tool, did it reach the right state, did it answer correctly. That is the
 * right question while single-agent tool use is still unreliable, and it stops
 * being the interesting one the moment it isn't — because a team of individually
 * competent agents fails in a way none of them can be blamed for.
 *
 * The observed shape of it, from the orchestration scenarios: the system
 * discovers every fact required to solve the problem, and never gets one of them
 * to the agent it was useless without. Graded on the world alone that reads as
 * "the team could not activate the machine". Graded here it reads as "the glyph
 * map was found on turn 6, said out loud on turn 7, and the only agent who
 * needed it never touched it" — which is a different defect with a different
 * fix, and one that lives in the framework rather than in the model.
 *
 * ## The ladder, and why `received` is deliberately weak
 *
 *   discovered  a tool result contained the value
 *   shared      a post contained it
 *   received    an agent that needed it took a turn in a room it was posted in
 *   used        that agent passed it to a tool
 *
 * `received` claims the value was in front of the agent, not that the agent read
 * it. That is the honest ceiling of what a transcript can show, and it is where
 * the useful gap is: `shared` but not `received` is a routing failure, and
 * `received` but not `used` is an attention failure. Those want opposite fixes —
 * the first is a delivery bug, the second is a prompt or a model limit — and a
 * single "it didn't work" cannot tell them apart.
 *
 * Every stage is a substring match on a value the run minted, so none of it can
 * be satisfied by paraphrase, plausibility, or an agent claiming to have been
 * told. It is the witness idea applied to transport.
 */

import type { FactSpec, FactStage, FactTrace, RunOutcome } from "./types.js";

/** Ordered easiest-first, so "the first stage it did not reach" is well defined. */
export const FACT_STAGES: FactStage[] = ["discovered", "shared", "received", "used"];

function contains(haystack: string | undefined, needle: string): boolean {
  if (!haystack || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Anything with a `turn`, ordered. Absent turns sort first, which is where the seeding lives. */
function byTurn<T extends { turn?: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.turn ?? -1) - (b.turn ?? -1));
}

export function traceFact(name: string, spec: FactSpec, outcome: RunOutcome): FactTrace {
  const value = spec.value;
  const required = spec.requiredBy ?? [];

  // Whoever's tool said it first — not filtered by `discoverableBy`. A fact
  // surfacing somewhere the scenario did not expect is a finding, and filtering
  // it out would report the run as never having discovered it at all.
  const discovery = byTurn(outcome.executions ?? []).find((e) => contains(e.result, value));
  const discovered = discovery?.agent
    ? { agent: discovery.agent, turn: discovery.turn ?? 0 }
    : discovery
      ? { agent: "?", turn: discovery.turn ?? 0 }
      : undefined;

  // Every post carrying the value, not just the first: with more than one room
  // a fact can be said in one channel and repeated in another, and the second
  // saying is the relay — the whole thing a split graph exists to measure.
  const said = byTurn(outcome.posts).filter((p) => contains(p.body, value));
  const post = said[0];
  const shared = post ? { agent: post.agent ?? "?", turn: post.turn ?? 0, room: post.room } : undefined;

  // An agent that took a turn **in a room where the value had been posted** saw
  // it: every turn here is a poll, and a poll delivers what is unread in that
  // room. Read off the turn roster rather than off the agent's own output,
  // because an agent can be told something and say nothing — which is one of the
  // failures worth catching, and inferring receipt from its posts would score it
  // as never having been told.
  //
  // The room check is not a refinement, it is the correctness of the stage. It
  // used to be "took any turn after the value was posted", which is sound with
  // one shared room and false the moment there are two: the first split-room run
  // reported `received boron@18` for a frequency posted only in the north
  // channel, which Boron is not in and never saw. That is a false positive on
  // the one stage the scenario exists to measure, and it points the diagnosis at
  // the wrong agent — Boron looks like it ignored a number nobody ever sent it.
  const receiver = (outcome.turns ?? [])
    .map((t, index) => ({ ...t, index }))
    .find((t) => required.includes(t.agent) && said.some((p) => p.room === t.room && (p.turn ?? 0) < t.index));
  const received = receiver ? { agent: receiver.agent, turn: receiver.index } : undefined;

  // Passed to a tool by an agent that needed it. With no `requiredBy`, anyone
  // but the discoverer counts — the point is transport, and a discoverer feeding
  // its own result back into its own tool has transported nothing.
  const use = byTurn(outcome.executions ?? []).find((e) => {
    if (!Object.values(e.args).some((v) => contains(typeof v === "string" ? v : JSON.stringify(v), value)))
      return false;
    if (required.length) return e.agent !== undefined && required.includes(e.agent);
    return e.agent !== discovered?.agent;
  });
  const used = use ? { agent: use.agent ?? "?", turn: use.turn ?? 0, tool: use.name } : undefined;

  return {
    name,
    value,
    ...(discovered ? { discovered } : {}),
    ...(shared ? { shared } : {}),
    ...(received ? { received } : {}),
    ...(used ? { used } : {}),
    latency: discovered && used ? used.turn - discovered.turn : null,
  };
}

export function traceFacts(facts: Record<string, FactSpec> | undefined, outcome: RunOutcome): FactTrace[] {
  if (!facts) return [];
  return Object.entries(facts).map(([name, spec]) => traceFact(name, spec, outcome));
}

/** True once the fact got at least this far. Stages are cumulative by construction. */
export function reached(trace: FactTrace, stage: FactStage): boolean {
  return trace[stage] !== undefined;
}

/**
 * The first stage a fact did not reach, which is the whole diagnosis.
 *
 * Null when it made it all the way. Skips stages that are structurally absent —
 * a fact nobody `requiredBy` can never be `received`, and reporting that as the
 * failure would point at the scenario rather than at the run.
 */
export function stalledAt(trace: FactTrace, hasRequirer: boolean): FactStage | null {
  for (const stage of FACT_STAGES) {
    if (!hasRequirer && (stage === "received" || stage === "used")) continue;
    if (!reached(trace, stage)) return stage;
  }
  return null;
}

/**
 * One line per fact, for a failure report.
 *
 *     glyph_map      discovered cipher@6 · shared cipher@7 · never received
 */
export function formatFactTrace(trace: FactTrace, hasRequirer: boolean): string {
  const parts: string[] = [];
  for (const stage of FACT_STAGES) {
    if (!hasRequirer && (stage === "received" || stage === "used")) continue;
    const at = trace[stage];
    if (at) parts.push(`${stage} ${at.agent}@${at.turn}`);
    else {
      parts.push(`never ${stage}`);
      break;
    }
  }
  const lag = trace.latency === null ? "" : ` (${trace.latency} turn${trace.latency === 1 ? "" : "s"})`;
  return `${trace.name}: ${parts.join(" · ")}${lag}`;
}
