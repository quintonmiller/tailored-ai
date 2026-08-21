import type Database from "better-sqlite3";
import { messageText } from "../content/types.js";
import { createNote } from "../db/note-queries.js";
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

/**
 * What the summariser is asked for when a deployment says nothing.
 *
 * Deliberately does not say "concisely", and deliberately does not enumerate
 * "facts, decisions and pending tasks". Both were measured against a real
 * 1,432-message conversation:
 *
 *   "concisely … facts, decisions, pending tasks"   →   88 tokens
 *   the same line with "in detail"                  →  475 tokens
 *
 * — and the longer one was not padding: six times the named specifics, and it
 * quoted actual phrasing where the short one quoted none. One word was
 * discarding most of the history.
 *
 * The old wording also carried a project-status opinion into core, which is why
 * a companion agent's history came back formatted as `Participants:` /
 * `Key Events:`. A deployment that wants that shape should ask for it in
 * `compaction.prompt`.
 *
 * Short and unspecific on purpose. Four variants were run against the same
 * 1,432-message history, scored on named specifics and quoted phrasing:
 *
 *   "…the people, the specifics, and where things stand"   1574 chars, 32 names
 *   "…key facts, decisions, and pending tasks"             1428 chars, 38 names
 *   "in detail." alone                                     1420 chars, 20 names
 *   a longer line enumerating what to preserve              707 chars,  1 name
 *
 * The elaborate one lost badly — twice over, since an earlier attempt at a rich
 * "continuity" prompt also underperformed the plain line. Enumerating what to
 * keep seems to read as a checklist to satisfy briefly rather than an invitation
 * to write. Naming a few neutral categories beats naming none; naming many is
 * worse than either.
 */
/**
 * What to ask for when saving durable facts ahead of a compaction.
 *
 * A summary is one block of prose that every later turn pays for whether or not
 * it is relevant. A note is retrieved when it matches what is being discussed.
 * For a long conversation the second is the better shape: the history that comes
 * back is the history that applies.
 *
 * Asks for one fact per line and nothing else, because the output is parsed.
 */
export const DEFAULT_MEMORY_CHECKPOINT_PROMPT =
  "You are about to lose the details of this conversation; only a short summary will remain. " +
  "Write down what must survive. One item per line, no numbering, no preamble. " +
  "Record durable things — who people are and how they relate, commitments made and still open, " +
  "stated preferences and boundaries, decisions and their reasons, names and specifics you would " +
  "otherwise have to ask for again. Skip anything that was only true in the moment. " +
  "Output only the lines.";

export const DEFAULT_COMPACTION_PROMPT =
  "Summarize this conversation in detail. Preserve the people, the specifics, and where things stand. " +
  "Output only the summary.";

export interface CompactResult {
  skipped: boolean;
  reason?: string;
  beforeCount?: number;
  afterCount?: number;
  beforeTokens?: number;
  afterTokens?: number;
  /** Which compaction this was, for `undoCompaction`. Absent when skipped. */
  batch?: number;
  /** Durable facts saved as notes before hiding anything. */
  notesWritten?: number;
}

export interface CompactOptions {
  /** Emits `session.compacted` so subscribers can archive, notify or audit. */
  events?: EventBus;
  /**
   * Leave the newest N messages visible and fold away only what precedes them.
   *
   * All-or-nothing compaction is the wrong trade for a long-running
   * conversation. Measured on a real 1,632-message session: the whole history
   * summarised to 907 characters — a 534x reduction that keeps the facts and
   * loses the voice, the running context and every established preference. What
   * makes such a session worth keeping is exactly what a synopsis discards.
   *
   * A recent window is cheap to keep — it is the part already most present to
   * the model — and it leaves the summary standing in only for the distant
   * past, which is what a summary is actually good at.
   */
  keepRecent?: number;
  /** Overrides {@link DEFAULT_COMPACTION_PROMPT}. */
  prompt?: string;
  /**
   * Cap on the summary. Left unset the provider decides, which is how 1,432
   * messages became 139 tokens — the length was accidental, not chosen.
   */
  maxTokens?: number;
  /**
   * Save durable facts as notes before anything is hidden.
   *
   * The summary is a fixed block every later turn carries regardless of
   * relevance; notes are retrieved when they match the conversation. Writing
   * both means the summary can stay short without the details being gone — they
   * come back when they apply.
   *
   * Notes are written under `agent`, so they are scoped to whoever is losing the
   * history rather than pooled across every agent.
   */
  memory?: {
    agent: string;
    projectId?: string | null;
    /** Ceiling on notes written. Default 40. */
    maxNotes?: number;
    /** Overrides {@link DEFAULT_MEMORY_CHECKPOINT_PROMPT}. */
    prompt?: string;
  };
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

  // Only what is about to be hidden gets summarised. Summarising the kept
  // window too would put the same content in the next request twice — once as a
  // summary and once verbatim — which is the duplication this area exists to
  // remove.
  const keepRecent = Math.max(0, Math.floor(opts.keepRecent ?? 0));
  const toSummarise = keepRecent > 0 ? messages.slice(0, Math.max(0, messages.length - keepRecent)) : messages;
  if (toSummarise.length === 0) {
    return { skipped: true, reason: `Nothing older than the ${keepRecent}-message keep window` };
  }

  // Serialize messages for summarization
  const lines: string[] = [];
  for (const msg of toSummarise) {
    if (msg.content) {
      lines.push(`[${msg.role}]: ${messageText(msg.content)}`);
    }
  }
  const transcript = lines.join("\n");

  let beforeTokens = 0;
  for (const msg of toSummarise) beforeTokens += estimateTokens(msg);

  // Summarize via provider
  const response = await provider.chat({
    model,
    messages: [
      { role: "system", content: opts.prompt ?? DEFAULT_COMPACTION_PROMPT },
      { role: "user", content: transcript },
    ],
    temperature: 0.3,
    maxTokens: opts.maxTokens,
  });

  const summary = response.content ?? "";

  // Save durable facts before anything is hidden. Deliberately before the
  // marking below: a failure here should leave the conversation intact rather
  // than hidden behind a summary with its details unsaved.
  let notesWritten = 0;
  if (opts.memory) {
    notesWritten = await saveDurableFacts(db, provider, model, transcript, opts.memory);
  }

  // Summarise first, hide second. A provider that throws leaves the session
  // exactly as it was rather than hidden behind a summary that never arrived.
  const { batch, hidden } = markSessionCompacted(db, sessionId, { keepRecent });
  // The summary is the agent's own note, not something said to it.
  //
  // As a `user` message it reads as the person on the other end having just
  // narrated a summary — so the model continues the narrative instead of
  // answering the actual message. Measured on a real companion session: with the
  // summary as a user turn, 4 of 5 replies to "hello" carried on about events
  // from the summary and addressed the wrong person; as an assistant turn, 1 of
  // 5, which is the rate without any summary at all. Rewording it while leaving
  // the role alone only moved it to 3 of 5 — the role is doing the work.
  //
  // `[assistant, user]` is accepted by Anthropic, OpenAI and DeepSeek; checked
  // against all three before changing this.
  const summaryMsg: Message = { role: "assistant", content: `[Earlier conversation, summarised]\n${summary}` };
  saveMessage(db, sessionId, summaryMsg, { compactionSummaryFor: batch });

  const afterTokens = estimateTokens(summaryMsg);

  opts.events?.emit("session.compacted", {
    sessionId,
    batch,
    messages: hidden,
    beforeTokens,
    afterTokens,
    notesWritten,
  });

  return {
    skipped: false,
    beforeCount: toSummarise.length,
    afterCount: 1,
    beforeTokens,
    afterTokens,
    batch,
    notesWritten,
  };
}

/**
 * Ask the model what must survive, and write each line as a note.
 *
 * Best-effort: a checkpoint that fails is logged and compaction continues.
 * Refusing to compact because the notes call failed would leave the session
 * growing, which is the problem being solved.
 */
async function saveDurableFacts(
  db: Database.Database,
  provider: AIProvider,
  model: string,
  transcript: string,
  memory: NonNullable<CompactOptions["memory"]>,
): Promise<number> {
  try {
    // Tool results are stripped before the model sees this. Left in, they are
    // what it writes back: the first run of this produced twelve "facts" that
    // were all lines like `[tool]: saved note_6c0a6ccf` copied out of the
    // transcript. A tool result is a record of a call, not something worth
    // remembering, and it is the most copy-shaped text in the history.
    const speech = transcript
      .split("\n")
      .filter((l) => !l.startsWith("[tool]:"))
      .join("\n");
    const res = await provider.chat({
      model,
      messages: [
        { role: "system", content: memory.prompt ?? DEFAULT_MEMORY_CHECKPOINT_PROMPT },
        { role: "user", content: speech },
      ],
      temperature: 0.3,
    });
    const lines = messageText(res.content)
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, "").trim())
      .filter((l) => l.length > 8)
      // Anything still wearing a transcript role prefix is quoted history
      // rather than a fact the model decided was worth keeping.
      .filter((l) => !/^\[(?:tool|user|assistant|system)\]:/i.test(l))
      .slice(0, memory.maxNotes ?? 40);
    for (const content of lines) {
      createNote(db, {
        content,
        agent: memory.agent,
        project_id: memory.projectId ?? null,
        tags: ["compaction-checkpoint"],
      });
    }
    return lines.length;
  } catch (err) {
    console.error(`[compact] memory checkpoint failed for ${memory.agent}: ${(err as Error).message}`);
    return 0;
  }
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
