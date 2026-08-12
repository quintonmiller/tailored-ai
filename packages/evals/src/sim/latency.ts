/**
 * How long an organisation takes to react to something it was not expecting.
 *
 * Every other number this package produces is a property of an outcome: money
 * made, orders filled, state reached. They are the right things to optimise and
 * they are all *lagging* — by the time enterprise value has moved, whatever
 * caused it happened weeks ago and is no longer visible. Two teams can finish
 * within a few percent of each other having run completely different companies,
 * and the balance sheet cannot say which one was awake.
 *
 * This measures the thing that actually distinguishes an organisation from a
 * person with a lot of tools: **the delay between an event happening and the
 * right function acting on it**. It is the same idea as the `facts:` ladder in
 * `routing.ts` — discovered, shared, received, used — with two differences that
 * matter. The clock is in simulated days rather than turns, so the number means
 * something to a reader who does not know how the harness schedules turns; and
 * nobody is told the event happened. It has to be noticed.
 *
 * ## Why the cross-role flag is the interesting column
 *
 * The events worth measuring are visible to one function and answerable only by
 * another. A distributor leaving shows up in the sales history; the responses
 * that matter are the production plan, the headcount and the price — one of
 * which sales holds and two of which it does not. So a team that notices
 * quickly and acts within the noticing function has done half the job, and the
 * half it skipped is the half a single agent with six tools would have got for
 * free. `crossedRoles` is what separates "somebody reacted" from "the
 * organisation reacted".
 *
 * ## What it cannot see
 *
 * That a response was *caused* by the event. An agent whose routine includes
 * checking the plan every morning will look responsive to everything. This is
 * the same honest limit `received` has in the fact ladder, and the same
 * mitigation applies: the events are rare and the response sets are narrow, so
 * a policy of doing everything constantly is expensive in the objective the run
 * is actually scored on.
 */

import type { RecordedExecution } from "../types.js";
import type { SimEvent } from "./types.js";

export interface EventResponse {
  /** Simulated day the event happened. */
  day: number;
  kind: string;
  message: string;
  /** Roles that could see it by looking. Empty means anyone who looks. */
  visibleTo: string[];
  /** Day the first qualifying action ran, or null if nobody ever acted. */
  respondedDay: number | null;
  respondedBy?: string;
  respondedWith?: string;
  /**
   * Whether *any* qualifying response came from outside the function that could
   * see the event — that is, whether the news was routed at all.
   *
   * Read across every response rather than off the first one. A team where sales
   * spots a demand collapse and reacts immediately, and operations cuts the plan
   * a week later, is a functioning organisation; one where sales reacts and
   * nobody else ever hears is not. Judging the first response alone scores them
   * the same, which is the one distinction this whole file exists to draw.
   */
  crossedRoles?: boolean;
  /** The first response from outside the seeing function, when there was one. */
  routedDay?: number;
  routedBy?: string;
  routedWith?: string;
  /** Days from the event to that response — the organisation's real reaction time. */
  routedLatencyDays?: number;
  latencyDays: number | null;
}

export interface LatencySummary {
  events: number;
  answered: number;
  /** Mean days to respond, over answered events only. Null when none were. */
  meanDays: number | null;
  /** Worst answered event. The tail is where an organisation actually fails. */
  worstDays: number | null;
  /** Answered by somebody who could not see the event — i.e. it was routed. */
  crossRole: number;
  /** Mean days to the first *routed* response, over the events that got one. */
  routedMeanDays: number | null;
}

export interface TraceOptions {
  events: readonly SimEvent[];
  /** Event kind → tools whose use counts as acting on it. From the simulation. */
  responses: Record<string, string[]>;
  executions: readonly RecordedExecution[];
  /** Turn index → the simulated day that turn ran on. */
  dayOfTurn: readonly number[];
  /** Role → the agent holding it, so "could this agent see it" is answerable. */
  roles?: Record<string, string>;
}

/**
 * Pair each event with the first action that answers it.
 *
 * Only events with a declared response set are traced. A simulation that says
 * nothing about what answering an event looks like gets no rows rather than a
 * guess, because the alternative — treating any subsequent tool call as a
 * response — would report a latency of zero for every event on every run and
 * read as a perfect score.
 */
export function traceResponses(opts: TraceOptions): EventResponse[] {
  const { events, responses, executions, dayOfTurn, roles = {} } = opts;
  const agentOfRole = (role: string): string | undefined => roles[role];

  return events
    .filter((event) => (responses[event.kind] ?? []).length > 0)
    .map((event) => {
      const answering = new Set(responses[event.kind]);
      const visibleTo = event.visibleTo ?? [];
      const watchers = new Set(visibleTo.map(agentOfRole).filter((a): a is string => Boolean(a)));

      const answers = executions.filter((call) => {
        if (!answering.has(call.name)) return false;
        const day = dayOfTurn[call.turn ?? -1];
        // Strictly on or after the event's day. An action taken before it
        // happened is not a response to it, however well it worked out.
        return day !== undefined && day >= event.day;
      });
      const hit = answers[0];

      // The first response that came from *outside* the function that could see
      // the event, which is a different question from whether the first response
      // did — and the difference is not hypothetical. On the first live run of
      // `the-factory` a distributor left on day 24, sales cut prices the same
      // day, and nine days later operations cut the plan and the CEO cut the
      // headcount. Reading only the first response, that organisation scored
      // identically to one where sales reacted and nobody else ever heard about
      // it. Taking the first *routed* response separately is the only way the
      // metric can tell those two teams apart, which is the entire reason it
      // exists.
      const routed = watchers.size ? answers.find((call) => call.agent && !watchers.has(call.agent)) : undefined;

      if (!hit) {
        return {
          day: event.day,
          kind: event.kind,
          message: event.message,
          visibleTo,
          respondedDay: null,
          latencyDays: null,
        };
      }
      const day = dayOfTurn[hit.turn ?? 0];
      const routedDay = routed ? dayOfTurn[routed.turn ?? 0] : undefined;
      return {
        day: event.day,
        kind: event.kind,
        message: event.message,
        visibleTo,
        respondedDay: day,
        ...(hit.agent ? { respondedBy: hit.agent } : {}),
        respondedWith: hit.name,
        // Unknowable without a role map, and an unknown is not a claim: the
        // flag is left off rather than reported as false, so a report cannot
        // show "nothing was routed" for a scenario that never said who was who.
        ...(watchers.size && hit.agent ? { crossedRoles: Boolean(routed) } : {}),
        ...(routed
          ? {
              routedDay,
              routedBy: routed.agent,
              routedWith: routed.name,
              routedLatencyDays: (routedDay ?? 0) - event.day,
            }
          : {}),
        latencyDays: day - event.day,
      };
    });
}

export function summariseResponses(rows: readonly EventResponse[]): LatencySummary {
  const answered = rows.filter((r) => r.latencyDays !== null);
  const days = answered.map((r) => r.latencyDays as number);
  return {
    events: rows.length,
    answered: answered.length,
    meanDays: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
    worstDays: days.length ? Math.max(...days) : null,
    crossRole: rows.filter((r) => r.crossedRoles).length,
    routedMeanDays: (() => {
      const routed = rows.map((r) => r.routedLatencyDays).filter((d): d is number => d !== undefined);
      return routed.length ? Math.round((routed.reduce((a, b) => a + b, 0) / routed.length) * 10) / 10 : null;
    })(),
  };
}

/** One line per event, for a report that has to explain a slow organisation. */
export function formatResponses(rows: readonly EventResponse[]): string {
  if (!rows.length) return "  (no traced events)";
  return rows
    .map((r) => {
      const who = r.respondedBy ? ` by ${r.respondedBy}` : "";
      const how = r.respondedWith ? ` (${r.respondedWith})` : "";
      const routed =
        r.crossedRoles === true
          ? ` [routed to ${r.routedBy} on day ${r.routedDay}, +${r.routedLatencyDays}d]`
          : r.crossedRoles === false
            ? " [never left the function that saw it]"
            : "";
      const outcome =
        r.latencyDays === null
          ? "never answered"
          : `answered day ${r.respondedDay}, +${r.latencyDays}d${who}${how}${routed}`;
      return `  day ${String(r.day).padStart(3)}  ${r.kind.padEnd(20)} ${outcome}`;
    })
    .join("\n");
}
