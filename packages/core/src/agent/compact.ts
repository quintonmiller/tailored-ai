import type Database from "better-sqlite3";
import {
  getSessionMessages,
  listCompactions,
  markSessionCompacted,
  restoreCompactedMessages,
  saveMessage,
} from "../db/queries.js";
import type { EventBus } from "../events.js";
import type { AIProvider, Message } from "../providers/interface.js";
import { estimateTokens } from "./loop.js";

/**
 * Replace a conversation with a summary of it — reversibly.
 *
 * This used to `DELETE FROM messages` and write the summary in the originals'
 * place: no archive, no tombstone, no event. A summary is a model's account of
 * a conversation, and a model that drops the one fact that mattered dropped it
 * permanently. That is a strange thing to ship beside `agent/rewind.ts`, which
 * goes to some length to stay auditable and undoable for exactly this reason.
 *
 * So compaction now borrows rewind's mechanism. Compacted rows keep their place
 * and gain a `compacted_batch` number; `getSessionMessages` skips them, so the
 * model sees the summary and nothing else, while {@link undoCompaction} can put
 * the conversation back. The summary row is stamped with the batch it stands
 * for, so undoing removes it rather than leaving a summary of the conversation
 * sitting alongside the conversation.
 *
 * Making it reversible is also the precondition for making it automatic. A
 * destructive, lossy, model-authored rewrite is one thing to run deliberately
 * and another to trigger on a threshold.
 */

const MIN_MESSAGES = 4;

export interface CompactResult {
  skipped: boolean;
  reason?: string;
  beforeCount?: number;
  afterCount?: number;
  beforeTokens?: number;
  afterTokens?: number;
  /** Which compaction this was, for `undoCompaction`. Absent when skipped. */
  batch?: number;
}

export interface CompactOptions {
  /** Emits `session.compacted` so subscribers can archive, notify or audit. */
  events?: EventBus;
}

export async function compactSession(
  db: Database.Database,
  sessionId: string,
  provider: AIProvider,
  model: string,
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const messages = getSessionMessages(db, sessionId);

  if (messages.length < MIN_MESSAGES) {
    return { skipped: true, reason: `Only ${messages.length} messages, need at least ${MIN_MESSAGES}` };
  }

  // Serialize messages for summarization
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.content) {
      lines.push(`[${msg.role}]: ${msg.content}`);
    }
  }
  const transcript = lines.join("\n");

  let beforeTokens = 0;
  for (const msg of messages) beforeTokens += estimateTokens(msg);

  // Summarize via provider
  const response = await provider.chat({
    model,
    messages: [
      {
        role: "system",
        content:
          "Summarize this conversation concisely. Preserve key facts, decisions, and pending tasks. Output only the summary.",
      },
      { role: "user", content: transcript },
    ],
    temperature: 0.3,
  });

  const summary = response.content ?? "";

  // Summarise first, hide second. A provider that throws leaves the session
  // exactly as it was rather than hidden behind a summary that never arrived.
  const { batch, hidden } = markSessionCompacted(db, sessionId);
  const summaryMsg: Message = { role: "user", content: `[Conversation Summary]\n${summary}` };
  saveMessage(db, sessionId, summaryMsg, { compactionSummaryFor: batch });

  const afterTokens = estimateTokens(summaryMsg);

  opts.events?.emit("session.compacted", {
    sessionId,
    batch,
    messages: hidden,
    beforeTokens,
    afterTokens,
  });

  return {
    skipped: false,
    beforeCount: messages.length,
    afterCount: 1,
    beforeTokens,
    afterTokens,
    batch,
  };
}

/**
 * Put a compaction back. Defaults to the most recent, so undoing twice walks
 * back two steps rather than restoring everything at once — the same rule
 * `undoRewind` follows.
 */
export function undoCompaction(
  db: Database.Database,
  sessionId: string,
  batch?: number,
): { restored: number; batch: number } | null {
  return restoreCompactedMessages(db, sessionId, batch);
}

/** What is currently hidden behind compactions, oldest first. */
export function listSessionCompactions(
  db: Database.Database,
  sessionId: string,
): Array<{ batch: number; messages: number }> {
  return listCompactions(db, sessionId);
}

export function formatCompactResult(result: CompactResult): string {
  if (result.skipped) {
    return result.reason ?? "Compact skipped";
  }
  return (
    `Compacted: ${result.beforeCount} messages → ${result.afterCount}, ` +
    `~${result.beforeTokens} tokens → ~${result.afterTokens} tokens ` +
    `(reversible — compaction #${result.batch})`
  );
}
