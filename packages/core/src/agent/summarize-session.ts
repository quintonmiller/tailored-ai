import type Database from "better-sqlite3";
import { createNote, listNotes, type Note } from "../db/note-queries.js";
import { findIdleSessions, getSession, getSessionMessages } from "../db/queries.js";
import type { AIProvider } from "../providers/interface.js";
import { summarizeMessages } from "./loop.js";

/** Tag applied to auto-generated session summaries so they can be filtered. */
export const SESSION_SUMMARY_TAG = "session-summary";

/** Default TTL for session summaries — longer than the user-note default (14d). */
const DEFAULT_TTL_DAYS = 30;

/** Minimum message count to consider a session worth summarizing. */
const MIN_MESSAGES_TO_SUMMARIZE = 4;

export interface SummarizeSessionOptions {
  /** Force re-summarization even if a `session-summary` note already exists. */
  force?: boolean;
  /** Override TTL on the resulting note. Default 30 days. Pass 0 for no TTL. */
  ttlDays?: number;
  /** Author of the summary. Default null (system). */
  agent?: string | null;
  /** Extra tags to add alongside `session-summary`. */
  tags?: string[];
}

export interface SummarizeSessionResult {
  noteId: string;
  importance: number;
  messageCount: number;
}

/**
 * Summarize a session's transcript and write the result as a note. Returns
 * null when the session is too short, missing, or already summarized (unless
 * `force` is set). See docs/memory-tiers.md (M4).
 *
 * Importance scales with size: more messages + more tool calls → more
 * durable summary. Clamped to [0, 1].
 */
export async function summarizeSession(
  db: Database.Database,
  sessionId: string,
  provider: AIProvider,
  model: string,
  opts: SummarizeSessionOptions = {},
): Promise<SummarizeSessionResult | null> {
  const session = getSession(db, sessionId);
  if (!session) return null;

  const messages = getSessionMessages(db, sessionId);
  if (messages.length < MIN_MESSAGES_TO_SUMMARIZE) return null;

  if (!opts.force) {
    const existing = listNotes(db, {
      session_id: sessionId,
      tag: SESSION_SUMMARY_TAG,
      limit: 1,
    });
    if (existing.length > 0) return null;
  }

  const summary = await summarizeMessages(messages, provider, model);
  if (!summary.trim()) return null;

  let toolCalls = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) toolCalls += m.toolCalls.length;
  }
  const importance = computeImportance(messages.length, toolCalls);

  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const ttlAt = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null;

  const note = createNote(db, {
    content: summary,
    session_id: sessionId,
    project_id: session.project_id ?? null,
    agent: opts.agent ?? null,
    tags: [SESSION_SUMMARY_TAG, ...(opts.tags ?? [])],
    importance,
    ttl_at: ttlAt,
  });

  return { noteId: note.id, importance, messageCount: messages.length };
}

/**
 * Importance heuristic. Big multi-tool sessions land at 1.0; small chats
 * stay around 0.2-0.4. Tunable later from observed behavior.
 */
export function computeImportance(messageCount: number, toolCallCount: number): number {
  const sizeScore = Math.min(messageCount / 40, 1);
  const toolScore = Math.min(toolCallCount / 15, 1);
  // 60% size, 40% tool usage — tool-heavy sessions are more "did stuff" worthy.
  const blended = 0.6 * sizeScore + 0.4 * toolScore;
  // Floor a bit above zero so any qualifying session leaves something.
  return Math.max(0.2, Math.min(1, blended));
}

export interface SweepIdleSessionsOptions {
  /** Idle threshold in minutes. Default 60. */
  idleMinutes?: number;
  /** Only summarize sessions whose key starts with one of these (e.g. ["autopilot:", "cron:"]). */
  keyPrefixes?: string[];
  /** Cap per sweep. Default 20. */
  limit?: number;
  /** Forwarded to summarizeSession. */
  summarize?: SummarizeSessionOptions;
}

export interface SweepResult {
  scanned: number;
  summarized: SummarizeSessionResult[];
  skipped: string[];
  failed: Array<{ sessionId: string; error: string }>;
}

/**
 * Find sessions older than `idleMinutes` and summarize them. Idempotent —
 * sessions that already have a `session-summary` note are skipped unless
 * `summarize.force` is set.
 */
export async function sweepIdleSessions(
  db: Database.Database,
  provider: AIProvider,
  model: string,
  opts: SweepIdleSessionsOptions = {},
): Promise<SweepResult> {
  const idleMinutes = opts.idleMinutes ?? 60;
  const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();
  // Use SQLite-format cutoff for comparison with updated_at.
  const sqliteCutoff = cutoff.replace("T", " ").slice(0, 19);

  const candidates = findIdleSessions(db, sqliteCutoff, {
    keyPrefixes: opts.keyPrefixes,
    minMessages: MIN_MESSAGES_TO_SUMMARIZE,
    limit: opts.limit ?? 20,
  });

  const out: SweepResult = {
    scanned: candidates.length,
    summarized: [],
    skipped: [],
    failed: [],
  };

  for (const s of candidates) {
    try {
      const res = await summarizeSession(db, s.id, provider, model, opts.summarize);
      if (res) out.summarized.push(res);
      else out.skipped.push(s.id);
    } catch (err) {
      out.failed.push({ sessionId: s.id, error: (err as Error).message });
    }
  }
  return out;
}

/** Helper: most-recent session-summary note for a session, if any. */
export function getSessionSummary(db: Database.Database, sessionId: string): Note | null {
  const notes = listNotes(db, {
    session_id: sessionId,
    tag: SESSION_SUMMARY_TAG,
    limit: 1,
  });
  return notes[0] ?? null;
}

/** Module-internal export to keep test sizes honest without hardcoding the constant. */
export const __MIN_MESSAGES = MIN_MESSAGES_TO_SUMMARIZE;
