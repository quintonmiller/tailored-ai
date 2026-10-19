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
 * Your latest web conversation with an agent, if there is one. Only a key
 * that names the agent counts. One from before keys did (`web:<when>`) could
 * be with anyone, since switching agents used to keep the conversation, so
 * picking it up would carry on someone else's; it stays in the Sessions list.
 */
export function latestWith(sessions: SessionRow[], agent: string): SessionRow | undefined {
  let latest: SessionRow | undefined;
  for (const s of sessions) {
    if (agentOfKey(s.key) === agent && (!latest || s.updated_at > latest.updated_at)) latest = s;
  }
  return latest;
}

/**
 * The conversation to answer an agent's question in: the one it asked in
 * (`session`), when that is one of your web conversations with it. A question
 * asked on another channel, or in a conversation this can't tell is with it,
 * has none here: you answer in your chat with it as it stands.
 */
export function askedIn(sessions: SessionRow[], session: string | undefined, agent: string): SessionRow | undefined {
  if (!session) return undefined;
  const row = sessions.find((s) => s.id === session);
  return row && agentOfKey(row.key) === agent ? row : undefined;
}

/** A session row with only what opening a conversation needs: its id and key. */
export function rowFor(id: string, key: string | null): SessionRow {
  return {
    id,
    key,
    model: "",
    provider: "",
    project_id: null,
    title: null,
    pinned: 0,
    created_at: "",
    updated_at: "",
  };
}

/** An agent's name as people see it: the default agent ("" or "default") says so. */
export function nameOf(agent: string): string {
  return agent && agent !== DEFAULT ? agent : "Default agent";
}
