import type { ReactNode } from "react";
import { contentText, type MessageContent } from "../lib/content";

/** Something you or the agent said, as your conversation in the world shows it. */
export interface TalkLine {
  who: "you" | "agent";
  text: string;
}

/** How many of the last things said the conversation in the world shows: a glance, with the whole chat a click away. */
export const TALK_LINES = 4;
/** How many while a card beside something has most of the room: what you last said, and its answer. */
export const TALK_BRIEF = 2;

/**
 * The last few things you and the agent said to each other in a conversation,
 * oldest first: its words and yours, without the work in between (a reply's
 * tool calls show on its body as it works), and without anything said with
 * no words, like a picture alone.
 */
export function lastLines(messages: { role: string; content: unknown }[], most: number = TALK_LINES): TalkLine[] {
  const out: TalkLine[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < most; i--) {
    const m = messages[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = contentText(m.content as string | MessageContent | null | undefined).trim();
    if (text) out.push({ who: m.role === "user" ? "you" : "agent", text });
  }
  return out.reverse();
}

/** A telephone handset, the mark a call wears: on a phone, and in its bubbles over a head. */
function Handset() {
  return (
    <svg className="world-talk-handset" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z" />
    </svg>
  );
}

/**
 * Your conversation with an agent, in the world: beside its body when it is
 * near you, the last few turns as a dialogue (its words in white bubbles, as
 * over its head, yours in your own colour), a reply coming in as it arrives,
 * what it is busy with while it works, anything it needs approved, and under
 * it all the box to type in, with talking and sending as in the chat. Talking
 * to an agent somewhere else is a call: the same conversation, in a phone.
 * The whole chat is a click away. Not a dialog: keys pressed outside it still
 * walk you, and Escape still stops a reply.
 */
export function WorldTalk({
  name,
  lines,
  heard,
  replying,
  status,
  phone = false,
  approvals,
  problem,
  children,
  onFull,
}: {
  /** What to call the agent. */
  name: string;
  lines: TalkLine[];
  /** What you just said out loud, while its answer is still coming. */
  heard?: string;
  /** The answer so far, while it comes in. */
  replying?: string;
  /** What it is doing about your turn: thinking, or the tool it is using. */
  status?: string;
  /** On the phone: it is somewhere else. */
  phone?: boolean;
  /** Tool calls waiting on your approval. */
  approvals?: ReactNode;
  /** What went wrong with talking out loud: no microphone, say. */
  problem?: string;
  /** The box to type in, and its buttons. */
  children: ReactNode;
  onFull: () => void;
}) {
  const said = heard ? [...lines, { who: "you" as const, text: heard }] : lines;
  return (
    <section
      className={`world-talk${phone ? " world-talk-phone" : ""}`}
      aria-label={phone ? `On the phone with ${name}` : `Talking with ${name}`}
    >
      <header className="world-talk-head">
        {phone && <Handset />}
        <span className="world-talk-name">
          {phone && <span className="world-talk-call">On the phone with </span>}
          <strong>{name}</strong>
        </span>
        <button
          type="button"
          className="world-talk-full"
          onClick={onFull}
          title="The whole conversation, beside the world"
        >
          Whole chat
        </button>
      </header>
      <ol className="world-talk-lines" aria-live="polite" aria-label="What was said">
        {said.length === 0 && replying === undefined && (
          <li className="world-talk-hint">
            {phone ? "They'll hear you down the line." : `Say something to ${name}.`} Type below, or hold Space to talk.
          </li>
        )}
        {said.map((l, i) => (
          // The same text can be said twice; where it is in the conversation is what tells them apart.
          <li key={i} className={`world-talk-line world-talk-${l.who}`}>
            <span className="world-talk-text">{l.text}</span>
          </li>
        ))}
        {replying !== undefined && (
          <li className="world-talk-line world-talk-agent world-talk-live">
            {replying ? (
              <span className="world-talk-text">{replying}</span>
            ) : (
              <span className="world-talk-dots" role="img" aria-label="Replying" />
            )}
          </li>
        )}
      </ol>
      {status && (
        <output className="world-talk-status">
          <span className="world-talk-pulse" aria-hidden="true" />
          {status}
        </output>
      )}
      {problem && <p className="world-talk-problem">{problem}</p>}
      {approvals}
      <div className="world-talk-compose">{children}</div>
    </section>
  );
}
