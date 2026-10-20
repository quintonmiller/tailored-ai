import type { Room, RoomChange } from "../avatar/scene";
import { useAgentColor } from "../lib/body-colors";
import { nameOf } from "../lib/conversations";
import { ago } from "../lib/tasks";
import type { Said } from "./WorldAgent";
import { WorldPanel } from "./WorldPanel";

/** What a person asks an agent, so its room shows what it works on. */
export const ROOM_ASK = "Have a look at your room and make it reflect what you've been working on.";

/** How long after a change its line still shows over the agent who made it. */
const FRESH_MS = 60_000;

/** A change as the agent who made it says it in a bubble: "Added the bookshelf by the window." */
export function changeLine(what: string): string {
  const words = what.trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${/[.!?]$/.test(words) ? "" : "."}`;
}

/**
 * What each agent last said, with what it just did to the room: an agent's
 * newest change, made a moment ago and after anything it said, shows over its
 * head like a line it said, so you see who added the bookshelf as it appears.
 */
export function withChangeLines(
  speech: Record<string, Said>,
  changes: RoomChange[] | undefined,
  now = Date.now(),
): Record<string, Said> {
  if (!changes?.length) return speech;
  let out = speech;
  const newest = new Set<string>();
  for (const change of changes) {
    // Yours have no body to show over.
    if (change.person || newest.has(change.who)) continue;
    newest.add(change.who);
    const at = Date.parse(change.at);
    if (!Number.isFinite(at) || now - at > FRESH_MS) continue;
    const said = speech[change.who];
    if (said && Date.parse(said.at) >= at) continue;
    if (out === speech) out = { ...speech };
    out[change.who] = { text: changeLine(change.what), at: change.at };
  }
  return out;
}

const list = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");

/** Who can change a place, in words: a home's owner, a meeting room's members, anyone in a shared place, and you. */
export function keepersWords(id: string, members: string[], canPlace: (agent: string) => boolean): string {
  // The lobby is the building's: no agent's tool changes it, only you.
  if (id === "lobby") return "You, with Edit room; agents leave the lobby as it is";
  return `${agentsWords(id, members, canPlace)}; and you, with Edit room`;
}

function agentsWords(id: string, members: string[], canPlace: (agent: string) => boolean): string {
  if (id.startsWith("home:")) {
    const owner = id.slice("home:".length);
    return canPlace(owner)
      ? `${nameOf(owner)}, with its place tool`
      : `${nameOf(owner)}, once place is among its tools`;
  }
  if (id.startsWith("room:")) {
    const able = members.filter(canPlace).map(nameOf);
    return able.length ? `${list(able)}, its members` : "Its members, once one of them has the place tool";
  }
  return "Any agent with the place tool who goes there";
}

/** A theme in a word or two. */
const themeWords = (theme: string | undefined) =>
  !theme || theme === "none" ? "None" : `${theme.charAt(0).toUpperCase()}${theme.slice(1)}`;

/**
 * A place, in the world: what it is for, its theme, who can change it, and
 * the changes agents made to it lately, newest first. In a home whose owner
 * can change it, a person can ask it to make the room fit its work.
 */
export function WorldPlace({
  id,
  room,
  members,
  canPlace,
  onAsk,
  onClose,
}: {
  id: string;
  room: Room;
  /** A meeting room's members, who can change it, wherever their bodies are. */
  members: string[];
  /** Whether an agent has the place tool to change a room with. */
  canPlace: (agent: string) => boolean;
  /** Ask an agent to make its room show its work, in a chat with the words written. */
  onAsk?: (agent: string) => void;
  onClose: () => void;
}) {
  const colorOf = useAgentColor();
  const owner = id.startsWith("home:") ? id.slice("home:".length) : undefined;
  const kind = owner ? "Home" : id.startsWith("room:") ? "Meeting room" : id === "lobby" ? "Lobby" : "Shared place";
  const changes = room.changes ?? [];
  // A meeting room goes by its room's name, as the map shows it: "#trip".
  const name = room.name ?? "This place";
  const title = id.startsWith("room:") && !/\s/.test(name) ? `#${name}` : name;
  return (
    <WorldPanel
      kicker={kind}
      title={title}
      className="world-place"
      onClose={onClose}
      // An owner that can't change its room yet: its page is where it gets the place tool.
      {...(owner && owner !== "default" && !canPlace(owner)
        ? {
            footer: (
              <a className="world-panel-link" href={`#/agents/${encodeURIComponent(owner)}`}>
                Give {nameOf(owner)} the place tool on its page
              </a>
            ),
          }
        : {})}
    >
      <dl className="world-facts">
        <dt>For</dt>
        {/* The lobby is the building's: nobody gives it a purpose or a theme, so it says what it is for itself. */}
        {id === "lobby" ? (
          <dd>Where everyone starts: the kiosks, the task board, the big screen and the calendar</dd>
        ) : (
          <>
            <dd>{room.purpose ?? <span className="world-panel-quiet">Nobody has said yet</span>}</dd>
            <dt>Theme</dt>
            <dd>{themeWords(room.theme)}</dd>
          </>
        )}
        <dt>Changed by</dt>
        <dd>{keepersWords(id, members, canPlace)}</dd>
      </dl>
      <section className="world-changes" aria-label="Recent changes">
        <h3>Recent changes</h3>
        {changes.length ? (
          <ol>
            {changes.map((c) => (
              <li key={`${c.at} ${c.who}`}>
                <span
                  className="world-agent-dot"
                  style={{ background: c.person ? "var(--text)" : colorOf(c.who) }}
                  aria-hidden="true"
                />
                <span className="world-change-what">
                  <strong>{c.person ? "You" : nameOf(c.who)}</strong> {c.what}
                </span>
                <time dateTime={c.at}>{ago(c.at)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="world-panel-quiet">
            Nothing yet. What agents change here with their place tool, and what you change with Edit room, shows up
            here.
          </p>
        )}
      </section>
      {owner && onAsk && canPlace(owner) && (
        <div className="world-panel-row world-agent-actions">
          <button type="button" className="talk-tool" onClick={() => onAsk(owner)}>
            Ask {nameOf(owner)} to make it fit its work
          </button>
        </div>
      )}
    </WorldPanel>
  );
}
