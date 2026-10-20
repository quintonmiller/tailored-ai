/**
 * What the surfaces in the room show (`surface-layer.ts`): live HTML on a
 * task board, a screen, a calendar and a kiosk, drawn with the page's own
 * components into each surface's element through a portal, so they read the
 * page's data and use its styles. A face is used once it is brought up to
 * read (a kiosk's at once); until then it is inert, and a click on it brings
 * it up instead. What it shows comes from one provider round them all.
 */
import {
  createContext,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { DashboardWidgetSpec } from "../api";
import { InterfaceComponents } from "../components/InterfaceComponents";
import { taskLink } from "../components/WorldDashboard";
import { widgetRenderers } from "../components/widgets";
import { useAgentColor } from "../lib/body-colors";
import type { ComponentSpec } from "../lib/content.js";
import { nameOf } from "../lib/conversations";
import { clockTime } from "../lib/did";
import type { Need } from "../lib/needs";
import { GROUPS, type Group } from "../lib/tasks";
import { type BoardTask, type ColumnSpan, columnAt, columnsFor, moveTo } from "./boards";
import {
  byDay,
  type CalendarMode,
  type CalendarView,
  calendarDays,
  type Done,
  onDay,
  repeatDays,
  type Wake,
  withRepeats,
} from "./calendar";
import type { Notes } from "./routines";
import type { Prop } from "./scene";
import { PAGE_MS, pageAt, type ScreenCard, screenWidgets, type Tone } from "./screens";
import type { Stage, SurfaceView, UseSpot } from "./stage";
import { SURFACE_PX } from "./surfaces";
import { WidgetFace } from "./WidgetFaces";
import {
  assigneesOf,
  type BoardFilter,
  boardFiltered,
  FACE_SIZE,
  type FaceChoice,
  type FilterTask,
  faceOf,
  projectsOf,
  WIP_EACH,
  type WorldData,
} from "./widgets";

/** What moving a task on a board changes: its status, and coming out of Blocked, the reason. */
export type TaskMove = { status: string; blocked_reason?: null };

/** What the faces on the walls show, and what they do when used: from the page, for all of them. */
export interface FaceData {
  /** The tasks the boards here show. */
  tasks: BoardTask[];
  /** The pages a screen in a home goes through, and a screen anywhere while the dashboard has nothing to show. */
  cards?: ScreenCard[];
  /** The dashboard's widgets, for a screen outside a home, drawn by the Board page's own renderers. */
  widgets?: DashboardWidgetSpec[];
  /** What the calendars here show. */
  calendar?: CalendarView;
  /** What a meeting room's whiteboard says: its room's last few lines. */
  notes?: Notes;
  /** Something on a face was used: what it is for, where on it, and which thing in the room the face is on. */
  onUse?: (action: string, on?: UseSpot, thing?: string) => void;
  /** A note was moved to another column on a board: save it. Rejects with why it couldn't be. */
  onTaskMove?: (id: string, change: TaskMove) => Promise<unknown>;
  /** What the widgets show (`WidgetFaces.tsx`): what agents are doing, the feed, the numbers, the photos. */
  world?: WorldData;
  /** Approve or deny what an agent waits on, from a needs-you board. Rejects with why it couldn't be. */
  onApprove?: (need: Need, approved: boolean) => Promise<unknown>;
}

const Faces = createContext<FaceData>({ tasks: [] });

/** One surface, as the face drawn in it needs it. */
interface SurfaceApi {
  id: string;
  /** Brought up close to be read and used. */
  focused: boolean;
  /** The surface's element: whether a key was pressed in it. */
  el: HTMLElement | null;
  /** Where a pointer is on the surface, in its own pixels from its top left. */
  pointOn: (e: { clientX: number; clientY: number }) => [number, number] | undefined;
}

const SurfaceContext = createContext<SurfaceApi>({ id: "", focused: false, el: null, pointOn: () => undefined });

/** What the faces need of the stage. */
export type SurfaceStage = Pick<Stage, "surfaceReady" | "focusSurface" | "surfacePoint">;

/** Every live surface, each drawn into its own element. */
export function SurfacePortals({ views, data, stage }: { views: SurfaceView[]; data: FaceData; stage: SurfaceStage }) {
  const reading = views.some((v) => v.focused);
  return (
    <Faces.Provider value={data}>
      {views.map((v) => createPortal(<SurfaceFrame view={v} stage={stage} reading={reading} />, v.el, v.id))}
    </Faces.Provider>
  );
}

/**
 * One surface's face: inert until it is in use, and once brought up to read,
 * with the keyboard in it, a Tab from its first button. While another is
 * read, a kiosk is inert too: a click off what is read only steps back, and
 * never presses a kiosk on the way. Tells the stage once it is drawn, so the
 * surface shows through the picture only with something on it.
 */
function SurfaceFrame({ view, stage, reading }: { view: SurfaceView; stage: SurfaceStage; reading: boolean }) {
  const root = useRef<HTMLElement>(null);
  const { id, focused } = view;
  // What is used on this face says which thing it is on, so what it opens can be kept beside that thing.
  const data = useContext(Faces);
  const thing = view.prop?.id;
  const own = useMemo(
    (): FaceData => ({ ...data, onUse: (action, on) => data.onUse?.(action, on, thing) }),
    [data, thing],
  );
  useLayoutEffect(() => {
    stage.surfaceReady(id);
  }, [stage, id]);
  useEffect(() => {
    if (!focused) return;
    root.current?.focus({ preventScroll: true });
  }, [focused]);
  const api = useMemo(
    (): SurfaceApi => ({ id, focused, el: view.el, pointOn: (e) => stage.surfacePoint(id, e) }),
    [stage, id, focused, view.el],
  );
  const active = focused || (view.use === "direct" && !reading);
  // A model's face is the agent interface it carries, whatever kind of thing it is on; any other prop shows the
  // widget its kind and `shows` name.
  const choice = view.prop && !view.component ? faceOf(view.prop) : undefined;
  const face = view.render ? (
    view.render()
  ) : view.component ? (
    <ModelFace spec={view.component} />
  ) : view.prop && choice ? (
    <PropFace prop={view.prop} choice={choice} />
  ) : null;
  return (
    <Faces.Provider value={own}>
      <SurfaceContext.Provider value={api}>
        <section
          ref={root}
          className={`sf sf-${view.component ? "face" : (view.prop?.kind ?? "own")}${choice ? ` sf-face-${choice.face}` : ""}`}
          inert={!active}
          tabIndex={-1}
          aria-label={view.label}
        >
          {choice ? (
            <Fit px={view.px} face={choice.face}>
              {face}
            </Fit>
          ) : (
            face
          )}
        </section>
      </SurfaceContext.Provider>
    </Faces.Provider>
  );
}

/**
 * A face on a model an agent made: the agent interface it shows, drawn by the
 * chat's own renderer, so a tick or a button does here exactly what it does
 * under a reply, writing the record as you, with the interface's own checks.
 */
function ModelFace({ spec }: { spec: ComponentSpec }) {
  return (
    <div className="sf-face-page">
      <InterfaceComponents specs={[spec]} />
    </div>
  );
}

/**
 * A face on something it wasn't made for (a status board on a display stand,
 * a clock on a desk monitor): laid out at the height it was made at, as wide
 * as the surface's shape makes that, and zoomed to fit. On its own kind of
 * thing it fits as it is.
 */
function Fit({ px, face, children }: { px: [number, number]; face: FaceChoice["face"]; children: ReactNode }) {
  const tall = FACE_SIZE[face][1] * SURFACE_PX;
  const k = px[1] / tall;
  if (Math.abs(k - 1) < 0.02) return children;
  return (
    <div className="sf-fit" style={{ width: px[0] / k, height: tall, zoom: k }}>
      {children}
    </div>
  );
}

/** The face a prop has, by the widget it shows (`faceOf`). */
function PropFace({ prop, choice }: { prop: Prop; choice: FaceChoice }) {
  const data = useContext(Faces);
  const surface = useContext(SurfaceContext);
  switch (choice.face) {
    case "tasks":
      return <BoardFace heading={prop.label ?? "Tasks"} />;
    case "dashboard":
      return <ScreenFace {...(choice.arg ? { pin: choice.arg } : {})} />;
    case "calendar":
      return <CalendarFace />;
    case "whiteboard":
      return <NotesFace />;
    case "kiosk":
      return <KioskFace label={prop.label ?? ""} action={prop.action} />;
    default:
      return data.world ? (
        <WidgetFace
          choice={choice}
          world={data.world}
          surface={surface}
          actions={{
            ...(data.onUse ? { onUse: data.onUse } : {}),
            ...(data.onApprove ? { onApprove: data.onApprove } : {}),
          }}
        />
      ) : null;
  }
}

/**
 * A meeting room's whiteboard: what its room said last, a line each, who said
 * it in their colour and how it began; and how long ago that was. Only the
 * first few words of each, two rows at most: the conversation itself is the
 * room's. A whiteboard with no room to speak for (one an agent put up
 * somewhere else) is clean.
 */
function NotesFace() {
  const { notes } = useContext(Faces);
  if (!notes) return <div className="sf-notes" />;
  return (
    <div className="sf-notes">
      <div className="sf-notes-head">
        <span className="sf-notes-room">#{notes.room}</span>
        {notes.talked && <span className="sf-notes-when">{notes.talked}</span>}
      </div>
      {notes.lines.length ? (
        <ul className="sf-notes-lines">
          {notes.lines.map((l, i) => (
            <li key={i} className="sf-notes-line">
              <span className="sf-notes-who" style={{ color: l.ink }}>
                {l.agent ? nameOf(l.agent) : l.who}
              </span>
              <span className="sf-notes-words">{l.words}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sf-notes-none">Nothing said here yet.</p>
      )}
    </div>
  );
}

/** An agent's name with the colour its body wears, for a note or a line on a calendar: the dot by its name elsewhere. */
function Who({ agent }: { agent: string }) {
  const color = useAgentColor()(agent);
  return (
    <span className="sf-who" style={{ ["--who" as string]: color }}>
      {nameOf(agent)}
    </span>
  );
}

// --------------------------------------------------------------------------
// The task board
// --------------------------------------------------------------------------

/** Notes a column shows before it says how many more there are, while the board isn't being read. */
const NOTES_SHOWN = 4;
/** Pixels a press has to move before it is a drag rather than a click. */
const DRAG_PX = 6;

/**
 * Where an element is inside a face, in the face's own pixels: its offsets
 * added up to the face's root, less however far what it sits in has
 * scrolled. Not its place on the page, which the room's 3D transform skews.
 */
function offsetIn(el: HTMLElement, root: HTMLElement): [number, number] {
  let x = 0;
  let y = 0;
  for (let e: HTMLElement | null = el; e && e !== root; ) {
    const parent = e.offsetParent as HTMLElement | null;
    const scrolled = parent && parent !== root;
    x += e.offsetLeft - (scrolled ? parent.scrollLeft : 0);
    y += e.offsetTop - (scrolled ? parent.scrollTop : 0);
    e = parent;
  }
  return [x, y];
}

/** A note being dragged: which, where it was picked up, where it is now on the board, and the column under it. */
interface Drag {
  id: string;
  from: [number, number];
  /** Where on the note it was picked up, from its top left, in the board's pixels. */
  grab: [number, number];
  size: [number, number];
  at?: [number, number];
  over?: Group["id"];
}

/**
 * A task board: a column for each stage a task goes through, a sticky note
 * for each task. Read close up, every note shows, a note opens its card, and
 * a note dragged to another column (or moved with Shift and the arrows)
 * changes its status, there at once and saved as a card would save it.
 */
function BoardFace({ heading }: { heading: string }) {
  const { tasks, onUse, onTaskMove, world } = useContext(Faces);
  const surface = useContext(SurfaceContext);
  // Read close up, narrowed to one agent's tasks or one project's; put down, everything again.
  const [filter, setFilter] = useState<BoardFilter>({});
  useEffect(() => {
    if (!surface.focused) setFilter({});
  }, [surface.focused]);
  const root = useRef<HTMLDivElement>(null);
  // Notes moved here and not yet saved: shown where they were put meanwhile.
  const [moved, setMoved] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A press that turned into a drag is no click on the note when it is let go.
  const dragged = useRef(false);
  useEffect(() => {
    setMoved((was) => {
      const left = Object.entries(was).filter(([id, status]) => tasks.find((t) => t.id === id)?.status !== status);
      return left.length === Object.keys(was).length ? was : Object.fromEntries(left);
    });
  }, [tasks]);
  const all = useMemo(() => tasks.map((t) => (moved[t.id] ? { ...t, status: moved[t.id] } : t)), [tasks, moved]);
  const shown = surface.focused ? boardFiltered(all as FilterTask[], filter) : all;
  const columns = columnsFor(shown, surface.focused ? Number.POSITIVE_INFINITY : NOTES_SHOWN);
  const open = shown.filter((t) => !GROUPS[3].statuses.includes(t.status)).length;
  // Work in progress: what is under Doing, said in the board's heading, where it never squeezes a column's name.
  const doing = columns.find((c) => c.id === "doing");
  const wip = doing ? doing.notes.length + doing.more : 0;
  const people = surface.focused ? assigneesOf(all) : [];
  const projects = surface.focused ? projectsOf(all as FilterTask[]) : [];

  const move = async (task: BoardTask, column: Group["id"]) => {
    const change = moveTo(task, column);
    if (!change || !onTaskMove) return;
    setProblem(null);
    setMoved((was) => ({ ...was, [task.id]: change.status }));
    // Done with, saved or not, unless the note has been moved again since: the page's tasks say where it is now,
    // as the server keeps it, or where it was if the move failed.
    const settle = () =>
      setMoved((was) => {
        if (was[task.id] !== change.status) return was;
        const { [task.id]: _, ...rest } = was;
        return rest;
      });
    try {
      await onTaskMove(task.id, change);
      settle();
    } catch (err) {
      settle();
      setProblem(`Couldn't move “${task.title}”: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  /** The columns where they are laid out now, in the board's own pixels. */
  const spans = (): ColumnSpan[] => {
    const board = root.current;
    if (!board) return [];
    return [...board.querySelectorAll<HTMLElement>("[data-column]")].map((el) => ({
      id: el.dataset.column as Group["id"],
      left: offsetIn(el, board)[0],
      width: el.offsetWidth,
    }));
  };

  const onDown = (e: PointerEvent<HTMLButtonElement>, task: BoardTask) => {
    if (e.button !== 0 || !surface.focused || !onTaskMove) return;
    const at = surface.pointOn(e);
    const note = e.currentTarget;
    const [left, top] = root.current ? offsetIn(note, root.current) : [0, 0];
    dragged.current = false;
    note.setPointerCapture?.(e.pointerId);
    setDrag({
      id: task.id,
      from: [e.clientX, e.clientY],
      grab: at ? [at[0] - left, at[1] - top] : [note.offsetWidth / 2, note.offsetHeight / 2],
      size: [note.offsetWidth, note.offsetHeight],
    });
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    if (!dragged.current && Math.hypot(e.clientX - drag.from[0], e.clientY - drag.from[1]) < DRAG_PX) return;
    dragged.current = true;
    const at = surface.pointOn(e);
    if (!at) return;
    setDrag({ ...drag, at, over: columnAt(at[0], spans()) });
  };
  const onUp = (task: BoardTask) => {
    const was = drag;
    setDrag(null);
    if (dragged.current && was?.over) void move(task, was.over);
  };

  return (
    <div className="sf-board" ref={root}>
      <header className="sf-board-head">
        <span className="sf-board-title">{heading}</span>
        <span className="sf-board-sum">
          {open} open ·{" "}
          <span className="sf-board-wip" title="Work in progress">
            {wip} in progress
          </span>{" "}
          · {shown.length - open} done
        </span>
      </header>
      {surface.focused && (people.length > 1 || projects.length > 1) && (
        <div className="sf-board-filter">
          {people.length > 1 && (
            <fieldset className="sf-filter-row" aria-label="Whose tasks">
              <button
                type="button"
                aria-pressed={!filter.who}
                className="sf-filter-chip"
                onClick={() => setFilter({ ...filter, who: undefined })}
              >
                Everyone
              </button>
              {people.slice(0, 10).map((p) => (
                <button
                  key={p.agent}
                  type="button"
                  aria-pressed={filter.who === p.agent}
                  className={`sf-filter-chip${p.over ? " is-over" : ""}`}
                  title={p.over ? `${p.doing} in progress: more than ${WIP_EACH} at once` : `${p.open} open`}
                  onClick={() => setFilter({ ...filter, who: filter.who === p.agent ? undefined : p.agent })}
                >
                  <Who agent={p.agent} />
                  <span className="sf-filter-n">{p.open}</span>
                </button>
              ))}
            </fieldset>
          )}
          {projects.length > 1 && (
            <label className="sf-filter-project">
              <span>Project</span>
              <select
                value={filter.project ?? ""}
                onChange={(e) => setFilter({ ...filter, project: e.target.value || undefined })}
              >
                <option value="">All</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {world?.projects[p.id] ?? p.id} ({p.n})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {/* From across a room: how many in each column, big, and a bar for each note (the CSS shows one or the other). */}
      <div className="sf-board-far" aria-hidden="true">
        {columns.map((col) => (
          <div key={col.id} className="sf-far-col" style={{ ["--note" as string]: col.color }}>
            <span className="sf-far-count">{col.notes.length + col.more}</span>
            <span className="sf-far-title">{col.title}</span>
            <span className="sf-far-bars">
              {col.notes.map((task) => (
                <span key={task.id} className="sf-far-bar" />
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="sf-board-cols">
        {columns.map((col) => (
          <section
            key={col.id}
            className={`sf-col${drag?.at && drag.over === col.id ? " is-over" : ""}`}
            data-column={col.id}
            style={{ ["--note" as string]: col.color }}
          >
            <button
              type="button"
              className="sf-col-head"
              title={`Every task under ${col.title}`}
              onClick={() => onUse?.("tasks", { column: col.id })}
            >
              <span className="sf-col-dot" aria-hidden="true" />
              <span className="sf-col-title">{col.title}</span>
              <span className="sf-col-count">{col.notes.length + col.more}</span>
            </button>
            <div className="sf-col-notes">
              {col.notes.map((task, i) => (
                <button
                  type="button"
                  key={task.id}
                  className={`sf-note${drag?.id === task.id && drag.at ? " is-lifted" : ""}`}
                  style={{ ["--tilt" as string]: `${((i % 3) - 1) * 0.6}deg` }}
                  title={task.title}
                  aria-label={`${task.title}${task.assignee ? `, ${nameOf(task.assignee)}` : ""}. Shift and the arrows move it.`}
                  onPointerDown={(e) => onDown(e, task)}
                  onPointerMove={onMove}
                  onPointerUp={() => onUp(task)}
                  onPointerCancel={() => setDrag(null)}
                  onClick={() => {
                    if (dragged.current) {
                      dragged.current = false;
                      return;
                    }
                    onUse?.("tasks", { task: task.id });
                  }}
                  onKeyDown={(e) => {
                    if (!e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                    e.preventDefault();
                    const at = GROUPS.findIndex((g) => g.id === col.id) + (e.key === "ArrowLeft" ? -1 : 1);
                    const to = GROUPS[at];
                    if (to) void move(task, to.id);
                  }}
                >
                  <span className="sf-note-title">{task.title}</span>
                  {task.assignee && <Who agent={task.assignee} />}
                </button>
              ))}
              {!col.notes.length && <span className="sf-col-empty">Nothing here</span>}
              {/* Only ever seen from where it can't be pressed: brought up, every note shows. */}
              {col.more > 0 && <span className="sf-col-more">+{col.more} more</span>}
            </div>
          </section>
        ))}
      </div>
      {drag?.at && (
        <div
          className="sf-note sf-note-ghost"
          aria-hidden="true"
          style={{
            left: drag.at[0] - drag.grab[0],
            top: drag.at[1] - drag.grab[1],
            width: drag.size[0],
            height: drag.size[1],
            ["--note" as string]: GROUPS.find((g) => g.id === drag.over)?.color,
          }}
        >
          <span className="sf-note-title">{tasks.find((t) => t.id === drag.id)?.title}</span>
        </div>
      )}
      {surface.focused && (
        <footer className="sf-foot" role={problem ? "alert" : undefined}>
          {problem ?? "Drag a note to another column, or Shift + ← → · Esc to step back"}
        </footer>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// The screen
// --------------------------------------------------------------------------

/** The time, to the minute: what the clock in a screen's corner says. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The page a screen of `count` pages is on: the one the clock says, as every
 * screen and the picture drawn of it say, turning over each quarter minute;
 * or, while it is being read, the one picked, which holds still.
 */
function usePage(count: number, focused: boolean): { page: number; pick: (page: number) => void; left: number } {
  const [now, setNow] = useState(() => Date.now());
  const [held, setHeld] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each turn of the page is what schedules the next.
  useEffect(() => {
    if (count < 2) return;
    // Up again when the clock comes round to the next page.
    const timer = setTimeout(() => setNow(Date.now()), PAGE_MS - (Date.now() % PAGE_MS) + 20);
    return () => clearTimeout(timer);
  }, [now, count]);
  const auto = pageAt(now, count);
  // Brought up, it holds the page it was on; put down, it goes back to the clock's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only being brought up or put down says which page to hold.
  useEffect(() => {
    setHeld(focused ? pageAt(Date.now(), count) : null);
  }, [focused]);
  const page = focused && held !== null && held < count ? held : auto;
  return {
    page,
    pick: (p) => setHeld(((p % count) + count) % count),
    left: PAGE_MS - (now % PAGE_MS),
  };
}

/** Pixels a finger has to move sideways across a screen being read to turn its page. */
const SWIPE_PX = 36;

/**
 * A screen: outside a home, the dashboard's first few widgets, each drawn by
 * the Board page's own renderer; in a home, what its owner is up to. A page
 * at a time, turning over as the clock says, with a dot for each; read close
 * up, it holds still, and the dots, the arrow buttons by them, the arrow keys
 * or a swipe turn it. A task in a widget opens its card; the page's title
 * opens the whole dashboard there. Every widget stays drawn while the screen
 * is live, the pages not up hidden, so a page turning shows what its widget
 * had already, rather than starting again from nothing.
 */
function ScreenFace({ pin }: { pin?: string }) {
  const { cards = [], widgets, onUse } = useContext(Faces);
  const surface = useContext(SurfaceContext);
  // Kept to one widget (its `shows`), that one alone, wherever it hangs; otherwise the first few in turn.
  const pinned = pin ? pinnedWidget(widgets ?? [], pin) : undefined;
  const pages = pinned ? [pinned] : widgets && !pin ? screenWidgets(widgets) : [];
  const count = pinned ? 1 : pin ? 0 : pages.length || cards.length;
  const { page, pick, left } = usePage(count, surface.focused);
  const now = useMinuteNow();
  const widget = pages[page];
  const card = pages.length || pin ? undefined : cards[page];
  const title = widget ? (widget.title ?? widget.id) : card?.title;
  const id = widget?.id ?? card?.id;
  // Links to tasks stay in the world, as on the dashboard panel: a task's card, or the list.
  const onLink = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.("a");
    const to = a ? taskLink(a.getAttribute("href") ?? "") : undefined;
    if (!to) return;
    e.preventDefault();
    onUse?.("tasks", "task" in to ? { task: to.task } : undefined);
  };
  // A swipe across the page, read close up on a phone (a finger has no arrow keys): from where it went down.
  const swipe = useRef<[number, number] | null>(null);
  const onSwipeDown = (e: PointerEvent<HTMLDivElement>) => {
    swipe.current = surface.focused && count > 1 && e.pointerType !== "mouse" ? [e.clientX, e.clientY] : null;
  };
  const onSwipeUp = (e: PointerEvent<HTMLDivElement>) => {
    const from = swipe.current;
    swipe.current = null;
    if (!from) return;
    const dx = e.clientX - from[0];
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - from[1])) pick(page + (dx < 0 ? 1 : -1));
  };
  // Read close up, the arrows turn the page from wherever the keyboard is on the screen: the screen itself, as it
  // is when brought up, its dots or its links.
  useEffect(() => {
    if (!surface.focused || count < 2) return;
    const turn = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || !surface.el?.contains(e.target as Node)) return;
      e.preventDefault();
      pick(page + (e.key === "ArrowLeft" ? -1 : 1));
    };
    window.addEventListener("keydown", turn);
    return () => window.removeEventListener("keydown", turn);
  }, [surface.focused, surface.el, count, page, pick]);
  if (pin && !pinned)
    return (
      <div className="sf-screen">
        <header className="sf-screen-head">
          <span className="sf-screen-title">{pin}</span>
        </header>
        <p className="sf-empty">{widgets ? "There's no widget by that name on the Board." : "Loading…"}</p>
      </div>
    );
  return (
    <div className="sf-screen">
      <header className="sf-screen-head">
        {title ? (
          <button
            type="button"
            className="sf-screen-title"
            title="Open it on the dashboard"
            onClick={() => id && onUse?.("screen", { card: id })}
          >
            {title}
          </button>
        ) : (
          <span className="sf-screen-title" />
        )}
        {widget?.type !== "clock" && !card?.clock && <span className="sf-screen-clock">{clockTime(now)}</span>}
      </header>
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: it only catches clicks on the links inside, which take keys themselves, and swipes, which the arrows and dots do too. */}
      <div
        className="sf-screen-body"
        onClick={onLink}
        onPointerDown={onSwipeDown}
        onPointerUp={onSwipeUp}
        onPointerCancel={() => {
          swipe.current = null;
        }}
      >
        {pages.length
          ? pages.map((w, i) => (
              <div key={w.id} className="sf-screen-page" hidden={i !== page}>
                <WidgetPage widget={w} seconds={surface.focused && i === page} />
              </div>
            ))
          : card && (
              <div key={card.id} className="sf-screen-page">
                <CardPage card={card} />
              </div>
            )}
      </div>
      {count > 1 && (
        <footer className="sf-screen-foot">
          {surface.focused && (
            <button type="button" className="sf-turn-by" aria-label="Page before" onClick={() => pick(page - 1)}>
              ‹
            </button>
          )}
          <span className="sf-dots" role="tablist" aria-label="Pages">
            {Array.from({ length: count }, (_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === page}
                aria-label={`Page ${i + 1} of ${count}`}
                className="sf-dot"
                onClick={() => pick(i)}
              />
            ))}
          </span>
          {surface.focused && (
            <button type="button" className="sf-turn-by" aria-label="Page after" onClick={() => pick(page + 1)}>
              ›
            </button>
          )}
          {!surface.focused && (
            <span
              className="sf-turn"
              key={`${page}:${count}`}
              style={{ animationDuration: `${PAGE_MS}ms`, animationDelay: `${left - PAGE_MS}ms` }}
            />
          )}
        </footer>
      )}
    </div>
  );
}

/** The Board's widget a screen is kept to: by its id, or failing that its title, whatever the case. */
export function pinnedWidget(widgets: DashboardWidgetSpec[], pin: string): DashboardWidgetSpec | undefined {
  const want = pin.trim().toLowerCase();
  return (
    widgets.find((w) => w.id.toLowerCase() === want) ??
    widgets.find((w) => (w.title ?? "").trim().toLowerCase() === want)
  );
}

/**
 * A dashboard widget on a screen, by the Board page's own renderer. A clock
 * on it keeps the minute, and the seconds only on the page up while the
 * screen is brought up close (`seconds`): each tick draws the screen again.
 */
function WidgetPage({ widget, seconds }: { widget: DashboardWidgetSpec; seconds: boolean }) {
  const Renderer = widgetRenderers[widget.type];
  return (
    <div className="sf-widget" data-widget-type={widget.type}>
      {Renderer ? (
        <Renderer widget={widget} seconds={seconds} />
      ) : (
        <p className="widget-empty">This one is on the Board.</p>
      )}
    </div>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  ok: "is-ok",
  warn: "is-warn",
  bad: "is-bad",
  info: "is-info",
  dim: "is-dim",
};

/** A page about an agent, in a home: a big word for what it is doing, rows of tasks or what is coming, or lines. */
function CardPage({ card }: { card: ScreenCard }) {
  const now = useMinuteNow();
  if (card.clock)
    return (
      <div className="sf-card-clock">
        <span className="sf-big">{clockTime(now)}</span>
        <span className="sf-sub">
          {new Date(now).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
        </span>
      </div>
    );
  return (
    <div className="sf-card">
      {card.big && (
        <div className={`sf-big ${card.big.tone ? TONE_CLASS[card.big.tone] : ""}`}>
          {card.big.text}
          {card.big.sub && <span className="sf-sub">{card.big.sub}</span>}
        </div>
      )}
      {card.lines?.map((line, i) => (
        <p key={i} className="sf-line">
          {line}
        </p>
      ))}
      {!!card.rows?.length && (
        <ul className="sf-rows">
          {card.rows.map((row, i) => (
            <li key={i} className="sf-row">
              {row.tag && <span className={`sf-tag ${TONE_CLASS[row.tag.tone]}`}>{row.tag.text}</span>}
              <span className="sf-row-text">{row.text}</span>
              {row.meta && <span className="sf-row-meta">{row.meta}</span>}
            </li>
          ))}
        </ul>
      )}
      {!card.big && !card.lines?.length && !card.rows?.length && card.empty && <p className="sf-empty">{card.empty}</p>}
    </div>
  );
}

// --------------------------------------------------------------------------
// The calendar
// --------------------------------------------------------------------------

/** Wakes a calendar lists before saying how many more, while it isn't being read: fewer and bigger in a home. */
const WAKES_SHOWN = { names: 5, own: 4 };
/** Lines of what got done today at a calendar's foot, while it isn't being read. */
const DONE_SHOWN = 2;

/** The time of a wake as the page's clock says it. */
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * A paper calendar: today's date on a coloured band, whose it is, each day's
 * wakes (the time, a dot for the kind, whose in the lobby, what), and what
 * got done today. A wake opens that agent's list of wakes; something done
 * that was a task opens its card; the band, the whole list.
 */
function CalendarFace() {
  const { calendar: view, onUse } = useContext(Faces);
  const surface = useContext(SurfaceContext);
  const now = view?.now ?? Date.now();
  const today = new Date(now);
  const limit = surface.focused ? Number.POSITIVE_INFINITY : view?.names ? WAKES_SHOWN.names : WAKES_SHOWN.own;
  let left = limit;
  const days = view ? byDay(view.wakes, view.now) : [];
  const shownDays = days.flatMap((day) => {
    if (left <= 0) return [];
    const wakes = day.wakes.slice(0, left);
    left -= wakes.length;
    return [{ ...day, wakes }];
  });
  const more = surface.focused ? 0 : (view?.wakes.length ?? 0) - (limit - Math.max(0, left));
  const next = view?.wakes[0];
  const done = view ? view.done.slice(0, surface.focused ? undefined : DONE_SHOWN) : [];
  const wake = (w: Wake) => (
    <button
      type="button"
      key={w.key}
      className={`sf-cal-wake is-${w.kind}`}
      title={w.detail ?? w.what}
      onClick={() => onUse?.("calendar", { agent: w.agent })}
    >
      <span className="sf-cal-time">{clock(w.at)}</span>
      <span className="sf-cal-kind" aria-hidden="true" />
      <span className="sf-cal-text">
        {view?.names && <Who agent={w.agent} />}
        <span className="sf-cal-what">{w.what}</span>
        {w.every && <span className="sf-cal-every">{w.every}</span>}
      </span>
    </button>
  );
  const finished = (d: Done) => (
    <button
      type="button"
      key={d.key}
      className="sf-cal-wake"
      disabled={!d.task}
      onClick={() => d.task && onUse?.("tasks", { task: d.task })}
    >
      <span className="sf-cal-check" aria-hidden="true">
        ✓
      </span>
      <span className="sf-cal-text">
        {view?.names && <Who agent={d.agent} />}
        <span className="sf-cal-what">{d.what}</span>
      </span>
    </button>
  );
  return (
    <div className={view?.names ? "sf-calendar has-names" : "sf-calendar"}>
      <button type="button" className="sf-cal-band" title="Every wake" onClick={() => onUse?.("calendar")}>
        <span className="sf-cal-day">{today.getDate()}</span>
        <span className="sf-cal-date">
          <span className="sf-cal-weekday">{today.toLocaleDateString([], { weekday: "long" })}</span>
          <span className="sf-cal-month">{today.toLocaleDateString([], { month: "long", year: "numeric" })}</span>
        </span>
      </button>
      {/* From across a room: the next wake, big (the CSS shows this or the list). */}
      {view && (
        <div className="sf-cal-far" aria-hidden="true">
          {next ? (
            <>
              <span className="sf-cal-far-when">
                Next · {days[0]?.label}
                {view.wakes.length > 1 ? ` · ${view.wakes.length - 1} more` : ""}
              </span>
              <span className="sf-cal-far-time">{clock(next.at)}</span>
              {view.names && <span className="sf-cal-far-who">{nameOf(next.agent)}</span>}
              <span className="sf-cal-far-what">{next.what}</span>
            </>
          ) : (
            <span className="sf-cal-far-none">Nothing booked</span>
          )}
          {view.note && <span className="sf-cal-far-note">{view.note}</span>}
        </div>
      )}
      {view && surface.focused && <CalendarRead view={view} wake={wake} finished={finished} />}
      {view && !surface.focused && (
        <div className="sf-cal-body">
          <p className="sf-cal-title">{view.title}</p>
          {view.note && <p className="sf-cal-note">{view.note}</p>}
          {shownDays.map((day) => (
            <section key={day.start} className="sf-cal-dayblock">
              <h4 className="sf-cal-head">{day.label}</h4>
              {day.wakes.map(wake)}
            </section>
          ))}
          {!days.length && <p className="sf-cal-empty">Nothing booked</p>}
          {/* Only ever seen from where it can't be pressed: brought up, every wake shows. */}
          {more > 0 && <span className="sf-cal-more">+{more} more</span>}
          {done.length > 0 && (
            <section className="sf-cal-dayblock sf-cal-done">
              <h4 className="sf-cal-head">Done today</h4>
              {done.map(finished)}
            </section>
          )}
        </div>
      )}
      {surface.focused && <footer className="sf-foot">Click a wake for that agent's list · Esc to step back</footer>}
    </div>
  );
}

const MODES: { id: CalendarMode; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

/** The day the week starts on where the page is read: Monday unless the browser says otherwise. */
function firstDayOfWeek(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    return typeof first === "number" ? first % 7 : 1;
  } catch {
    return 1;
  }
}

/**
 * A calendar read close up: its day, its week from today, or its month, picked
 * by the tabs under its band. A day lists its wakes by the hour and what got
 * done; the week, a column a day; the month, a square a day with how many
 * wakes and how much got done, a square opening its day. A wake that comes
 * round once a day at one time shows on each day it comes round on; one
 * that repeats some other way shows at its next time, saying how often, and
 * the days without anything say nothing else is booked rather than nothing.
 */
function CalendarRead({
  view,
  wake,
  finished,
}: {
  view: CalendarView;
  wake: (w: Wake) => ReactNode;
  finished: (d: Done) => ReactNode;
}) {
  const { onUse } = useContext(Faces);
  const [mode, setMode] = useState<CalendarMode>("day");
  const [day, setDay] = useState<number | null>(null);
  const done = useMemo(() => {
    const seen = new Set(view.done.map((d) => d.key));
    return [...view.done, ...(view.history ?? []).filter((d) => !seen.has(d.key))];
  }, [view.done, view.history]);
  const days = calendarDays(mode, day ?? view.now, firstDayOfWeek());
  const until = days.at(-1)?.start;
  const wakes = useMemo(
    () => (until === undefined ? view.wakes : withRepeats(view.wakes, until + 36 * 3_600_000)),
    [view.wakes, until],
  );
  // A repeat that couldn't be put on each day it comes round on may come round on any of them.
  const unsure = wakes.some((w) => w.every && !repeatDays(w.every));
  const none = unsure ? "Nothing else booked" : "Nothing booked";
  const dayLabel = (start: number, long = false) =>
    new Date(start).toLocaleDateString(
      [],
      long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric" },
    );
  return (
    <div className={`sf-cal-read is-${mode}`}>
      <div className="sf-cal-modes" role="tablist" aria-label="How much of the calendar">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            className="sf-cal-mode"
            onClick={() => {
              setMode(m.id);
              if (m.id !== "day") setDay(null);
            }}
          >
            {m.label}
          </button>
        ))}
        <span className="sf-cal-read-title">{view.title}</span>
      </div>
      {view.note && <p className="sf-cal-note">{view.note}</p>}
      {mode === "day" &&
        (() => {
          const start = days[0]?.start ?? view.now;
          const on = onDay(start, wakes, done);
          return (
            <div className="sf-cal-day-view">
              <h4 className="sf-cal-head">{dayLabel(start, true)}</h4>
              {on.wakes.map(wake)}
              {!on.wakes.length && (
                <p className="sf-cal-empty">{unsure ? "No other wakes booked" : "No wakes booked"}</p>
              )}
              {on.done.length > 0 && <h4 className="sf-cal-head">Done</h4>}
              {on.done.map(finished)}
            </div>
          );
        })()}
      {mode === "week" && (
        <div className="sf-cal-week">
          {days.map((d) => {
            const on = onDay(d.start, wakes, done);
            return (
              <section key={d.start} className={`sf-cal-col${d.today ? " is-today" : ""}`}>
                <button
                  type="button"
                  className="sf-cal-col-head"
                  onClick={() => {
                    setDay(d.start);
                    setMode("day");
                  }}
                >
                  {d.today ? "Today" : dayLabel(d.start)}
                </button>
                <div className="sf-cal-col-items">
                  {on.wakes.map((w) => (
                    <button
                      type="button"
                      key={w.key}
                      className={`sf-cal-chip is-${w.kind}`}
                      title={`${clock(w.at)} ${w.what}${w.every ? ` · ${w.every}` : ""}`}
                      onClick={() => onUse?.("calendar", { agent: w.agent })}
                    >
                      <span className="sf-cal-chip-time">{clock(w.at)}</span>
                      <span className="sf-cal-chip-what">
                        {view.names ? `${nameOf(w.agent)} · ${w.what}` : w.what}
                        {w.every ? " ↻" : ""}
                      </span>
                    </button>
                  ))}
                  {on.done.length > 0 && <span className="sf-cal-chip is-done">✓ {on.done.length} done</span>}
                  {!on.wakes.length && !on.done.length && <span className="sf-cal-col-none">{none}</span>}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {mode === "month" && (
        <div className="sf-cal-month-grid">
          {days.slice(0, 7).map((d) => (
            <span key={`h${d.start}`} className="sf-cal-wday">
              {new Date(d.start).toLocaleDateString([], { weekday: "narrow" })}
            </span>
          ))}
          {days.map((d) => {
            const on = onDay(d.start, wakes, done);
            return (
              <button
                type="button"
                key={d.start}
                className={`sf-cal-cell${d.today ? " is-today" : ""}${d.inMonth ? "" : " is-out"}`}
                onClick={() => {
                  setDay(d.start);
                  setMode("day");
                }}
                aria-label={`${dayLabel(d.start, true)}: ${on.wakes.length} wakes, ${on.done.length} done`}
              >
                <span className="sf-cal-cell-day">{new Date(d.start).getDate()}</span>
                {on.wakes.length > 0 && <span className="sf-cal-cell-n is-wake">{on.wakes.length}</span>}
                {on.done.length > 0 && <span className="sf-cal-cell-n is-done">✓{on.done.length}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// A kiosk
// --------------------------------------------------------------------------

/** What a kiosk's button says under its label, for the kiosks the lobby has. */
const KIOSK_WORDS: Record<string, string> = {
  "new-agent": "Ask for one",
  "new-task": "Write one down",
  "new-room": "Start a conversation",
  tasks: "See them all",
};

/** A kiosk's face: one big button, pressed there and then. */
function KioskFace({ label, action }: { label: string; action?: string }): ReactNode {
  const { onUse } = useContext(Faces);
  return (
    <button type="button" className="sf-kiosk-button" onClick={() => action && onUse?.(action)}>
      <span className="sf-kiosk-plus" aria-hidden="true">
        +
      </span>
      <span className="sf-kiosk-label">{label}</span>
      {action && KIOSK_WORDS[action] && <span className="sf-kiosk-sub">{KIOSK_WORDS[action]}</span>}
    </button>
  );
}
