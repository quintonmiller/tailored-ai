/**
 * Which web conversation is with which agent. A new conversation's key names
 * the agent (`web:<agent>:<when>`), the way the Agents page has always started
 * one, so the chat can pick up your latest conversation with an agent when you
 * go to it, and knows who a conversation it reopens is with.
 */
import type { SessionRow } from "../api";

/** The default agent's name in a key. The chat store calls it "". */
const DEFAULT = "default";

/** A new conversation's key, with an agent ("" is the default agent). */
export function newChatKey(agent: string, now = Date.now()): string {
  return `web:${agent || DEFAULT}:${now}`;
}

/** Who a web conversation is with, by its key: "" for the default agent, undefined when the key doesn't say. */
export function agentOfKey(key: string | null | undefined): string | undefined {
  const m = key?.match(/^web:(.+):\d+$/);
  if (!m) return undefined;
  return m[1] === DEFAULT ? "" : m[1];
}

/**
 * Your latest web conversation with an agent, if there is one. Keys from
 * before they named the agent (`web:<when>`) were nearly all with the
 * default agent, the one the chat started on, so they count as its.
 */
export function latestWith(sessions: SessionRow[], agent: string): SessionRow | undefined {
  let latest: SessionRow | undefined;
  for (const s of sessions) {
    const theirs = agentOfKey(s.key) === agent || (agent === "" && /^web:\d+$/.test(s.key ?? ""));
    if (theirs && (!latest || s.updated_at > latest.updated_at)) latest = s;
  }
  return latest;
}
