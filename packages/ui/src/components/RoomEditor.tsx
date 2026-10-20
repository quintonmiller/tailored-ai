import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  catalogue,
  changeWords,
  type Edit,
  type Kinds,
  type MadeModel,
  type Move,
  madeByAgents,
  madeHere,
  moveKey,
  noSteps,
  palette,
  redoing,
  type Steps,
  showsChoices,
  stepped,
  TURNS,
  turned,
  undoing,
  withYourChange,
} from "../avatar/editing";
import type { ModelDef } from "../avatar/models";
import type { Room } from "../avatar/scene";
import type { StageEdit } from "../avatar/stage";
import { WorldPanel } from "./WorldPanel";

/**
 * Rearranging a room yourself, from inside the world: the Edit room button's
 * mode. Pick a thing and drag it; turn, copy, repaint or remove it; add more
 * from the catalogue. Each change is checked by the server the way the
 * agents' `place` tool checks theirs, then saved to the place's record
 * through the world-state API with the version it was made to, as yours: so
 * the redraw of untouched homes never replaces it, the room's recent changes
 * say "you moved the couch", and the agent whose room it is sees it the next
 * time it looks. If an agent changed the room meanwhile, nothing is written
 * over it: the room comes back as it is now, and you are told. Undo and redo
 * take back and make again your own changes, while you stay in the place.
 */

/** A place as the page has it, with what a write to it needs. */
export interface EditablePlace {
  id: string;
  /** As shown: the record, with its doors and anything lent to it. */
  room: Room;
  /** The record's version; 0 while it is drawn fresh, so the first change makes it. */
  version: number;
  scope: string;
  /** Fields shown that aren't the record's own: a meeting room's purpose, its room's. */
  lent?: string[];
}

/**
 * The record a room is kept as: without its doors, which the server works out, the models it is sent with, which
 * are records of their own, or anything it only borrows.
 */
export function recordOf(room: Room, lent: string[] = []): Room {
  const { doors: _doors, models: _models, ...rest } = room;
  const out: Record<string, unknown> = { ...rest };
  for (const field of lent) delete out[field];
  return out as unknown as Room;
}

/** What a change made: the room as the server checked it, and the thing it added or changed. */
interface Checked {
  place?: Room;
  item?: string;
  /** A model it added from the catalogue, by id, so the room draws it at once. */
  models?: Record<string, ModelDef>;
  /** Why it can't be made, in the server's words. */
  why?: string;
}

/** Ask the server what a change makes of the room. Nothing is written. */
async function tryEdit(id: string, place: Room, edit: Edit): Promise<Checked> {
  const { loose: _loose, elevation: _elevation, ...sent } = edit as Edit & Partial<Move>;
  try {
    const res = await fetch("/api/ext/builtin:places/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, place, edit: sent }),
    });
    const body = (await res.json().catch(() => ({}))) as Checked & { error?: string };
    if (!res.ok) return { why: body.error ?? `The room couldn't be checked (${res.status}).` };
    return body.place ? body : { why: body.why ?? "That can't be done here." };
  } catch (err) {
    return { why: `The room couldn't be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A version that moved under a write: someone else changed the place first. */
class Changed extends Error {}

/** Write a place's record as the person, if it is still at `version`; the version it is at after. */
async function write(place: EditablePlace, data: Room, version: number): Promise<number> {
  const res = await fetch(`/api/state/place/${encodeURIComponent(place.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, expectedVersion: version, scope: place.scope }),
  });
  const body = (await res.json().catch(() => ({}))) as { version?: number; error?: string };
  if (res.status === 409) throw new Changed(body.error);
  if (!res.ok) throw new Error(body.error ?? `Couldn't save the room (${res.status}).`);
  return body.version ?? version + 1;
}

/** Take a place back to being drawn fresh, if it is still at `version`: undoing the change that first kept it. */
async function unkeep(place: EditablePlace, version: number): Promise<void> {
  const res = await fetch(`/api/state/place/${encodeURIComponent(place.id)}?expectedVersion=${version}`, {
    method: "DELETE",
  });
  // Changed since, or gone already: either way someone else got there first, and theirs stands.
  if (res.status === 409 || res.status === 404) throw new Changed();
  if (!res.ok) throw new Error(`Couldn't undo (${res.status}).`);
}

/** A place's record as it is now, and who wrote it last: for showing the room an agent just changed. */
async function readRecord(
  id: string,
): Promise<{ data: Room; version: number; updatedBy?: { kind?: string; name?: string } } | undefined> {
  try {
    const res = await fetch(`/api/state/place/${encodeURIComponent(id)}`);
    return res.ok ? ((await res.json()) as { data: Room; version: number }) : undefined;
  } catch {
    return undefined;
  }
}

/** What the catalogue offers: every kind of thing, the models agents made, and what agents call the person. */
interface Offer {
  kinds: Kinds;
  models?: MadeModel[];
  person: string;
}

/**
 * The catalogue, asked when the page first rearranges a room, and kept while it is open; asked again each time
 * after, since agents make new models while you aren't looking.
 */
let kindsAsked: Promise<Offer> | undefined;
function askKinds(fresh = false): Promise<Offer> {
  if (fresh) kindsAsked = undefined;
  kindsAsked ??= fetch("/api/ext/builtin:places/edit/kinds").then(async (res) => {
    if (!res.ok) throw new Error(`The kinds of thing couldn't be had (${res.status}).`);
    return (await res.json()) as Offer;
  });
  kindsAsked.catch(() => {
    kindsAsked = undefined;
  });
  return kindsAsked;
}

/** What a thing that stands on others says when dragged over nothing it can stand on. */
const NEEDS_A_TOP = "It needs something with a top to stand on: a desk, a table or a shelf.";

/**
 * A change you saved, shown until the page hears of something newer: the
 * room as saved, the version it is at, and `was`, the version it was at
 * before you took the place back to being drawn fresh (0), while the page
 * may not have heard yet.
 */
export interface Saved {
  id: string;
  room: Room;
  version: number;
  was?: number;
}

/**
 * Whether your saved change is still ahead of what the page has: the same
 * place, and the page hasn't heard of it yet. Once it has, the page's room is
 * the same record with its doors asked for again, so it is the one shown.
 */
export function ahead(saved: Saved, place: EditablePlace): boolean {
  if (saved.id !== place.id) return false;
  return saved.was !== undefined ? place.version > 0 && place.version <= saved.was : saved.version > place.version;
}

/** The place as a change is made to it: its record as the server takes it, and the version that record is at. */
type Base = { place: EditablePlace; record: Room; version: number };

/** Where a thing is being put, before it is saved, and whether it fits there: unknown while the server is asked. */
type Pending = Move & { fits?: boolean; why?: string };

export interface RoomEditor {
  /** Rearranging now. */
  editing: boolean;
  start: () => void;
  stop: () => void;
  /** The room to show while a change you saved is newer than what the page last heard; undefined otherwise. */
  room?: Room;
  /** What the stage needs while rearranging. */
  stage?: StageEdit;
  /** The catalogue is open, in the chat's column. */
  adding: boolean;
  /** The buttons over the stage while rearranging: done, undo, redo, add. */
  tools: ReactNode;
  /** The bar over the foot of the stage while rearranging: what is picked, and what you can do with it. */
  bar: ReactNode;
  /** The catalogue, while it is open. */
  shelf: ReactNode;
}

/** Rearranging the place on screen: `place` is it as the page last heard, undefined when it can't be rearranged. */
export function useRoomEditor(
  place: EditablePlace | undefined,
  /** What a widget can be set to show beyond its own choices, as of now: the rooms there are, the Board's widgets. */
  have: () => { rooms?: string[]; widgets?: { id: string; title?: string }[] } = () => ({}),
): RoomEditor {
  const [editing, setEditing] = useState(false);
  const [kinds, setKinds] = useState<Offer | null>(null);
  const [local, setLocal] = useState<Saved | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  /** Whether the catalogue shows the models of agents this place isn't for. */
  const [othersShown, setOthersShown] = useState(false);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [steps, setSteps] = useState<Steps<Room>>(noSteps);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState(0);
  const busy = working > 0;

  // Your last saved change, the moment it is saved (the state above follows on the next render): what the next change
  // is made to, and the version it is written with.
  const latest = useRef<Saved | null>(null);
  const keep = useCallback((saved: Saved | null) => {
    latest.current = saved;
    setLocal(saved);
  }, []);
  // The version your own last write left the record at, in this place (0 once you took it back to being drawn): undo
  // and redo write only over that, so a change anyone else made since is never taken back along with yours.
  const wrote = useRef<{ id: string; version: number } | null>(null);
  const mine = local && place && ahead(local, place) ? local : null;
  const id = place?.id;
  const shown = mine?.room ?? place?.room;

  // Somewhere else, or something newer heard: your saved change is the page's now, or behind it.
  useEffect(() => {
    if (local && (!place || !ahead(local, place))) keep(null);
  }, [local, place, keep]);
  // Another place: done rearranging this one, and nothing of it to undo there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: arriving somewhere else is what clears it.
  useEffect(() => {
    setEditing(false);
    setSelected(undefined);
    setPending(undefined);
    setSteps(noSteps());
    wrote.current = null;
    setNotice(undefined);
    setAdding(false);
  }, [id]);

  // The latest of what the page has, for the handlers the stage and the keys call.
  const now = useRef({ place, selected, pending, kinds, steps });
  now.current = { place, selected, pending, kinds, steps };

  /** The place as your next change is made to it: its record as the server takes it, and the version it is at. */
  const current = (): Base | undefined => {
    const p = now.current.place;
    if (!p) return undefined;
    const l = latest.current;
    const use = l && ahead(l, p) ? l : undefined;
    return { place: p, record: recordOf(use?.room ?? p.room, p.lent), version: use?.version ?? p.version };
  };
  /**
   * Shown as saved: the record, with its doors, its models (and any `added` with this change) and anything lent to
   * it, as the page last had them.
   */
  const asShown = (data: Room, added?: Record<string, ModelDef>): Room => {
    const p = now.current.place;
    const l = latest.current;
    const extra: Record<string, unknown> = {};
    for (const field of p?.lent ?? []) extra[field] = (p?.room as unknown as Record<string, unknown>)[field];
    const had = { ...p?.room.models, ...(l && p && l.id === p.id ? l.room.models : {}) };
    const models = { ...had, ...added };
    return {
      ...data,
      ...extra,
      ...(p?.room.doors ? { doors: p.room.doors } : {}),
      ...(Object.keys(models).length ? { models } : {}),
    };
  };

  // Changes go one at a time, each made to the room as the last left it: a quick second drag never writes over the
  // first, nor is checked against the room before it.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const run = (job: () => Promise<void>): Promise<void> => {
    setWorking((n) => n + 1);
    const next = queue.current.then(job).finally(() => setWorking((n) => n - 1));
    queue.current = next.catch(() => {});
    return next;
  };

  const start = useCallback(() => {
    setEditing(true);
    setNotice(undefined);
    // Picking and adding wait for the kinds of thing; if they can't be had, the bar says why.
    askKinds(true)
      .then(setKinds)
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
  }, []);
  const stop = useCallback(() => {
    setEditing(false);
    setSelected(undefined);
    setPending(undefined);
    setAdding(false);
    setNotice(undefined);
  }, []);

  /**
   * Your change didn't save because the place moved on: shown as it is now,
   * read again rather than waiting for the page to hear of it, and said who by.
   */
  const changedUnder = async (where: string, lost: string) => {
    setPending(undefined);
    now.current.steps = noSteps();
    setSteps(now.current.steps);
    wrote.current = null;
    const record = await readRecord(where);
    keep(
      record?.data && typeof record.version === "number"
        ? { id: where, room: asShown(record.data), version: record.version }
        : null,
    );
    const who = record?.updatedBy?.kind === "agent" ? record.updatedBy.name : undefined;
    setNotice(
      `${who ?? "Someone"} changed this room while you were rearranging it, so ${lost}. This is the room as it is now.`,
    );
  };
  /** Something went wrong saving: said, and the thing back where it was; `lost`, what didn't happen if it changed. */
  const failed = async (err: unknown, where: string, lost = "your last change wasn't saved") => {
    if (err instanceof Changed) return changedUnder(where, lost);
    setPending(undefined);
    setNotice(err instanceof Error ? err.message : String(err));
  };

  /**
   * Save what a change made to `c`, the room as it was when the server was
   * asked, with yours at the top of its recent changes; `picked`, what to
   * pick after. Written with the version `c` was at, so a change anyone made
   * while the server was being asked isn't written over.
   */
  const save = async (c: Base, edit: Edit, after: Room, picked?: string, added?: Record<string, ModelDef>) => {
    const k = now.current.kinds;
    if (!k) return;
    const what = changeWords(edit, c.record, after);
    const data = withYourChange(recordOf(after, c.place.lent), { who: k.person, what, at: new Date().toISOString() });
    try {
      const version = await write(c.place, data, c.version);
      // Your changes before this one stay yours to take back only if nobody changed the room in between.
      const onMine = wrote.current?.id === c.place.id && wrote.current.version === c.version;
      wrote.current = { id: c.place.id, version };
      keep({ id: c.place.id, room: asShown(data, added), version });
      now.current.steps = stepped(onMine ? now.current.steps : noSteps(), {
        before: c.record,
        after: data,
        from: c.version,
        what,
      });
      setSteps(now.current.steps);
      setPending(undefined);
      setNotice(undefined);
      if (picked !== undefined) setSelected(picked || undefined);
    } catch (err) {
      await failed(err, c.place.id);
    }
  };

  /** Make a change: asked of the server, then saved; what it says when it can't be made is shown. */
  const change = (edit: Edit, pick?: (made: Checked) => string | undefined) =>
    run(async () => {
      const c = current();
      if (!c) return;
      const made = await tryEdit(c.place.id, c.record, edit);
      if (!made.place) {
        setNotice(made.why);
        return;
      }
      await save(c, edit, made.place, pick ? (pick(made) ?? "") : undefined, made.models);
    });

  // What the server said about each place a thing was dragged to, while the room stays at one version.
  const asked = useRef({ id: "", version: -1, answers: new Map<string, Promise<Checked>>() });
  const check = (move: Move, c: Base): Promise<Checked> => {
    if (asked.current.id !== c.place.id || asked.current.version !== c.version)
      asked.current = { id: c.place.id, version: c.version, answers: new Map() };
    const key = moveKey(move);
    let answer = asked.current.answers.get(key);
    if (!answer) {
      answer = tryEdit(c.place.id, c.record, { op: "move", ...move });
      asked.current.answers.set(key, answer);
    }
    return answer;
  };
  // One question at a time while dragging: the latest place waits for the one being asked, and the rest are skipped.
  const asking = useRef<{ busy: boolean; next?: Move }>({ busy: false });
  const ask = (move: Move) => {
    if (asking.current.busy) {
      asking.current.next = move;
      return;
    }
    const c = current();
    if (!c) return;
    asking.current.busy = true;
    void check(move, c)
      .then((got) => {
        // Only for where it is now: the thing may have been dragged on, or let go and saved, since.
        setPending((p) => (p && moveKey(p) === moveKey(move) ? { ...p, fits: !!got.place, why: got.why } : p));
      })
      .finally(() => {
        asking.current.busy = false;
        const next = asking.current.next;
        asking.current.next = undefined;
        if (next) ask(next);
      });
  };

  /** Where a thing is being put: shown there at once, and asked whether it fits. */
  const propose = (move: Move) => {
    if (move.loose) {
      setPending({ ...move, fits: false, why: NEEDS_A_TOP });
      return;
    }
    setPending({ ...move });
    ask(move);
  };

  /** Put a thing here: saved if it fits, otherwise back where it was, saying why. */
  const put = (move: Move) => {
    if (move.loose) {
      setPending(undefined);
      setNotice(NEEDS_A_TOP);
      return;
    }
    setPending({ ...move });
    void run(async () => {
      // Asked of the room as it is once any change before it is saved: the answer for an older room is asked again.
      const c = current();
      if (!c) return;
      const got = await check(move, c);
      if (!got.place) {
        setPending((p) => (p && moveKey(p) === moveKey(move) ? undefined : p));
        setNotice(got.why);
        return;
      }
      await save(c, { op: "move", ...move }, got.place);
    });
  };

  const thing = (id: string | undefined) => {
    const c = current();
    return id ? c?.record.props.find((p) => p.id === id) : undefined;
  };

  /** Turn what is picked by `by` degrees: saved if it fits turned there, otherwise shown turned in red, to drag on. */
  const turn = (by: number) => {
    const n = now.current;
    const prop = thing(n.selected);
    if (!prop || !n.kinds) return;
    if (n.kinds.kinds[prop.kind]?.mount === "wall") {
      setNotice(`${prop.name.charAt(0).toUpperCase()}${prop.name.slice(1)} hangs flat on its wall.`);
      return;
    }
    const from = n.pending?.item === prop.id ? n.pending : undefined;
    const on = from?.on ?? prop.on;
    const move: Move = {
      item: prop.id,
      at: from?.at ?? prop.at,
      facing: turned(from?.facing ?? prop.facing, by),
      ...(on ? { on } : {}),
      ...(from?.elevation !== undefined ? { elevation: from.elevation } : {}),
    };
    setPending({ ...move });
    void run(async () => {
      const c = current();
      if (!c) return;
      const got = await check(move, c);
      if (got.place) await save(c, { op: "move", ...move }, got.place);
      else setPending((p) => (p && moveKey(p) === moveKey(move) ? { ...p, fits: false, why: got.why } : p));
    });
  };
  const remove = () => {
    const prop = thing(now.current.selected);
    if (prop) void change({ op: "remove", item: prop.id }, () => undefined);
  };
  const copy = () => {
    const prop = thing(now.current.selected);
    if (prop) void change({ op: "add", kind: prop.kind, like: prop.id }, (made) => made.item);
  };
  const paint = (color: string) => {
    const prop = thing(now.current.selected);
    if (prop) void change({ op: "color", item: prop.id, color });
  };
  const add = (kind: string) => void change({ op: "add", kind }, (made) => made.item);
  const addModel = (model: string) => void change({ op: "add", kind: "model", model }, (made) => made.item);
  const show = (shows: string) => {
    const prop = thing(now.current.selected);
    if (prop && (prop.shows ?? "") !== shows) void change({ op: "shows", item: prop.id, shows: shows || null });
  };

  // Undo and redo write over the version your last write left, not the newest the page has heard: if anyone changed
  // the room since, the server says so, and theirs stands.
  const undo = () =>
    run(async () => {
      const c = current();
      const u = undoing(now.current.steps);
      const at = wrote.current;
      if (!c || !u || at?.id !== c.place.id) return;
      try {
        if (u.step.from === 0) {
          // The change that first kept the place: back to it being drawn fresh.
          await unkeep(c.place, at.version);
          wrote.current = { id: c.place.id, version: 0 };
          keep({ id: c.place.id, room: asShown(u.step.before), version: 0, was: at.version });
        } else {
          const version = await write(c.place, u.step.before, at.version);
          wrote.current = { id: c.place.id, version };
          keep({ id: c.place.id, room: asShown(u.step.before), version });
        }
        now.current.steps = u.steps;
        setSteps(u.steps);
        setPending(undefined);
        setNotice(undefined);
      } catch (err) {
        await failed(err, c.place.id, "nothing was taken back");
      }
    });
  const redo = () =>
    run(async () => {
      const c = current();
      const r = redoing(now.current.steps);
      const at = wrote.current;
      if (!c || !r || at?.id !== c.place.id) return;
      try {
        const version = await write(c.place, r.step.after, at.version);
        wrote.current = { id: c.place.id, version };
        keep({ id: c.place.id, room: asShown(r.step.after), version });
        now.current.steps = r.steps;
        setSteps(r.steps);
        setPending(undefined);
        setNotice(undefined);
      } catch (err) {
        await failed(err, c.place.id, "nothing was made again");
      }
    });

  // The handlers as they are now, for keys and the stage, which hold on to what they were first given.
  const act = useRef({ turn, remove, undo, redo, stop, propose, put });
  act.current = { turn, remove, undo, redo, stop, propose, put };

  // The keys: R turns, Delete removes, Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, Escape lets go and then stops.
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      const a = act.current;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        e.preventDefault();
        if (adding) setAdding(false);
        else if (now.current.pending) setPending(undefined);
        else a.stop();
      } else if (mod && e.code === "KeyZ") {
        e.preventDefault();
        void (e.shiftKey ? a.redo() : a.undo());
      } else if (mod && e.code === "KeyY") {
        e.preventDefault();
        void a.redo();
      } else if (!mod && !e.altKey && e.code === "KeyR" && now.current.selected) {
        e.preventDefault();
        a.turn(e.shiftKey ? TURNS.big : -TURNS.big);
      } else if ((e.key === "Delete" || e.key === "Backspace") && now.current.selected) {
        e.preventDefault();
        a.remove();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editing, adding]);

  const onSelect = useCallback((picked: string | undefined) => {
    // Picking something else lets go of where the last thing was being put.
    setPending((p) => (p && p.item !== picked ? undefined : p));
    setSelected(picked);
  }, []);
  const onDrag = useCallback((move: Move) => act.current.propose(move), []);
  const onDrop = useCallback((move: Move) => act.current.put(move), []);
  const stage = useMemo(
    (): StageEdit | undefined =>
      editing && kinds
        ? {
            kinds: kinds.kinds,
            ...(selected ? { selected } : {}),
            ...(pending ? { pending } : {}),
            onSelect,
            onDrag,
            onDrop,
          }
        : undefined,
    [editing, kinds, selected, pending, onSelect, onDrag, onDrop],
  );

  const picked = thing(selected);
  const swatches = useMemo(() => (shown ? palette(shown) : []), [shown]);
  const groups = useMemo(() => (kinds ? catalogue(kinds.kinds) : []), [kinds]);
  const here = useMemo(() => (id && shown ? madeHere(id, shown) : []), [id, shown]);
  const made = useMemo(
    () => (kinds ? madeByAgents(kinds.models ?? [], kinds.kinds, here) : { here: [], others: [] }),
    [kinds, here],
  );
  // A model keeps its parts' own colours: there is nothing to repaint.
  const fixedColours = !!picked?.model;
  const hangs = !!picked && kinds?.kinds[picked.kind]?.mount === "wall";
  // A widget that can show more than one thing: what it can be set to.
  const choices = picked ? showsChoices(picked.kind, have()) : undefined;
  // A thing being put somewhere it can't go says why; otherwise the last thing the server or a save said.
  const said = pending?.fits === false ? pending.why : notice;

  const tools = editing ? (
    <>
      <button type="button" className="talk-tool room-edit-done" onClick={stop} title="Stop rearranging (Esc)">
        Done
      </button>
      <button
        type="button"
        className="talk-tool"
        disabled={!steps.done.length || busy}
        onClick={() => void undo()}
        title="Take back your last change (Ctrl+Z)"
      >
        Undo
      </button>
      <button
        type="button"
        className="talk-tool"
        disabled={!steps.undone.length || busy}
        onClick={() => void redo()}
        title="Make it again (Ctrl+Shift+Z)"
      >
        Redo
      </button>
      <button
        type="button"
        className="talk-tool"
        aria-expanded={adding}
        disabled={!kinds}
        onClick={() => setAdding(!adding)}
        title="Furniture, plants, lights and things for the walls"
      >
        Add things
      </button>
    </>
  ) : null;

  // The bar keeps one shape, picked or not, so the room framed above it never shifts as you pick things: what can't
  // be done yet is greyed, and the line at its foot says what you can do when there is nothing else to say.
  const off = !picked || busy;
  const bar = editing ? (
    <div className="room-edit-bar" role="toolbar" aria-label="Rearranging the room">
      <div className="room-edit-row">
        <strong className={`room-edit-name${picked ? "" : " room-edit-none"}`}>
          {picked?.name ?? "Nothing picked"}
        </strong>
        <button type="button" disabled={off || hangs} onClick={() => turn(TURNS.big)} title="A quarter turn (Shift+R)">
          ↺ 90°
        </button>
        <button type="button" disabled={off || hangs} onClick={() => turn(TURNS.small)} title="A little">
          ↺ 15°
        </button>
        <button type="button" disabled={off || hangs} onClick={() => turn(-TURNS.small)} title="A little">
          15° ↻
        </button>
        <button type="button" disabled={off || hangs} onClick={() => turn(-TURNS.big)} title="A quarter turn (R)">
          90° ↻
        </button>
        <button type="button" disabled={off} onClick={copy} title="Another one, beside it">
          Copy
        </button>
        <button type="button" className="room-edit-remove" disabled={off} onClick={remove} title="Remove (Delete)">
          Remove
        </button>
      </div>
      <fieldset className="room-edit-swatches" aria-label="Colours" disabled={off || fixedColours}>
        {swatches.map((s) => (
          <button
            key={s.color}
            type="button"
            className="room-edit-swatch"
            aria-pressed={!!picked && picked.color === s.color}
            aria-label={s.word ?? (s.from ? `Like ${s.from}` : s.color)}
            title={s.word ?? (s.from ? `Like ${s.from}` : s.color)}
            style={{ background: s.color }}
            onClick={() => paint(s.color)}
          />
        ))}
        {busy && <span className="room-edit-saving">Saving…</span>}
      </fieldset>
      {picked && choices && (
        <label className="room-edit-shows">
          <span>Shows</span>
          <select value={picked.shows ?? ""} disabled={busy} onChange={(e) => show(e.target.value)}>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            {picked.shows && !choices.some((c) => c.value === picked.shows) && (
              <option value={picked.shows}>{picked.shows}</option>
            )}
          </select>
        </label>
      )}
      {said ? (
        <output className="room-edit-said">{said}</output>
      ) : (
        <p className="room-edit-keys">
          {hangs
            ? "Drag it along its wall, or onto the other wall · Delete removes it · Ctrl+Z undoes"
            : picked
              ? "Drag it to move it, Shift for no grid · R turns it · Delete removes it · Ctrl+Z undoes"
              : "Pick something to move it, or add things · drag the floor to look round, the wheel to zoom · Esc when done"}
        </p>
      )}
    </div>
  ) : null;

  const shelf =
    editing && adding ? (
      <WorldPanel kicker="Rearranging" title="Add things" className="room-edit-add" onClose={() => setAdding(false)}>
        <p className="world-panel-quiet">
          Pick one: it goes somewhere free near the middle, ready to drag where you want it.
        </p>
        {/* What the agents made first: this place's own agents' things, and everyone else's folded until asked for. */}
        {made.here.length + made.others.length > 0 && (
          <section className="room-edit-group" aria-label="Made by agents">
            <h3>Made by agents</h3>
            <div className="room-edit-kinds">
              {[...made.here, ...(othersShown ? made.others : [])].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={busy}
                  title={[m.about, m.goes ? `Goes ${m.goes}` : undefined].filter(Boolean).join(" · ") || undefined}
                  onClick={() => addModel(m.id)}
                >
                  {m.label.charAt(0).toUpperCase() + m.label.slice(1)}
                  <span className="room-edit-goes">
                    by {m.by}
                    {m.goes ? ` · ${m.goes}` : ""}
                  </span>
                </button>
              ))}
            </div>
            {made.others.length > 0 && (
              <button
                type="button"
                className="world-panel-inline world-panel-link room-edit-more"
                aria-expanded={othersShown}
                onClick={() => setOthersShown((v) => !v)}
              >
                {othersShown
                  ? "Fewer"
                  : `${made.here.length ? "More by other agents" : "By agents"} (${made.others.length})`}
              </button>
            )}
          </section>
        )}
        {groups.map((g) => (
          <section key={g.id} className="room-edit-group" aria-label={g.label}>
            <h3>{g.label}</h3>
            <div className="room-edit-kinds">
              {g.kinds.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  disabled={busy}
                  title={k.goes ? `Goes ${k.goes}` : undefined}
                  onClick={() => add(k.kind)}
                >
                  {k.noun.charAt(0).toUpperCase() + k.noun.slice(1)}
                  {k.goes && <span className="room-edit-goes">{k.goes}</span>}
                </button>
              ))}
            </div>
          </section>
        ))}
      </WorldPanel>
    ) : null;

  return {
    editing,
    start,
    stop,
    ...(mine ? { room: mine.room } : {}),
    ...(stage ? { stage } : {}),
    adding: editing && adding,
    tools,
    bar,
    shelf,
  };
}
