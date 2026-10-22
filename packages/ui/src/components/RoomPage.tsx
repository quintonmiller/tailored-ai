import { type FormEvent, type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  type DirectoryRoom,
  editRoomCommitment,
  editRoomProfile,
  fetchDirectoryRoom,
  handToRoom,
  type StateRecordInfo,
  setRoomLead,
} from "../api";
import { AUTONOMY, ago, day, groupCommitments, lastMoved, progressOf, recentMisses } from "../lib/agent-page";
import { heldOf, leadFrom, ROOM_SECTIONS, roomPurpose } from "../lib/room-page";
import { subscribeStateChanges } from "../lib/state-events";
import { Docs, HandOver, list, Meta, Miss, text, Updates, useNow } from "./AgentPage";
import { Progress } from "./InterfaceComponents";

/** The record types a room's page is drawn from: a change to one of the room's redraws it. */
const PAGE_TYPES = new Set(["profile", "commitment", "doc", "miss"]);

/** How long to gather a burst of changes before reading the page again. */
const SETTLE_MS = 120;

/**
 * How often the page reads itself again regardless: who is in a room, and
 * who made it, live in the rooms store, which the state stream doesn't carry.
 */
const POLL_MS = 15_000;

/** The sections that list work, and what each says it has none of, said in one line when all are empty. */
const QUIET: Record<string, string> = {
  working: "open",
  waiting: "waiting on you",
  results: "finished lately",
  docs: "written up",
};

const STATUSES = ["open", "waiting", "done", "dropped"];

/**
 * A room's page: what it's for, who leads it and who's in it, what it's
 * working on, what waits on you, what it finished, what it wrote up, what
 * was asked in its area that nobody could answer, and a form to hand its
 * lead something. Drawn from the directory's records and redrawn as they
 * change, from the same state stream the State page reads.
 */
export function RoomPage({ name }: { name: string }) {
  // undefined while loading; null when the directory is off.
  const [room, setRoom] = useState<DirectoryRoom | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(() => {
    // Only the newest read lands, so a slow early answer never replaces a later one.
    const seq = ++latest.current;
    fetchDirectoryRoom(name)
      .then((r) => {
        if (seq !== latest.current) return;
        setRoom(r);
        setError(null);
      })
      .catch((e) => seq === latest.current && setError((e as Error).message));
  }, [name]);

  useEffect(() => {
    setRoom(undefined);
    setError(null);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const ref = room?.ref;
  useEffect(() => {
    if (!ref) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeStateChanges((c) => {
      if (!PAGE_TYPES.has(c.type)) return;
      if (c.after?.room !== ref && c.before?.room !== ref) return;
      clearTimeout(timer);
      timer = setTimeout(load, SETTLE_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [ref, load]);

  if (error && !room) return <div className="agent-section agent-empty">Couldn't load the room: {error}</div>;
  if (room === undefined) return <div className="agent-section agent-loading">Loading…</div>;
  if (room === null) return <RoomsOff />;
  return <RoomBody room={room} reload={load} />;
}

/** What a room page shows with the directory off. */
export function RoomsOff() {
  return (
    <section className="agent-section" aria-label="Rooms">
      <p className="agent-empty">
        Turn on the directory (<code>builtin:directory</code> under <code>plugins</code>) to see what each room is for,
        who leads it and what it's working on.
      </p>
    </section>
  );
}

function RoomBody({ room, reload }: { room: DirectoryRoom; reload: () => void }) {
  const now = useNow();
  const groups = groupCommitments(room.commitments, now);
  const misses = recentMisses(room.misses, now);
  const docs = room.docs.filter((d) => !d.archivedAt);
  const counts: Record<string, number> = {
    working: groups.working.length,
    waiting: groups.waiting.length,
    results: groups.results.length,
    docs: docs.length,
  };
  const quiet = Object.values(counts).every((n) => n === 0);
  const takesOn = list(room.profile?.data.takesOn);
  const lead = room.lead.agent;
  const items = (records: StateRecordInfo[], variant: "working" | "waiting") => (
    <ul className="agent-page-list">
      {records.map((r) => (
        <Item key={r.id} record={r} room={room} variant={variant} now={now} reload={reload} />
      ))}
    </ul>
  );

  return (
    <div className="agent-page room-page">
      <About room={room} reload={reload} />
      <People room={room} reload={reload} />
      {quiet ? (
        <section className="agent-section agent-page-section agent-page-quiet" aria-label="Nothing yet">
          <p className="agent-empty">
            Nothing {Object.values(QUIET).slice(0, -1).join(", ")} or {QUIET.docs} yet.
            {lead && !room.archived ? " Hand it something below." : ""}
          </p>
        </section>
      ) : (
        <>
          <Section id="working" count={groups.working.length}>
            {groups.working.length === 0 ? (
              <p className="agent-empty">Nothing open right now.</p>
            ) : (
              items(groups.working, "working")
            )}
          </Section>
          <Section id="waiting" count={groups.waiting.length} tone={groups.waiting.length ? "amber" : undefined}>
            {groups.waiting.length === 0 ? (
              <p className="agent-empty">Nothing is waiting on you.</p>
            ) : (
              items(groups.waiting, "waiting")
            )}
          </Section>
          <Section id="results" count={groups.results.length}>
            {groups.results.length === 0 ? (
              <p className="agent-empty">Nothing finished in the last two weeks.</p>
            ) : (
              <ul className="agent-page-list">
                {groups.results.map((r) => (
                  <Result key={r.id} record={r} />
                ))}
              </ul>
            )}
          </Section>
          <Section id="docs" count={docs.length}>
            {docs.length === 0 ? <p className="agent-empty">Nothing written up yet.</p> : <Docs docs={docs} />}
          </Section>
        </>
      )}
      {misses.length > 0 && (
        <Section id="misses" count={misses.length}>
          <ul className="agent-page-list">
            {misses.map((m) => (
              <Miss key={m.id} record={m} />
            ))}
          </ul>
        </Section>
      )}
      {room.archived ? (
        <section className="agent-section agent-page-section" aria-label="Hand it something">
          <h2>Hand it something</h2>
          <p className="agent-empty">This room is archived, so it takes nothing new.</p>
        </section>
      ) : lead ? (
        <HandOver
          agent={lead}
          example={takesOn[0]}
          note={`It goes to ${lead}, who leads #${room.name}, as a commitment of its own for the room.`}
          send={(input) => handToRoom(room.name, input)}
        />
      ) : (
        <section className="agent-section agent-page-section" aria-label="Hand it something">
          <h2>Hand it something</h2>
          <p className="agent-empty">This room has no lead to hand things to. Choose one under Lead and members.</p>
        </section>
      )}
    </div>
  );
}

function Section({ id, count, tone, children }: { id: string; count?: number; tone?: "amber"; children: ReactNode }) {
  const title = ROOM_SECTIONS[id];
  return (
    <section className={`agent-section agent-page-section agent-page-${id}`} aria-label={title}>
      <h2>
        {title}
        {count ? <span className={`agent-page-count${tone ? ` ${tone}` : ""}`}>{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** Marks a field a person set: agents leave it as it is until a person clears it. */
function Held() {
  return (
    <span
      className="agent-page-tag room-held"
      title="A person set this, so agents leave it as it is. Clear it to hand it back."
    >
      set by you
    </span>
  );
}

function About({ room, reload }: { room: DirectoryRoom; reload: () => void }) {
  const p = room.profile?.data;
  const purpose = roomPurpose(room);
  const note = text(p?.note);
  const takesOn = list(p?.takesOn);
  const howToAsk = text(p?.howToAsk);
  const held = heldOf(room, room.profile?.id ?? "");
  const [editing, setEditing] = useState(false);

  return (
    <section className="agent-section agent-page-section agent-page-about" aria-label={ROOM_SECTIONS.about}>
      <h2>
        {ROOM_SECTIONS.about}
        {!room.archived && !editing && (
          <button type="button" className="room-edit" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </h2>
      {editing ? (
        <AboutForm
          room={room}
          purpose={purpose?.text ?? ""}
          note={note ?? ""}
          done={() => {
            setEditing(false);
            reload();
          }}
        />
      ) : (
        <>
          {purpose ? (
            <p className="agent-page-purpose">
              {purpose.text} {held.has("purpose") && <Held />}
            </p>
          ) : (
            <p className="agent-empty">Nobody has said what it's for yet.</p>
          )}
          {purpose?.given && (
            <p className="agent-page-hint">The purpose it was given: its members haven't written its profile yet.</p>
          )}
          {note && (
            <figure className="agent-page-note">
              <blockquote>{note}</blockquote>
              <figcaption>In its members' words {held.has("note") && <Held />}</figcaption>
            </figure>
          )}
          {(takesOn.length > 0 || howToAsk) && (
            <dl className="agent-page-facts">
              {takesOn.length > 0 && (
                <div>
                  <dt>Takes on</dt>
                  <dd className="agent-page-chips">
                    {takesOn.map((t) => (
                      <span key={t} className="agent-tool-chip">
                        {t}
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              {howToAsk && (
                <div>
                  <dt>How to ask</dt>
                  <dd>{howToAsk}</dd>
                </div>
              )}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

/** What a room is for and its note, changed as you: agents then leave them as you left them. */
function AboutForm({
  room,
  purpose: was,
  note: wasNote,
  done,
}: {
  room: DirectoryRoom;
  purpose: string;
  note: string;
  done: () => void;
}) {
  const [purpose, setPurpose] = useState(was);
  const [note, setNote] = useState(wasNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = {
    ...(purpose.trim() !== was ? { purpose: purpose.trim() } : {}),
    ...(note.trim() !== wasNote ? { note: note.trim() } : {}),
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (Object.keys(changes).length === 0) return done();
    setBusy(true);
    setError(null);
    try {
      await editRoomProfile(room.name, changes);
      done();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="room-form" onSubmit={save}>
      <label>
        <span>What it's for</span>
        <textarea value={purpose} maxLength={600} rows={3} onChange={(e) => setPurpose(e.target.value)} />
      </label>
      <label>
        <span>A note for people</span>
        <input
          type="text"
          value={note}
          maxLength={300}
          placeholder="Optional: a sentence or two"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <p className="agent-page-hint">What you set here, agents leave as you left it. Clear a field to hand it back.</p>
      <div className="room-form-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={done} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="agent-page-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** Who leads the room, where that came from, a way to choose another, and who's in it. */
function People({ room, reload }: { room: DirectoryRoom; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { lead } = room;
  const chosen = lead.source === "person" ? (lead.agent ?? "") : "";
  const from = leadFrom(lead);
  // The first choice is what the room gets with nobody chosen: config's lead, then the agent that made it.
  const fallback =
    lead.source === "person"
      ? lead.configured
        ? `Back to ${lead.configured}, named in config`
        : "Back to config's choice, then its creator"
      : lead.agent
        ? `${lead.agent} (${lead.source === "config" ? "config" : "its creator"})`
        : "Nobody";

  async function choose(next: string) {
    if (next === chosen) return;
    setBusy(true);
    setError(null);
    try {
      await setRoomLead(room.name, next || null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agent-section agent-page-section room-people" aria-label={ROOM_SECTIONS.people}>
      <h2>{ROOM_SECTIONS.people}</h2>
      <dl className="agent-page-facts">
        <div>
          <dt>Lead</dt>
          <dd className="room-lead">
            {lead.agent ? (
              <>
                <a href={`#/agents/${encodeURIComponent(lead.agent)}`} className="room-lead-name">
                  {lead.agent}
                </a>
                {from && <span className="agent-page-meta">{from}</span>}
              </>
            ) : (
              <span className="agent-empty">Nobody leads it yet.</span>
            )}
          </dd>
        </div>
        {!room.archived && (
          <div>
            <dt>Change</dt>
            <dd>
              <select
                className="room-lead-pick"
                aria-label="Who leads this room"
                value={chosen}
                disabled={busy}
                onChange={(e) => choose(e.target.value)}
              >
                <option value="">{fallback}</option>
                {room.agents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </dd>
          </div>
        )}
        <div>
          <dt>Members</dt>
          <dd className="agent-page-chips">
            {room.members.length === 0 ? (
              <span className="agent-empty">Nobody yet.</span>
            ) : (
              room.members.map((m) => (
                <a key={m} className="agent-tool-chip" href={`#/agents/${encodeURIComponent(m)}`}>
                  {m}
                  {m === lead.agent ? " · lead" : ""}
                </a>
              ))
            )}
          </dd>
        </div>
      </dl>
      <p className="agent-page-hint">
        Members change the room's records; the lead is accountable for them and looks after them in its upkeep.
      </p>
      {error && (
        <p className="agent-page-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** One of the room's commitments in hand or waiting, with what a person set marked, and a way to change it. */
function Item({
  record,
  room,
  variant,
  now,
  reload,
}: {
  record: StateRecordInfo;
  room: DirectoryRoom;
  variant: "working" | "waiting";
  now: Date;
  reload: () => void;
}) {
  const d = record.data;
  const held = heldOf(room, record.id);
  const progress = progressOf(d.progress);
  const owner = text(d.owner);
  const [editing, setEditing] = useState(false);
  const takenOn = owner && !owner.startsWith("room:") ? owner : undefined;
  const meta = [
    takenOn && (
      <a key="taken" href={`#/agents/${encodeURIComponent(takenOn)}`}>
        taken on by {takenOn}
      </a>
    ),
    variant === "working" && text(d.nextCheck) && `check ${text(d.nextCheck)}`,
    variant === "working" && (AUTONOMY[text(d.autonomy) ?? "suggest"] ?? text(d.autonomy)),
    text(d.from) && `from ${text(d.from)}`,
    `${variant === "waiting" ? "since" : "updated"} ${ago(lastMoved(record), now)}`,
  ].filter((p): p is string | ReactElement => !!p);
  const line = (label: string, field: string) =>
    text(d[field]) && (
      <div className="agent-page-line">
        <span className="agent-page-label">{label}</span> {text(d[field])} {held.has(field) && <Held />}
      </div>
    );

  return (
    <li className="agent-page-item">
      <div className="agent-page-goal">
        <span>{text(d.goal) ?? record.id}</span>
        {held.has("goal") && <Held />}
        {!room.archived && !editing && (
          <button type="button" className="room-edit" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {variant === "waiting" && (
        <div className="agent-page-line">
          <span className="agent-page-label">Waiting on</span> {text(d.waitingOn) ?? "someone"}{" "}
          {held.has("waitingOn") && <Held />}
        </div>
      )}
      {line(variant === "waiting" ? "Then" : "Next", "nextStep")}
      {variant === "working" && line("Done when", "doneWhen")}
      {variant === "working" &&
        progress &&
        ("label" in progress ? (
          <div className="agent-page-line">
            <span className="agent-page-label">At</span> {progress.label}
          </div>
        ) : (
          <div className="agent-page-progress">
            <Progress props={{ label: "", value: progress.value, max: progress.max }} />
          </div>
        ))}
      <Meta parts={meta} />
      {editing && (
        <ItemForm
          room={room}
          record={record}
          done={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
      <Updates record={record} />
    </li>
  );
}

/** A room's commitment changed as you: its next step and status, with a dated update saying a person did it. */
function ItemForm({ room, record, done }: { room: DirectoryRoom; record: StateRecordInfo; done: () => void }) {
  const wasNext = text(record.data.nextStep) ?? "";
  const wasStatus = text(record.data.status) ?? "open";
  const wasWaiting = text(record.data.waitingOn) ?? "";
  const [nextStep, setNextStep] = useState(wasNext);
  const [status, setStatus] = useState(wasStatus);
  const [waitingOn, setWaitingOn] = useState(wasWaiting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const changes = {
      ...(nextStep.trim() !== wasNext ? { nextStep: nextStep.trim() } : {}),
      ...(status !== wasStatus ? { status } : {}),
      ...(status === "waiting" && waitingOn.trim() !== wasWaiting ? { waitingOn: waitingOn.trim() } : {}),
    };
    if (Object.keys(changes).length === 0) return done();
    setBusy(true);
    setError(null);
    try {
      await editRoomCommitment(room.name, record.id, changes);
      done();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="room-form room-item-form" onSubmit={save}>
      <label>
        <span>Next step</span>
        <input type="text" value={nextStep} maxLength={300} onChange={(e) => setNextStep(e.target.value)} />
      </label>
      <label>
        <span>Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {status === "waiting" && (
        <label>
          <span>Waiting on</span>
          <input type="text" value={waitingOn} maxLength={200} onChange={(e) => setWaitingOn(e.target.value)} />
        </label>
      )}
      <div className="room-form-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={done} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="agent-page-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Result({ record }: { record: StateRecordInfo }) {
  return (
    <li className="agent-page-item agent-page-result">
      <div className="agent-page-goal">
        <span className="agent-page-done" aria-hidden="true">
          ✓
        </span>
        <span>{text(record.data.goal) ?? record.id}</span>
        <time className="agent-page-date" dateTime={lastMoved(record)}>
          {day(lastMoved(record))}
        </time>
      </div>
    </li>
  );
}
