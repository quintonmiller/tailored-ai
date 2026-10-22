import { useEffect, useState } from "react";
import { type DirectoryRoomSummary, fetchDirectoryRooms } from "../api";
import { RoomPage, RoomsOff } from "../components/RoomPage";
import { leadFrom } from "../lib/room-page";
import { subscribeStateChanges } from "../lib/state-events";

/** The record types the rooms list counts: a change to one of a room's re-reads it. */
const LISTED_TYPES = new Set(["profile", "commitment", "doc"]);

/** How often the list reads itself again: rooms, members and creators live in the rooms store, not the state stream. */
const POLL_MS = 15_000;

/**
 * Every live room from the directory, kept current from the state stream.
 * undefined while loading, null when the directory is off.
 */
function useRooms(): { rooms: DirectoryRoomSummary[] | null | undefined; error: string | null } {
  const [rooms, setRooms] = useState<DirectoryRoomSummary[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const seq = ++latest;
      fetchDirectoryRooms()
        .then((r) => {
          if (cancelled || seq !== latest) return;
          setRooms(r);
          setError(null);
        })
        .catch((e) => !cancelled && seq === latest && setError((e as Error).message));
    };
    load();
    const poll = setInterval(load, POLL_MS);
    const off = subscribeStateChanges((c) => {
      if (!LISTED_TYPES.has(c.type) || (!c.after?.room && !c.before?.room)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 120);
    });
    return () => {
      cancelled = true;
      off();
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, []);
  return { rooms, error };
}

/**
 * Rooms: every live room with what it's for, who leads it and how much it
 * has on, and a page for each, the way agents have theirs.
 */
export function Rooms({ roomName }: { roomName?: string }) {
  if (roomName) {
    return (
      <div className="agents-page rooms-page">
        <div className="agent-detail">
          <header className="agent-detail-header room-detail-header">
            <div className="agent-detail-title">
              <a href="#/rooms" className="room-back" aria-label="All rooms">
                ← Rooms
              </a>
              <h1>#{roomName}</h1>
            </div>
          </header>
          <RoomPage name={roomName} />
        </div>
      </div>
    );
  }
  return <RoomsList />;
}

function RoomsList() {
  const { rooms, error } = useRooms();
  if (error && !rooms) return <div className="page-error">Error: {error}</div>;
  if (rooms === undefined) return <div className="page-loading">Loading…</div>;
  return (
    <div className="agents-page rooms-page">
      <div className="agent-overview">
        <header className="agent-overview-header">
          <h1>Rooms</h1>
        </header>
        {rooms === null ? (
          <RoomsOff />
        ) : rooms.length === 0 ? (
          <p className="agent-empty">
            No rooms yet. Agents open them with the <code>room</code> tool, and config declares them under{" "}
            <code>rooms</code>.
          </p>
        ) : (
          <ul className="agent-overview-cards room-cards">
            {rooms.map((r) => (
              <li key={r.ref}>
                <RoomCard room={r} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RoomCard({ room }: { room: DirectoryRoomSummary }) {
  const c = room.commitments;
  const from = room.lead && room.leadFrom ? leadFrom({ agent: room.lead, source: room.leadFrom }) : undefined;
  return (
    <a href={`#/rooms/${encodeURIComponent(room.name)}`} className="agent-overview-card room-card">
      <span className="agent-overview-title">
        <span className="agent-overview-name">#{room.name}</span>
        <span className="room-card-members" title={room.members.join(", ")}>
          {room.members.length} member{room.members.length === 1 ? "" : "s"}
        </span>
      </span>
      <span className={`agent-overview-purpose${room.purpose ? "" : " empty"}`}>
        {room.purpose ?? "Nobody has said what it's for yet."}
      </span>
      <span className="room-card-lead">
        {room.lead ? (
          <>
            Led by <strong>{room.lead}</strong>
            {from ? <span className="room-card-from"> · {from}</span> : null}
          </>
        ) : (
          <span className="room-card-from">No lead yet</span>
        )}
      </span>
      <span className="agent-overview-counts">
        <span className={c.open ? "" : "zero"}>{c.open} open</span>
        <span className={c.waiting ? "waiting" : "zero"}>{c.waiting} waiting</span>
        <span className={room.docs ? "" : "zero"}>
          {room.docs} doc{room.docs === 1 ? "" : "s"}
        </span>
      </span>
    </a>
  );
}
