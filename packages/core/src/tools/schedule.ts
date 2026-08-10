/**
 * `schedule` — an agent booking its own future wake.
 *
 * Everything else that starts a turn is authored by somebody else: cron jobs
 * and room check-ins by the operator in `config.yaml`, message and poll wakes
 * by traffic. So an agent that says "I'll check back after the deploy" is
 * describing something no part of the system will do. This is the missing
 * piece, and its whole job is to make that sentence true.
 *
 * Two guarantees shape the surface:
 *
 *   - Every booking echoes back the absolute time it resolved to. A model that
 *     meant tomorrow and got today finds out in the same turn, while it can
 *     still fix it. This matters more than any amount of parser cleverness.
 *   - A rejected call answers with the grammar it wanted. Error text is the
 *     only documentation a model reliably reads.
 */

import type { EventBus } from "../events.js";
import type { RoomStore } from "../rooms/store.js";
import { WAKE_ROOMS_KEY } from "../rooms/watcher.js";
import { fromDbTime, type ScheduleRow, type ScheduleStore } from "../schedules/store.js";
import {
  formatDistance,
  formatLocal,
  nextOccurrence,
  occurrenceGapSeconds,
  parseEvery,
  parseWhen,
  WHEN_FORMS,
  WhenParseError,
} from "../schedules/when.js";
import { type ResolvedTimeProvider, systemTimeZone } from "../time/provider.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface ScheduleLimits {
  maxPerAgent: number;
  minIntervalMinutes: number;
  maxHorizonDays: number;
}

export interface ScheduleToolOptions {
  store: ScheduleStore;
  rooms?: RoomStore;
  limits: () => ScheduleLimits;
  events?: EventBus;
  /** Injectable clock, so booking maths is testable without waiting. */
  now?: () => Date;
  /** Runtime-owned clock and timezone. `now` remains as a focused test hook. */
  timeProvider?: ResolvedTimeProvider;
}

const ok = (output: string): ToolResult => ({ success: true, output });
const fail = (error: string): ToolResult => ({ success: false, output: "", error });

/** A booking a minute in the past is a clock skew, not a mistake. Further back is a mistake. */
const PAST_SLACK_MS = 60_000;

export class ScheduleTool implements Tool {
  name = "schedule";
  description =
    "Wake yourself later: once at a given time, or repeatedly on a pattern. Use it whenever you say you will come back to something — nothing else will bring you back.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["once", "repeat", "list", "cancel"],
        description: "once = a single future wake. repeat = a recurring one. list = what you have booked. cancel.",
      },
      when: {
        type: "string",
        description: `For action=once. ${WHEN_FORMS.join("; ")}`,
      },
      every: {
        type: "string",
        description:
          'For action=repeat. "every 30 minutes", "every 2 hours", "every 3 days", "weekdays at 9am", "every monday at 8:30".',
      },
      note: {
        type: "string",
        description:
          "For once/repeat. What you want to be told when you wake — this is all you will have to go on, so write it for a future you with no memory of now.",
      },
      starts: {
        type: "string",
        description: "For action=repeat, optional. When the pattern becomes active. Same forms as `when`.",
      },
      until: {
        type: "string",
        description: "For action=repeat, optional. When the pattern stops. Same forms as `when`.",
      },
      room: {
        type: "string",
        description: "Optional. Which room to wake in, when more than one woke you this turn.",
      },
      id: {
        type: "string",
        description: 'For action=cancel. One id, or several separated by commas: "a3f1,b7c2".',
      },
      all: {
        type: "boolean",
        description: "For action=cancel. Cancel every wake you have booked.",
      },
    },
    required: ["action"],
  };

  constructor(private opts: ScheduleToolOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? this.opts.timeProvider?.now() ?? new Date();
  }

  private timeZone(): string {
    return this.opts.timeProvider?.timeZone() ?? systemTimeZone();
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const agent = context.agentName;
    if (!agent) {
      return fail("This session has no agent identity, so there is nobody to wake. schedule is unavailable here.");
    }
    const action = typeof args.action === "string" ? args.action : "";
    switch (action) {
      case "once":
        return this.once(args, context, agent);
      case "repeat":
        return this.repeat(args, context, agent);
      case "list":
        return this.list(agent);
      case "cancel":
        return this.cancel(args, agent);
      default:
        return fail(`Unknown action "${action}". Use once, repeat, list or cancel.`);
    }
  }

  // ------------------------------------------------------------------ booking

  private once(args: Record<string, unknown>, context: ToolContext, agent: string): ToolResult {
    const note = readNote(args);
    if (!note) return fail(NOTE_REQUIRED);
    const capped = this.checkCap(agent);
    if (capped) return fail(capped);

    const raw = typeof args.when === "string" ? args.when : "";
    if (!raw.trim()) return fail(`when is required for action=once. Use one of:\n${bulleted(WHEN_FORMS)}`);

    let at: Date;
    let defaultedTime: boolean;
    try {
      const parsed = parseWhen(raw, this.now(), this.timeZone());
      at = parsed.at;
      defaultedTime = parsed.defaultedTime;
    } catch (err) {
      return fail(err instanceof WhenParseError ? err.message : (err as Error).message);
    }

    const now = this.now();
    if (at.getTime() < now.getTime() - PAST_SLACK_MS) {
      return fail(`${formatLocal(at, this.timeZone())} has already passed. Give a time in the future.`);
    }
    const limits = this.opts.limits();
    const horizon = now.getTime() + limits.maxHorizonDays * 86_400_000;
    if (at.getTime() > horizon) {
      return fail(
        `${formatLocal(at, this.timeZone())} is more than ${limits.maxHorizonDays} days out, which is further than I can book.`,
      );
    }

    const target = this.resolveTarget(args, context, agent);
    if ("error" in target) return fail(target.error);

    const row = this.opts.store.create({
      agent,
      note,
      kind: "once",
      source: raw.trim(),
      nextRunAt: at,
      targetKind: target.kind,
      target: target.ref,
      createdAt: now,
    });
    this.emitCreated(row);

    return ok(
      [
        `Scheduled ${row.id} for ${formatLocal(at, this.timeZone())} (in ${formatDistance(at.getTime() - now.getTime())}), ${this.describeTarget(target)}.`,
        // Said out loud rather than assumed: a date with no time is the single
        // most likely place for the agent's intent and the booking to diverge.
        ...(defaultedTime ? [`You gave a date with no time, so 09:00 was used.`] : []),
      ].join(" "),
    );
  }

  private repeat(args: Record<string, unknown>, context: ToolContext, agent: string): ToolResult {
    const note = readNote(args);
    if (!note) return fail(NOTE_REQUIRED);
    const capped = this.checkCap(agent);
    if (capped) return fail(capped);

    const raw = typeof args.every === "string" ? args.every : "";
    if (!raw.trim()) {
      return fail(
        'every is required for action=repeat. Try "every 30 minutes", "every 2 hours", "every 3 days", "weekdays at 9am", or "every monday at 8:30".',
      );
    }

    let rec: ReturnType<typeof parseEvery>;
    try {
      rec = parseEvery(raw);
    } catch (err) {
      return fail(`could not read "${raw}" as a repeating pattern: ${(err as Error).message}`);
    }

    const now = this.now();
    let startsAt: Date | null = null;
    let endsAt: Date | null = null;
    try {
      if (typeof args.starts === "string" && args.starts.trim()) {
        startsAt = parseWhen(args.starts, now, this.timeZone()).at;
      }
      if (typeof args.until === "string" && args.until.trim()) {
        endsAt = parseWhen(args.until, now, this.timeZone()).at;
      }
    } catch (err) {
      return fail(err instanceof WhenParseError ? err.message : (err as Error).message);
    }
    if (endsAt && endsAt.getTime() < now.getTime()) {
      return fail(`until (${formatLocal(endsAt, this.timeZone())}) has already passed.`);
    }

    const limits = this.opts.limits();
    const gap = occurrenceGapSeconds(rec, startsAt && startsAt > now ? startsAt : now, this.timeZone());
    if (gap !== null && gap < limits.minIntervalMinutes * 60) {
      return fail(
        `"${raw}" fires every ${formatDistance(gap * 1000)}, which is more often than the ${limits.minIntervalMinutes}-minute floor for repeating wakes.`,
      );
    }

    // A future start has to gate the first occurrence for both modes: interval
    // anchors on it, and cron is asked from just before it rather than from now.
    const from = startsAt && startsAt.getTime() > now.getTime() ? new Date(startsAt.getTime() - 1) : now;
    const first = nextOccurrence(rec, from, startsAt, this.timeZone());
    if (!first) return fail(`"${raw}" has no upcoming occurrence.`);
    if (endsAt && first.getTime() > endsAt.getTime()) {
      return fail(`"${raw}" has no occurrence before ${formatLocal(endsAt, this.timeZone())}.`);
    }

    const target = this.resolveTarget(args, context, agent);
    if ("error" in target) return fail(target.error);

    const row = this.opts.store.create({
      agent,
      note,
      kind: "repeat",
      cron: rec.mode === "cron" ? rec.cron : null,
      intervalSeconds: rec.mode === "interval" ? rec.seconds : null,
      source: raw.trim(),
      startsAt,
      endsAt,
      nextRunAt: first,
      targetKind: target.kind,
      target: target.ref,
      createdAt: now,
    });
    this.emitCreated(row);

    return ok(
      [
        `Scheduled ${row.id} to repeat "${raw.trim()}", ${this.describeTarget(target)}.`,
        `First wake ${formatLocal(first, this.timeZone())} (in ${formatDistance(first.getTime() - now.getTime())}).`,
        ...(endsAt ? [`Stops after ${formatLocal(endsAt, this.timeZone())}.`] : []),
      ].join(" "),
    );
  }

  // ------------------------------------------------------------------ reading

  private list(agent: string): ToolResult {
    const rows = this.opts.store.listForAgent(agent);
    if (rows.length === 0) return ok("You have no wakes booked.");
    const now = this.now();
    const lines = rows.map((r) => {
      const at = fromDbTime(r.next_run_at);
      const pattern = r.kind === "repeat" ? `repeats "${r.source}"` : "once";
      const where = r.target_kind === "room" ? this.roomName(r.target) : "this session";
      return `${r.id}  ${formatLocal(at, this.timeZone())} (in ${formatDistance(at.getTime() - now.getTime())})  ${pattern}  ${where}\n      "${r.note}"`;
    });
    return ok([`${rows.length} wake${rows.length === 1 ? "" : "s"} booked:`, ...lines].join("\n"));
  }

  private cancel(args: Record<string, unknown>, agent: string): ToolResult {
    if (args.all === true) {
      const n = this.opts.store.cancelAll(agent);
      this.opts.events?.emit("schedule.cancelled", { agent, ids: [], all: true, count: n });
      return ok(n === 0 ? "You had no wakes booked." : `Cancelled all ${n} of your booked wakes.`);
    }
    const raw = typeof args.id === "string" ? args.id : "";
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return fail('cancel needs an id ("a3f1", or "a3f1,b7c2" for several) or all=true.');

    const cancelled = this.opts.store.cancel(agent, ids);
    const missed = ids.filter((id) => !cancelled.includes(id));
    if (cancelled.length > 0) {
      this.opts.events?.emit("schedule.cancelled", { agent, ids: cancelled, all: false, count: cancelled.length });
    }
    if (cancelled.length === 0) {
      return fail(`No booked wake matches ${ids.join(", ")}. Call schedule(action="list") to see what you have.`);
    }
    return ok(
      [
        `Cancelled ${cancelled.join(", ")}.`,
        // Named rather than silently dropped: a partial cancel that reads as a
        // full one leaves the agent believing a wake is gone when it is not.
        ...(missed.length > 0 ? [`No booked wake matches ${missed.join(", ")}.`] : []),
      ].join(" "),
    );
  }

  // ------------------------------------------------------------------ helpers

  private checkCap(agent: string): string | null {
    const { maxPerAgent } = this.opts.limits();
    if (this.opts.store.countForAgent(agent) < maxPerAgent) return null;
    return `You already have ${maxPerAgent} wakes booked, which is the limit. Cancel one you no longer need first — schedule(action="list") shows them.`;
  }

  /**
   * Where the wake should land.
   *
   * The room a turn was woken for is already recorded in working memory for the
   * `room` tool's benefit, so a wake booked mid-conversation lands back in that
   * conversation without the agent having to name it. Several rooms means a
   * batched wake, and picking one would be a guess — so it asks.
   */
  private resolveTarget(
    args: Record<string, unknown>,
    context: ToolContext,
    agent: string,
  ): { kind: "room" | "session"; ref: string } | { error: string } {
    const explicit = typeof args.room === "string" ? args.room.trim() : "";
    if (explicit) {
      const subs = this.opts.rooms?.listSubscriptionsForAgent(agent) ?? [];
      const match = subs.find((s) => s.roomRef === explicit || this.roomName(s.roomRef) === explicit);
      if (!match) {
        return {
          error: `You are not subscribed to "${explicit}". Rooms you can wake in: ${subs.map((s) => this.roomName(s.roomRef)).join(", ") || "none"}.`,
        };
      }
      return { kind: "room", ref: match.roomRef };
    }

    const woken = (context.workingMemory?.get(WAKE_ROOMS_KEY) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (woken.length === 1) return { kind: "room", ref: woken[0] };
    if (woken.length > 1) {
      return {
        error: `You were woken for several rooms (${woken.map((r) => this.roomName(r)).join(", ")}), so name the one to wake in with room="…".`,
      };
    }
    return { kind: "session", ref: context.sessionId };
  }

  private describeTarget(target: { kind: "room" | "session"; ref: string }): string {
    if (target.kind === "room") return `waking in ${this.roomName(target.ref)}`;
    return "waking in this session — a reply there reaches nobody on its own, so send anything that needs to reach a person";
  }

  private roomName(ref: string): string {
    const room = this.opts.rooms?.getRoomByRef(ref);
    return room?.name ? `#${room.name}` : ref;
  }

  private emitCreated(row: ScheduleRow): void {
    this.opts.events?.emit("schedule.created", {
      id: row.id,
      agent: row.agent,
      kind: row.kind,
      source: row.source,
      note: row.note,
      nextRunAt: row.next_run_at,
      targetKind: row.target_kind,
      target: row.target,
    });
  }
}

const NOTE_REQUIRED =
  "note is required — say what you want to be told when you wake. A wake with no note arrives with nothing to act on.";

function readNote(args: Record<string, unknown>): string {
  return typeof args.note === "string" ? args.note.trim() : "";
}

function bulleted(items: readonly string[]): string {
  return items.map((f) => `  - ${f}`).join("\n");
}
