import { useEffect, useRef, useState } from "react";
import { type AgentActivity, behaviorFor } from "../avatar/doing";
import { nameOf } from "../lib/conversations";
import { renderMarkdown } from "../lib/markdown.js";
import { agentColor } from "./WorldMap";

/**
 * Who the conversation over the scene is with, at the top of the chat panel:
 * their name, a dot in their body's colour, what they are doing right now,
 * and a way to talk to someone else. In a meeting room, the room itself: its
 * own conversation to read, and its members to pick one to talk to.
 */

/** How often a meeting room's conversation is read again while it is on screen. */
const ROOM_REFRESH_MS = 15_000;

/** What an agent is doing, in a few words: nothing while it is idle. */
export function doingLine(activity: AgentActivity | undefined): string | undefined {
  const b = behaviorFor(activity);
  if (!b.label) return undefined;
  return b.detail ? `${b.label} · ${b.detail}` : b.label;
}

export function ChatWith({
  agent,
  agents,
  activity,
  next,
  onSwitch,
}: {
  /** "" is the default agent. */
  agent: string;
  /** Every agent there is to talk to, besides the default one. */
  agents: string[];
  activity: AgentActivity | undefined;
  /** The agent a switch is waiting to go to, until the reply on its way is done. */
  next: string | null;
  onSwitch: (agent: string) => void;
}) {
  const doing = doingLine(activity);
  return (
    <div className="chat-with" aria-label="Who you are talking to">
      {agent && <span className="chat-with-dot" style={{ background: agentColor(agent) }} aria-hidden="true" />}
      <div className="chat-with-who">
        <strong>{nameOf(agent)}</strong>
        {next !== null ? (
          <span className="chat-with-doing">Then {nameOf(next)}, once this reply is done</span>
        ) : (
          doing && <span className="chat-with-doing">{doing}</span>
        )}
      </div>
      <label className="chat-with-switch">
        <span>Talk to</span>
        {/* Who you are going to, once a switch is waiting: picking who you are with calls it off. */}
        <select value={next ?? agent} onChange={(e) => onSwitch(e.target.value)} aria-label="Talk to someone else">
          <option value="">{nameOf("")}</option>
          {agents.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** One thing said in a meeting room, as `builtin:places` reads it out. */
export interface SaidLine {
  id: string;
  who: string;
  agent?: string;
  to: string[];
  text: string;
  at: string;
  files?: number;
}

export interface RoomTalk {
  name?: string;
  purpose?: string;
  members: string[];
  lines: SaidLine[];
  problem: string | null;
  loading: boolean;
}

/**
 * A meeting room's own conversation: read when you arrive, for its name and
 * members, and every little while after only while it is `active` (on screen,
 * in a tab that is in view), and once more each time it comes back on screen.
 * A room kept on Discord is read from Discord each time, so a page left
 * standing in a room with the conversation out of sight reads nothing.
 */
export function useRoomTalk(id: string | null, active = true): RoomTalk {
  const [talk, setTalk] = useState<RoomTalk>({ members: [], lines: [], problem: null, loading: true });
  const read = useRef<() => void>(() => {});
  useEffect(() => {
    setTalk({ members: [], lines: [], problem: null, loading: true });
    read.current = () => {};
    if (!id) return;
    let gone = false;
    const load = () =>
      fetch(`/api/ext/builtin:places/transcript/${encodeURIComponent(id)}`)
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as Partial<RoomTalk> & { error?: string };
          if (!res.ok) throw new Error(body.error ?? `The room couldn't be read (${res.status}).`);
          return body;
        })
        .then((body) => {
          if (gone) return;
          setTalk({
            ...(body.name ? { name: body.name } : {}),
            ...(body.purpose ? { purpose: body.purpose } : {}),
            members: body.members ?? [],
            lines: body.lines ?? [],
            problem: null,
            loading: false,
          });
        })
        .catch((err: unknown) => {
          if (!gone)
            setTalk((t) => ({ ...t, problem: err instanceof Error ? err.message : String(err), loading: false }));
        });
    read.current = () => void load();
    void load();
    return () => {
      gone = true;
    };
  }, [id]);
  const was = useRef(active);
  useEffect(() => {
    const back = active && !was.current;
    was.current = active;
    if (!id || !active) return;
    if (back) read.current();
    const timer = setInterval(() => {
      if (!document.hidden) read.current();
    }, ROOM_REFRESH_MS);
    return () => clearInterval(timer);
  }, [id, active]);
  return talk;
}

/** A meeting room's header: its name, what it is for, and a tab for its conversation and one for each member. */
export function RoomWith({
  talk,
  fallbackName,
  reading,
  agent,
  next = null,
  activities,
  onRead,
  onTalk,
}: {
  talk: RoomTalk;
  /** The room's name until its conversation has been read. */
  fallbackName: string | undefined;
  /** The room's conversation is what the panel shows, rather than yours with a member. */
  reading: boolean;
  /** The agent you are talking to; "" is the default agent. */
  agent: string;
  /** The agent a switch is waiting to go to, until the reply on its way is done. */
  next?: string | null;
  activities: Record<string, AgentActivity>;
  onRead: () => void;
  onTalk: (agent: string) => void;
}) {
  const name = talk.name ?? fallbackName;
  return (
    <div className="chat-with chat-with-room" aria-label="The room you are in">
      <div className="chat-with-who">
        <strong>{name ? `#${name}` : "This room"}</strong>
        {next !== null ? (
          <span className="chat-with-doing">Then {nameOf(next)}, once this reply is done</span>
        ) : (
          talk.purpose && <span className="chat-with-doing">{talk.purpose}</span>
        )}
      </div>
      <div className="chat-with-tabs" role="tablist" aria-label="Read the room, or talk to someone in it">
        <button type="button" role="tab" aria-selected={reading} onClick={onRead}>
          Room
        </button>
        {talk.members.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={!reading && (agent || "default") === m}
            title={doingLine(activities[m]) ?? `Talk to ${m}`}
            onClick={() => onTalk(m)}
          >
            {m !== "default" && (
              <span className="chat-with-dot" style={{ background: agentColor(m) }} aria-hidden="true" />
            )}
            {nameOf(m)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** When a line was said, as a clock time today or a date before. */
function said(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A meeting room's conversation, to read: who said what to whom, oldest first. */
export function RoomLines({ talk }: { talk: RoomTalk }) {
  // The latest line in view, like any conversation: when it arrives, not on every quiet re-read, so reading
  // further up isn't pulled back down.
  const list = useRef<HTMLOListElement>(null);
  const latest = talk.lines.at(-1)?.id;
  useEffect(() => {
    const box = list.current?.parentElement;
    if (latest && box) box.scrollTop = box.scrollHeight;
  }, [latest]);
  if (talk.problem) return <p className="room-lines-note">{talk.problem}</p>;
  if (talk.loading) return <p className="room-lines-note">Reading the room…</p>;
  if (!talk.lines.length) return <p className="room-lines-note">Nobody has said anything here yet.</p>;
  return (
    <ol ref={list} className="room-lines" aria-label="What the room has said lately">
      {talk.lines.map((l) => (
        <li key={l.id} className="room-line">
          <div className="room-line-head">
            {l.agent && (
              <span className="chat-with-dot" style={{ background: agentColor(l.agent) }} aria-hidden="true" />
            )}
            <strong>{l.who}</strong>
            {l.to.length > 0 && <span className="room-line-to">to {l.to.join(", ")}</span>}
            <time dateTime={l.at}>{said(l.at)}</time>
          </div>
          {/* Rooms are written in markdown, Discord's included; rendered sanitised, as the chat's own replies are. */}
          <div className="room-line-text markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(l.text) }} />
          {l.files ? (
            <p className="room-line-files">
              {l.files === 1 ? "A file came with it." : `${l.files} files came with it.`}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
