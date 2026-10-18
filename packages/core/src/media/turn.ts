/**
 * What media did this turn produce?
 *
 * A channel needs an answer to deliver a screenshot back to Discord, and the
 * answer is already written down: tool results persist through
 * `encodeMessageContent`, so their parts are in the `messages` table by the
 * time the loop returns.
 *
 * Reading the record rather than threading a second value out of the loop is
 * deliberate, and it is the same choice the web UI already made — it renders
 * media by reading stored messages, not by inspecting a return value. One
 * source of truth means a channel and the UI cannot disagree about what a turn
 * produced. The alternative, widening `runAgentLoop`'s return type, would churn
 * eighteen call sites (most of which only ever want text) to serve three
 * surfaces, and would put the same fact in two places.
 *
 * Scope note: **the user's own attachments are excluded.** Only `tool` and
 * `assistant` rows are read, so an inbound photo is never echoed back at the
 * person who just sent it. `assistant` is included against the day a provider
 * returns generated media; nothing produces it today.
 */

import type Database from "better-sqlite3";
import { decodeMessageContent } from "../content/codec.js";
import { type ComponentSpec, componentSpecs, type MediaRef, mediaRefs } from "../content/types.js";

/**
 * Highest message id in a session, or 0 when it has none.
 *
 * Captured *before* a turn so {@link collectTurnMedia} can be asked what
 * appeared after it. Sessions are append-only for the purposes of this
 * watermark: compaction rewrites rows but only ever with higher ids, so a stale
 * watermark over-collects rather than silently under-collecting.
 */
export function latestMessageId(db: Database.Database, sessionId: string): number {
  const row = db.prepare("SELECT MAX(id) AS id FROM messages WHERE session_id = ?").get(sessionId) as
    | { id: number | null }
    | undefined;
  return row?.id ?? 0;
}

/**
 * Where the current turn began: the id of the newest `user` message.
 *
 * {@link latestMessageId} is captured *before* a turn by whoever is running it.
 * A tool executing mid-turn has no such foresight — it arrives after the fact
 * and still needs to know what this turn produced. Every turn starts with a
 * user message (a real one, or the prompt a room wake synthesises), so the last
 * one is the boundary.
 *
 * Returns 0 for a session with no user message, which collects everything —
 * over-collecting, like a stale watermark, is the safe direction.
 */
export function turnStartId(db: Database.Database, sessionId: string): number {
  const row = db.prepare("SELECT MAX(id) AS id FROM messages WHERE session_id = ? AND role = 'user'").get(sessionId) as
    | { id: number | null }
    | undefined;
  return row?.id ?? 0;
}

export interface CollectTurnMediaOptions {
  /** Stop after this many distinct items. Default 8; the surface caps again. */
  limit?: number;
}

/**
 * Media referenced by tool and assistant messages written after `afterId`, in
 * the order it was produced, deduped by content hash.
 *
 * Dedupe matters more than it looks: ids are sha256 of the bytes, so an agent
 * that screenshots an unchanged screen three times yields one id three times.
 * Returning it once is fidelity, not loss.
 */
export function collectTurnMedia(
  db: Database.Database,
  sessionId: string,
  afterId: number,
  opts: CollectTurnMediaOptions = {},
): MediaRef[] {
  const limit = opts.limit ?? 8;
  if (limit <= 0) return [];

  const rows = db
    .prepare(
      `SELECT content FROM messages
        WHERE session_id = ? AND id > ? AND role IN ('tool', 'assistant')
          AND rewound_batch IS NULL AND compacted_batch IS NULL
        ORDER BY id ASC`,
    )
    .all(sessionId, afterId) as { content: string | null }[];

  const out: MediaRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const ref of mediaRefs(decodeMessageContent(row.content))) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      out.push(ref);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Interface components tool messages wrote after `afterId`: each one once, in
 * the order it was first sent, as its latest version — an `update` replaces
 * the earlier one rather than posting the question twice.
 *
 * Read from the record for the same reason media is. A surface that cannot
 * draw a component still has to show it, and a component lives in a tool
 * result, which a channel otherwise never posts.
 */
export function collectTurnComponents(db: Database.Database, sessionId: string, afterId: number): ComponentSpec[] {
  const rows = db
    .prepare(
      `SELECT content FROM messages
        WHERE session_id = ? AND id > ? AND role = 'tool'
          AND rewound_batch IS NULL AND compacted_batch IS NULL
        ORDER BY id ASC`,
    )
    .all(sessionId, afterId) as { content: string | null }[];
  const byId = new Map<string, ComponentSpec>();
  for (const row of rows) {
    for (const spec of componentSpecs(decodeMessageContent(row.content))) byId.set(spec.id, spec);
  }
  return [...byId.values()];
}

/** A reply with the text form of each component appended, for a surface that posts text. */
export function withComponentText(body: string, components: readonly ComponentSpec[]): string {
  if (components.length === 0) return body;
  const forms = components.map((c) => c.fallback).join("\n\n");
  return body ? `${body}\n\n${forms}` : forms;
}
