/**
 * Error room — puts failures in front of someone instead of in a log file.
 *
 * Errors that only reach `~/.tai/logs/agent.log` are found by accident, days
 * later, usually because something else looked wrong. This forwards them to a
 * room, where an agent can be subscribed to triage them: read the error, look
 * at the code or config it names, and say what it thinks is wrong.
 *
 * It reports; it does not fix. Deciding what to do about an error is the job of
 * whatever agent reads the room, which is config and prompt, not this file.
 *
 * ## The three ways this could go wrong, and what stops each
 *
 * **1. Reporting an error causes an error.** Posting to Discord can fail, and
 * that failure gets logged, which would be picked up and posted... A
 * re-entrancy flag means nothing logged *while reporting* is ever reported.
 * This is the failure that would take down a deployment, so it is guarded
 * first and unconditionally.
 *
 * **2. A flood.** One broken poller produced roughly a hundred thousand
 * ECONNREFUSED lines in a previous incident. Posting those one-per-message
 * would be far worse than the original bug. Three brakes: identical errors
 * collapse into one entry with a count, batches are posted on an interval
 * rather than per-error, and there is a hard ceiling per hour after which the
 * room is told only how many were withheld.
 *
 * **3. Secrets in error text.** Stack traces and config errors quote values,
 * and a token posted to a channel is a token you have to rotate. Anything that
 * looks like a credential is redacted before it leaves this module.
 */

import { resolveGate } from "../notifications/dedup.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import { getRoomBackend } from "../rooms/registry.js";
import { parseRoomRef } from "../rooms/types.js";
import type { AgentRuntime } from "../runtime.js";

export interface ErrorRoomConfig {
  /** Room name or `<backend>:<id>` ref to report into. Required. */
  room?: string;
  /** Agent to address each report to, so a `named` subscriber wakes on it. */
  notify?: string;
  /** Console levels to capture. Default: error only. */
  levels?: Array<"error" | "warn">;
  /** Seconds to collect before posting a batch. Default 30. */
  batchSeconds?: number;
  /** Most reports posted per hour. Default 6. */
  maxPerHour?: number;
  /** Distinct errors listed in one report. Default 5. */
  maxPerReport?: number;
  /** Substrings/regexes to never report — known, understood noise. */
  ignore?: string[];
}

const DEFAULTS = {
  levels: ["error"] as Array<"error" | "warn">,
  batchSeconds: 30,
  maxPerHour: 6,
  maxPerReport: 5,
};

/**
 * Redact anything credential-shaped.
 *
 * Deliberately over-eager: a redacted error is still diagnosable, whereas a
 * leaked token has to be rotated. Covers `key=value` forms for the usual
 * secret-ish names, bearer tokens, and the long opaque strings that tokens
 * tend to be.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(token|secret|password|passwd|api[-_]?key|authorization)\b(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\bBearer\s+[\w.-]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

/**
 * Collapse the variable parts of a message so the same failure recurring with
 * different ids counts as one thing. Without this, "task ptask_a1 failed" and
 * "task ptask_b2 failed" look like two distinct errors and both get reported.
 */
export function errorSignature(text: string): string {
  return text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}

interface Pending {
  signature: string;
  sample: string;
  count: number;
}

export class ErrorRoom {
  private readonly runtime: AgentRuntime;
  private readonly config: ErrorRoomConfig;
  private pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private restore: Array<() => void> = [];
  /** True while posting. Anything logged in here must not be reported. */
  private reporting = false;
  private postedThisHour = 0;
  private hourBucket = "";
  private withheld = 0;
  /** So an archived target room is complained about once, not per batch. */
  private warnedArchived = false;

  constructor(runtime: AgentRuntime, config: ErrorRoomConfig) {
    this.runtime = runtime;
    this.config = config;
  }

  start(): void {
    if (!this.config.room) {
      console.warn('[error-room] No "room" configured; nothing will be reported.');
      return;
    }

    for (const level of this.config.levels ?? DEFAULTS.levels) {
      const original = console[level].bind(console);
      const wrapped = (...args: unknown[]) => {
        // Pass through FIRST and always: this must never cost you a log line,
        // whatever happens afterwards.
        original(...args);
        try {
          this.capture(args);
        } catch {
          // A reporter that throws inside console.error would turn every log
          // call into a crash. There is nowhere safe to report this, so it is
          // dropped on purpose.
        }
      };
      console[level] = wrapped as typeof console.error;
      this.restore.push(() => {
        console[level] = original;
      });
    }

    const seconds = this.config.batchSeconds ?? DEFAULTS.batchSeconds;
    this.timer = setInterval(() => void this.flush(), seconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    for (const undo of this.restore) undo();
    this.restore = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  private capture(args: unknown[]): void {
    if (this.reporting) return;

    const text = redactSecrets(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    if (!text.trim()) return;
    // Our own lines would be reported, then reported again from the room.
    if (text.startsWith("[error-room]")) return;

    for (const pattern of this.config.ignore ?? []) {
      try {
        if (new RegExp(pattern, "i").test(text)) return;
      } catch {
        if (text.toLowerCase().includes(pattern.toLowerCase())) return;
      }
    }

    const signature = errorSignature(text);
    const existing = this.pending.get(signature);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.pending.set(signature, { signature, sample: text.slice(0, 400), count: 1 });
  }

  private withinHourlyBudget(): boolean {
    const bucket = new Date().toISOString().slice(0, 13);
    if (bucket !== this.hourBucket) {
      this.hourBucket = bucket;
      this.postedThisHour = 0;
      this.withheld = 0;
    }
    return this.postedThisHour < (this.config.maxPerHour ?? DEFAULTS.maxPerHour);
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0 || this.reporting) return;

    const batch = [...this.pending.values()];
    this.pending.clear();

    if (!this.withinHourlyBudget()) {
      this.withheld += batch.length;
      return;
    }

    const room = this.runtime.getRoomStore().resolve(this.config.room ?? "");
    if (!room) return;
    // Errors posted into an archived room reach nobody: no agent is woken there
    // and nobody is reading it. Say so once, on the console, which is the very
    // place this plugin exists to get failures out of.
    if (room.archivedAt) {
      if (!this.warnedArchived) {
        this.warnedArchived = true;
        console.warn(
          `[error-room] "${room.name}" is archived, so errors are not being reported there. ` +
            `Unarchive it or point \`room:\` at a live one.`,
        );
      }
      return;
    }
    this.warnedArchived = false;
    const ref = parseRoomRef(`${room.ref.backend}:${room.ref.id}`);
    const backend = ref ? getRoomBackend(ref.backend) : undefined;
    if (!ref || !backend) return;

    const limit = this.config.maxPerReport ?? DEFAULTS.maxPerReport;
    const shown = batch.slice(0, limit);
    const lines = shown.map((e) => `• ${e.sample}${e.count > 1 ? `  _(×${e.count})_` : ""}`);
    if (batch.length > shown.length) {
      lines.push(`• …and ${batch.length - shown.length} other distinct error(s).`);
    }
    if (this.withheld > 0) {
      lines.push(`_${this.withheld} earlier report(s) withheld this hour to avoid flooding._`);
      this.withheld = 0;
    }

    this.reporting = true;
    try {
      // Through the dedup gate so an error that recurs every hour does not
      // fill the room with the same paragraph. Keyed on the signatures, so a
      // genuinely new failure always gets through.
      const gate = resolveGate(() => this.runtime.getNotificationGate());
      await gate.deliver(
        {
          source: "error-room",
          channel: ref.backend,
          target: ref.id,
          content: lines.join("\n"),
          key: shown
            .map((e) => e.signature)
            .join("|")
            .slice(0, 200),
          windowHours: 1,
        },
        async () => {
          await backend.post(ref.id, {
            body: lines.join("\n"),
            speaker: "log",
            to: this.config.notify ? [this.config.notify] : [],
          });
          this.postedThisHour += 1;
        },
      );
    } catch {
      // Reporting failed. Saying so through console.error would be captured on
      // the next tick and reported, which is the loop this guard exists for.
    } finally {
      this.reporting = false;
    }
  }
}

const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const reporter = new ErrorRoom(ctx.runtime, (ctx.config ?? {}) as ErrorRoomConfig);
  reporter.start();
  return () => reporter.stop();
};

export const meta: PluginMeta = {
  name: "Error room",
  description:
    "Forwards errors to a room, batched, deduplicated and redacted, so an agent can triage them instead of nobody reading the log.",
  registers: [{ kind: "eventSubscriber", id: "error-room" }],
};

export default plugin;
