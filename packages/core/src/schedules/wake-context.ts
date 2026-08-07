/**
 * What a scheduled wake tells the agent about itself.
 *
 * Its own module because both sides of the wake need it — the runner builds it,
 * the room watcher renders it into a prompt — and importing the runner from the
 * watcher (which the runner imports back) would be a cycle.
 */

import { formatDistance } from "./when.js";

export interface WakeContext {
  scheduleId: string;
  /** What the agent wrote when it decided this moment mattered. This IS the wake. */
  note: string;
  kind: "once" | "repeat";
  /** The phrase the agent originally used, so it recognises its own work. */
  source: string;
  createdAt: Date;
  /** Which run this one is, counting from 1. */
  runCount: number;
  /** Milliseconds between when the wake was due and when it actually ran. */
  lateBy: number;
}

/** " for now (booked 2h ago)" — how the agent recognises its own past decision. */
export function describeBooking(ctx: WakeContext, now: Date): string {
  const age = now.getTime() - ctx.createdAt.getTime();
  if (age < 60_000) return " for now";
  return ` for now (booked ${formatDistance(age)} ago)`;
}

/**
 * Say when a wake is late rather than pretending it is on time. No guess at the
 * cause: the agent cannot act on a guess, and the log has the real answer.
 */
export function lateLine(lateBy: number): string[] {
  if (lateBy < 120_000) return [];
  return [`This fired ${formatDistance(lateBy)} late.`];
}

/**
 * A recurring wake carries its own id and age so the agent can retire it.
 *
 * This is the whole brake on forgotten recurrences. Rather than expiring them
 * on a timer the agent never sees, every occurrence says what it is and how to
 * stop it, which makes the agent the collector of its own garbage. Informing
 * beats overriding.
 */
export function recurringLine(ctx: WakeContext): string[] {
  if (ctx.kind !== "repeat") return [];
  const runs = ctx.runCount === 1 ? "1st run" : `run ${ctx.runCount}`;
  return [
    `This is recurring wake ${ctx.scheduleId} ("${ctx.source}", ${runs}).`,
    `If it is no longer useful, cancel it: schedule(action="cancel", id="${ctx.scheduleId}").`,
  ];
}
