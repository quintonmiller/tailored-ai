/**
 * Opt-in session summarizer — closes the cross-channel continuity gap.
 *
 * Sessions are hermetic per-channel silos (`discord:<user>`, `web:<key>`).
 * When one goes idle nothing summarizes it, so a brand-new session on a
 * different channel starts from zero — the classic "the agent introduced
 * itself to its owner of six months" failure.
 *
 * This plugin runs a periodic sweep that:
 *   1. Summarizes idle sessions via {@link sweepIdleSessions}
 *      (idempotent — a session that already has a `session-summary` note is
 *      skipped, so no LLM call and no double-write).
 *   2. Refreshes the always-injected `recent_summary` core-memory section
 *      from the most recent summaries, so the *next* session on *any*
 *      channel sees what happened — that section is what gives continuity.
 *
 * It autonomously calls the LLM (summarization) and writes memory, so it
 * ships **disabled by default** (`DEFAULT_DISABLED_PLUGIN_MODULES`). Users
 * opt in by flipping the seeded entry's `enabled` to `true`. Anyone who
 * doesn't enable it sees no behavior change.
 *
 * Same shape as the other built-ins (`agent-notifier`, `stall-guard`): a
 * class plus a default-export `register(ctx)` that constructs it against
 * `ctx.runtime` and returns a disposer. Config knobs come from `ctx.config`.
 */

import type Database from "better-sqlite3";
import { SESSION_SUMMARY_TAG, sweepIdleSessions } from "../agent/summarize-session.js";
import { type CoreMemoryRow, getCoreMemorySection, setCoreMemory } from "../db/core-memory-queries.js";
import { listNotes } from "../db/note-queries.js";
import { getSession } from "../db/queries.js";
import type { Plugin } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";

/** Defaults — all overridable from the plugin's `ctx.config` bag. */
const DEFAULTS = {
  /** Sweep cadence in minutes. */
  intervalMinutes: 30,
  /** Only sessions idle at least this long (minutes) are summarized. */
  idleMinutes: 120,
  /** Hard cap on sessions summarized per sweep — bounds LLM cost. */
  maxPerSweep: 5,
  /** When true, refresh the `recent_summary` core-memory section after a sweep. */
  updateRecentSummary: true,
  /** How many recent summaries to compose into `recent_summary`, newest first. */
  recentSummaryCount: 3,
  /** Byte cap for the composed `recent_summary` — keep the always-injected layer small. */
  recentSummaryMaxBytes: 600,
} as const;

/**
 * Agent the seeded `recent_summary` is keyed by. Sessions don't store an
 * agent, and an anonymous chat (Discord DM, fresh CLI) runs as the
 * `"default"` agent — that's the scope `agent/loop.ts` reads core memory
 * with. Writing here lands exactly where the next turn reads it.
 */
const FALLBACK_AGENT = "default";

const LOG_PREFIX = "[session-summarizer]";

export interface SessionSummarizerConfig {
  intervalMinutes?: number;
  idleMinutes?: number;
  maxPerSweep?: number;
  keyPrefixes?: string[];
  updateRecentSummary?: boolean;
  recentSummaryCount?: number;
  recentSummaryMaxBytes?: number;
}

export interface SessionSummarizerOptions {
  runtime: AgentRuntime;
  config?: SessionSummarizerConfig;
}

export class SessionSummarizer {
  private runtime: AgentRuntime;
  private cfg: Required<Omit<SessionSummarizerConfig, "keyPrefixes">> & { keyPrefixes?: string[] };
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping sweeps when one runs longer than the interval. */
  private running = false;

  constructor(opts: SessionSummarizerOptions) {
    this.runtime = opts.runtime;
    const c = opts.config ?? {};
    this.cfg = {
      intervalMinutes: numberOr(c.intervalMinutes, DEFAULTS.intervalMinutes),
      idleMinutes: numberOr(c.idleMinutes, DEFAULTS.idleMinutes),
      maxPerSweep: numberOr(c.maxPerSweep, DEFAULTS.maxPerSweep),
      updateRecentSummary: c.updateRecentSummary ?? DEFAULTS.updateRecentSummary,
      recentSummaryCount: numberOr(c.recentSummaryCount, DEFAULTS.recentSummaryCount),
      recentSummaryMaxBytes: numberOr(c.recentSummaryMaxBytes, DEFAULTS.recentSummaryMaxBytes),
      keyPrefixes: Array.isArray(c.keyPrefixes) && c.keyPrefixes.length > 0 ? c.keyPrefixes : undefined,
    };
  }

  /** Start the periodic sweep timer. Unref'd so it never holds the process open. */
  start(): void {
    if (this.timer) return;
    const intervalMs = this.cfg.intervalMinutes * 60_000;
    this.timer = setInterval(() => {
      void this.runSweep();
    }, intervalMs);
    // Never keep the event loop alive on this timer alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep: summarize idle sessions, then refresh `recent_summary`.
   * Public so tests can drive it directly (and `start()` calls it on each
   * tick). Re-entrancy guarded — a sweep already in flight is a no-op.
   */
  async runSweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await sweepIdleSessions(this.runtime.db, this.runtime.getProvider(), this.runtime.getModel(), {
        idleMinutes: this.cfg.idleMinutes,
        keyPrefixes: this.cfg.keyPrefixes,
        limit: this.cfg.maxPerSweep,
      });

      // Silent when nothing was summarized (the common steady state).
      if (result.summarized.length === 0) return;

      console.log(
        `${LOG_PREFIX} swept ${result.scanned} idle session(s): ` +
          `${result.summarized.length} summarized, ${result.skipped.length} skipped, ${result.failed.length} failed`,
      );

      if (this.cfg.updateRecentSummary) {
        this.refreshRecentSummaries(result.summarized.map((r) => r.sessionId));
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Refresh the `recent_summary` core-memory section for each distinct
   * (agent, project) scope touched by the just-summarized sessions. Composes
   * the section from the most recent summary notes for that scope, newest
   * first, hard-capped so the always-injected layer stays small.
   */
  private refreshRecentSummaries(sessionIds: string[]): void {
    const seen = new Set<string>();
    for (const sessionId of sessionIds) {
      const session = getSession(this.runtime.db, sessionId);
      const projectId = session?.project_id ?? null;
      const scopeKey = `${FALLBACK_AGENT}::${projectId ?? ""}`;
      if (seen.has(scopeKey)) continue;
      seen.add(scopeKey);
      this.writeRecentSummary(projectId);
    }
  }

  /** Compose + write the `recent_summary` section for one project scope. */
  private writeRecentSummary(projectId: string | null): void {
    const content = composeRecentSummary(this.runtime.db, projectId, {
      count: this.cfg.recentSummaryCount,
      maxBytes: this.cfg.recentSummaryMaxBytes,
    });
    if (!content) return;

    const existing = getCoreMemorySection(
      this.runtime.db,
      { agent: FALLBACK_AGENT, project_id: projectId },
      "recent_summary",
    );
    // Skip the write when nothing changed — keeps updated_at stable and avoids
    // churn when a sweep summarizes a session but the composed text is identical.
    if (existing?.content === content) return;

    setCoreMemory(this.runtime.db, {
      agent: FALLBACK_AGENT,
      project_id: projectId,
      section: "recent_summary",
      content,
      updated_by: "session-summarizer",
    });
  }
}

/**
 * Build the `recent_summary` text from the most recent `session-summary`
 * notes for a project scope, newest first. Hard-capped to `maxBytes` so the
 * always-injected layer stays small for local models — whole summaries are
 * dropped from the tail rather than mid-sentence truncation.
 *
 * Exported so tests can pin composition + capping without a timer.
 */
export function composeRecentSummary(
  db: Database.Database,
  projectId: string | null,
  opts: { count: number; maxBytes: number },
): string {
  // Newest-first; listNotes orders by created_at DESC, rowid DESC.
  const notes = listNotes(db, {
    tag: SESSION_SUMMARY_TAG,
    project_id: projectId,
    limit: opts.count,
    excludeExpired: true,
  });
  if (notes.length === 0) return "";

  const parts: string[] = [];
  let used = 0;
  for (const note of notes) {
    const line = `- ${note.content.trim()}`;
    // +1 for the joining newline between blocks (none before the first).
    const cost = line.length + (parts.length > 0 ? 1 : 0);
    if (used + cost > opts.maxBytes) break;
    parts.push(line);
    used += cost;
  }
  return parts.join("\n");
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Re-export the row type for consumers that introspect the written section. */
export type { CoreMemoryRow };

/**
 * Default-plugin entry point — loaded via `config.plugins:
 * builtin:session-summarizer`. Constructs a {@link SessionSummarizer} bound to
 * the live runtime, starts its timer, and returns a disposer that stops it.
 *
 * Reads its knobs from `ctx.config`:
 * `{ module: "builtin:session-summarizer", enabled: true, config: {
 *    intervalMinutes, idleMinutes, maxPerSweep, keyPrefixes,
 *    updateRecentSummary, recentSummaryCount, recentSummaryMaxBytes } }`.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const summarizer = new SessionSummarizer({
    runtime: ctx.runtime,
    config: ctx.config as SessionSummarizerConfig,
  });
  summarizer.start();
  return () => summarizer.stop();
};
export default plugin;
