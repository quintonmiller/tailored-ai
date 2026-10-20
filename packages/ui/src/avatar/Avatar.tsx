import { type CSSProperties, type MutableRefObject, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardWidgetSpec } from "../api";
import type { Need } from "../lib/needs";
import { type Anchor, SHEET_BELOW } from "./anchors";
import type { BoardTask } from "./boards";
import type { BodyLooks, EmoteRecord } from "./body";
import type { CalendarView } from "./calendar";
import type { Cue } from "./cues";
import { type AgentActivity, DOING_VARS } from "./doing";
import { doorWords } from "./doors";
import { type FaceData, SurfacePortals, type SurfaceStage, type TaskMove } from "./Faces";
import type { BodyState } from "./motion";
import { lightsFor, type Room, type RoomDoor } from "./scene";
import type { ScreenCard } from "./screens";
import type { Companion, Line, PanelOptions, Stage, StageEdit, StageView, SurfaceView, Travel, UseSpot } from "./stage";
import { faceOf, glanceFor, type WorldData } from "./widgets";

const VIEW_KEY = "tai.talk.avatarView";
/** Pixels a door's label may need to the right of the pointer: nearer the edge of what can be seen, it goes left. */
const DOOR_TIP_ROOM = 240;
/**
 * What is laid over the stage, from the stage's parent: the view toggle, and
 * each of the tools over the top. Each tool by itself, not the row they wrap
 * in, whose box runs on past them as wide as all of them end to end.
 */
export const OVERLAYS = ":scope > .talk-view, :scope > .talk-back, :scope > .talk-tools > :not(.talk-tools-break)";
/** What else is laid over the stage that panels in the world keep clear of, though the camera frames past it. */
export const HINTS = ":scope > .talk-keys";

/** One thing the menu on an agent's body offers. */
export interface AgentAction {
  label: string;
  run: () => void | Promise<void>;
}

/** What the page can tell the avatar to do once it is on screen. */
export interface AvatarControls {
  cue(cue: Cue): void;
  /** An agent's body going by in the town, from one door to another (see `Stage.walkBy`). */
  walkBy(walker: Companion & { from: [number, number]; to: [number, number] }): void;
  /** Where you are on the floor (see `Stage.where`). */
  where(): [number, number];
}

/** A panel the page keeps in the world, beside what it is about (see `anchors.ts`). */
export interface WorldPanelSpec extends PanelOptions {
  /** The same while it is the same panel: what is in it can change, and it stays where it is. */
  id: string;
  /** What it is: an agent's card, the map, your conversation; for its size and anyone inspecting the page. */
  kind: string;
  anchor: Anchor;
  node: ReactNode;
  /** How it looks: a card by a body, pinned beside a thing, on the plaque, held, docked, a conversation, a phone. */
  look: string;
  /** The colour it is edged in, as CSS: an agent's card and your talk with it wear the colour of the agent's body. */
  color?: string;
}

function savedView(): StageView {
  try {
    return localStorage.getItem(VIEW_KEY) === "close" ? "close" : "room";
  } catch {
    return "room";
  }
}

/**
 * The agent's body on the Talk page, in a small room: it breathes, leans in
 * while you talk, looks away while it thinks, and moves its mouth with its
 * voice. Between sessions it wanders the room; click furniture to send it
 * there. Drag to look around, or switch to a close-up. The 3D code
 * loads only when this renders, so a page without an avatar never downloads
 * it.
 */
export function Avatar({
  url,
  animations = [],
  state,
  loudness,
  engaged,
  controls,
  fill = false,
  insetRight = 0,
  insetTop = 0,
  insetBottom = 0,
  chooseIdle,
  room,
  company,
  still,
  onReady,
  onProblem,
  view: fixedView,
  agent,
  activities,
  speech,
  menuFor,
  visitor = false,
  onNear,
  tools,
  overlay,
  tasks,
  screen,
  widgets,
  calendar,
  world,
  onApprove,
  onUse,
  onTaskMove,
  onLine,
  place,
  arriveFrom,
  onDoor,
  greet,
  onGreeted,
  onBody,
  wear,
  looks,
  emotes,
  edit,
  panels,
  panelRoom = 0,
  plaque,
  onShown,
  onSheets,
}: {
  url: string;
  /** Animation libraries for the avatar; it moves by code until they load. */
  animations?: string[];
  state: BodyState;
  loudness: () => number;
  /** A session is under way: the avatar stays put and faces you instead of wandering. */
  engaged: boolean;
  /** Filled in once the avatar is on screen, so the page can pass on the agent's cues. */
  controls?: MutableRefObject<AvatarControls | null>;
  /** Fill the container instead of sitting in a box on the page: the scene behind a chat. */
  fill?: boolean;
  /** Pixels of the right side covered by something laid over the scene; the camera frames what is left. */
  insetRight?: number;
  /** The same for the top (a toolbar) and the bottom (a phone's chat). */
  insetTop?: number;
  insetBottom?: number;
  /** Ask the agent what it does with a quiet moment; without it, the avatar wanders at random. */
  chooseIdle?: (here: string | undefined, hour: number) => Promise<Cue[]>;
  /** The room it lives in; a new one is shown as it changes, without rebuilding the stage. */
  room?: Room;
  /** Others in the room, each with a body of their own. */
  company?: Companion[];
  /** Hold still for a photo, at a spot, striking a gesture; the view toggle is hidden. */
  still?: { spot?: string; gesture?: string };
  /** A still avatar is ready to photograph. */
  onReady?: () => void;
  /** It couldn't be shown, and why. */
  onProblem?: (reason: string) => void;
  /** Show this view and offer no toggle, instead of the one the person last chose. */
  view?: StageView;
  /** The agent whose body this is: its colour, and which activity is its own. */
  agent?: string;
  /** What each agent is doing, by agent; every body in the room shows its own. */
  activities?: Record<string, AgentActivity>;
  /** The last thing each agent said, by agent; a new line shows in a bubble. */
  speech?: Record<string, Line>;
  /** What clicking an agent's body offers; without it, bodies aren't clickable. */
  menuFor?: (agent: string) => AgentAction[];
  /** The body is the visitor's own: walked with the keys, or put away to fly. */
  visitor?: boolean;
  /** The agent a visitor is standing next to, as it changes. */
  onNear?: (agent: string | undefined) => void;
  /** Controls laid over the top left of the stage. */
  tools?: ReactNode;
  /** Something laid over the whole stage, like a map. */
  overlay?: ReactNode;
  /** What the task boards on the walls show. */
  tasks?: BoardTask[];
  /** The pages the screens on the walls go through. */
  screen?: ScreenCard[];
  /** The dashboard's widgets, for a screen outside a home to draw live with the Board page's renderers. */
  widgets?: DashboardWidgetSpec[];
  /** What the calendars on the walls show. */
  calendar?: CalendarView;
  /** What the widgets show (`widgets.ts`): what agents are doing, the feed, the charts' numbers, the photos. */
  world?: WorldData;
  /** Approve or deny what an agent waits on, from a needs-you board on a wall. */
  onApprove?: (need: Need, approved: boolean) => Promise<unknown>;
  /**
   * A kiosk, a board, a screen or a calendar was clicked: what it does, and
   * on a board the note or column clicked, on a screen the page that was up.
   */
  onUse?: (action: string, on?: UseSpot, thing?: string) => void;
  /** A note was dragged to another column on a task board: save the change. */
  onTaskMove?: (id: string, change: TaskMove) => Promise<unknown>;
  /** A visitor is near an agent as it starts saying something, nearness 0–1; `phone`, heard down the line. */
  onLine?: (agent: string, text: string, nearness: number, phone?: boolean) => void;
  /**
   * Which place `room` is, by id. A new one on the same stage is a place come
   * into through a door: you stand just inside the door back to the last one.
   */
  place?: string;
  /** The place come from through a door, for a stage made on the way in: you start just inside that door. */
  arriveFrom?: string;
  /** A door was gone through: bring the place behind it. */
  onDoor?: (door: RoomDoor) => void;
  /**
   * An agent to stand in front of, once in its place: going straight to it
   * from a list. A new `n` is a new ask, for the same agent too.
   */
  greet?: { agent: string; place: string; n: number } | null;
  /** The ask numbered `n` was carried out: the page is done with it, so a stage made later doesn't do it again. */
  onGreeted?: (n: number) => void;
  /** A click on a body that the page deals with itself, instead of opening the menu: true when it did. */
  onBody?: (agent: string) => boolean;
  /** What the body wears, by name (see `wear.ts`). */
  wear?: string[];
  /**
   * How the body chose to look and carry itself (see `body.ts`): another
   * model, colour or size makes it again where it stands, without building
   * the stage again.
   */
  looks?: BodyLooks;
  /** The gesture each agent is making, by agent: each plays on its body when it is here. */
  emotes?: Record<string, EmoteRecord>;
  /** Rearranging the room: what is picked, where it is going, and what the page hears; none while you aren't. */
  edit?: StageEdit;
  /** Panels kept in the world beside what they are about: cards, the map, your conversation. */
  panels?: WorldPanelSpec[];
  /** Pixels kept on the right for those panels, on top of `insetRight`: the scene is framed in what is left. */
  panelRoom?: number;
  /** The words on the room's plaque by its door, whose click opens the room's card; none, no plaque. */
  plaque?: string;
  /** The stage is on screen, with whatever is kept beside things in it; or it was taken down to be built again. */
  onShown?: (shown: boolean) => void;
  /** Whether the stage is too narrow for panels beside anything (`SHEET_BELOW`): they are sheets along its foot. */
  onSheets?: (sheets: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // The stage reads these every frame; a ref keeps that from re-rendering React.
  const live = useRef({ state, loudness, engaged });
  live.current = { state, loudness, engaged };
  const stage = useRef<Stage | null>(null);
  const [view, setView] = useState<StageView>(() => fixedView ?? savedView());
  const viewRef = useRef(view);
  viewRef.current = view;
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const chooseRef = useRef(chooseIdle);
  chooseRef.current = chooseIdle;
  const choosing = !!chooseIdle;
  // The panels' strip beside the chat's column, which the stage takes from the scene when a panel needs it.
  const insets = { right: insetRight, top: insetTop, bottom: insetBottom, panels: panelRoom };
  const insetRef = useRef(insets);
  insetRef.current = insets;
  useEffect(() => {
    stage.current?.setInsets({ right: insetRight, top: insetTop, bottom: insetBottom, panels: panelRoom });
  }, [insetRight, insetTop, insetBottom, panelRoom]);
  // Whether panels are sheets, by the same measure the stage lays them out by: the stage's own width.
  const sheetsRef = useRef(onSheets);
  sheetsRef.current = onSheets;
  const shownRef = useRef(onShown);
  shownRef.current = onShown;
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let was: boolean | undefined;
    const check = () => {
      const now = el.clientWidth > 0 && el.clientWidth < SHEET_BELOW;
      if (now !== was) sheetsRef.current?.(now);
      was = now;
    };
    const watch = new ResizeObserver(check);
    watch.observe(el);
    check();
    return () => watch.disconnect();
  }, []);
  // The stage once it is on screen, for the panels kept beside things in it, which need it to be placed.
  const [shown, setShown] = useState<Stage | null>(null);
  // Told only once there is a plaque, or was: a photo's stage, which never has one, is left alone.
  const plaqued = useRef(false);
  useEffect(() => {
    if (!shown || (!plaque && !plaqued.current)) return;
    plaqued.current = !!plaque;
    shown.setPlaque(plaque);
  }, [shown, plaque]);
  const stillRef = useRef({ still, onReady, onProblem });
  stillRef.current = { still, onReady, onProblem };
  const companyRef = useRef(company);
  companyRef.current = company;
  const companyKey = JSON.stringify(company ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key says when the company changed; the ref holds it.
  useEffect(() => {
    stage.current?.setCompany(companyRef.current ?? []);
  }, [companyKey]);
  const wearRef = useRef(wear);
  wearRef.current = wear;
  const wearKey = (wear ?? []).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key says when what it wears changed; the ref holds it.
  useEffect(() => {
    stage.current?.setWear(wearRef.current ?? []);
  }, [wearKey]);
  const looksRef = useRef(looks);
  looksRef.current = looks;
  const looksKey = JSON.stringify(looks ?? {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key says when the looks changed; the ref holds them.
  useEffect(() => {
    stage.current?.setLooks(looksRef.current ?? {});
  }, [looksKey]);
  const emotesRef = useRef(emotes);
  emotesRef.current = emotes;
  useEffect(() => {
    if (emotes) stage.current?.setEmotes(emotes);
  }, [emotes]);
  const activitiesRef = useRef(activities);
  activitiesRef.current = activities;
  useEffect(() => {
    if (activities) stage.current?.setActivities(activities);
  }, [activities]);
  const speechRef = useRef(speech);
  speechRef.current = speech;
  useEffect(() => {
    if (speech) stage.current?.setSpeech(speech);
  }, [speech]);
  const menuRef = useRef(menuFor);
  menuRef.current = menuFor;
  const picking = !!menuFor;
  const [picked, setPicked] = useState<{ agent: string; x: number; y: number } | null>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(() => {
    if (tasks) stage.current?.setTasks(tasks);
  }, [tasks]);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    if (screen) stage.current?.setScreen(screen);
  }, [screen]);
  const calendarRef = useRef(calendar);
  calendarRef.current = calendar;
  useEffect(() => {
    if (calendar) stage.current?.setCalendar(calendar);
  }, [calendar]);
  // What each widget shows from across a room, worked out again as what it shows or the room changes.
  const glances = useMemo(() => {
    const out: Record<string, ScreenCard> = {};
    if (!world || !room) return out;
    for (const p of room.props) {
      const choice = faceOf(p);
      const glance = choice && glanceFor(choice, world);
      if (glance) out[p.id] = glance;
    }
    return out;
  }, [world, room]);
  const glancesRef = useRef(glances);
  glancesRef.current = glances;
  useEffect(() => {
    if (world) stage.current?.setGlances(glances);
  }, [glances, world]);
  const placeRef = useRef(place);
  placeRef.current = place;
  const onUseRef = useRef(onUse);
  onUseRef.current = onUse;
  const moveRef = useRef(onTaskMove);
  moveRef.current = onTaskMove;
  const approveRef = useRef(onApprove);
  approveRef.current = onApprove;
  // The surfaces live now, which the faces are drawn into, and the one being read close up.
  const [surfaces, setSurfaces] = useState<SurfaceView[]>([]);
  const [reading, setReading] = useState<string | undefined>(undefined);
  const surfaceStage = useMemo(
    (): SurfaceStage => ({
      surfaceReady: (id) => stage.current?.surfaceReady(id),
      focusSurface: (id) => stage.current?.focusSurface(id),
      surfacePoint: (id, at) => stage.current?.surfacePoint(id, at),
    }),
    [],
  );
  const faces = useMemo(
    (): FaceData => ({
      tasks: tasks ?? [],
      ...(screen ? { cards: screen } : {}),
      ...(widgets ? { widgets } : {}),
      ...(calendar ? { calendar } : {}),
      ...(world ? { world } : {}),
      onUse: (action, on, thing) => onUseRef.current?.(action, on, thing),
      ...(onTaskMove
        ? { onTaskMove: (id: string, change: TaskMove) => moveRef.current?.(id, change) ?? Promise.resolve() }
        : {}),
      ...(onApprove
        ? {
            onApprove: (need: Need, approved: boolean) => approveRef.current?.(need, approved) ?? Promise.resolve(),
          }
        : {}),
    }),
    [tasks, screen, widgets, calendar, world, onTaskMove, onApprove],
  );
  const lineRef = useRef(onLine);
  lineRef.current = onLine;
  const nearRef = useRef(onNear);
  nearRef.current = onNear;
  const [travel, setTravel] = useState<Travel>("walk");
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const roomRef = useRef(room);
  roomRef.current = room;
  const doorRef = useRef(onDoor);
  doorRef.current = onDoor;
  // Doors only open where the page can bring what is behind them.
  const doors = !!onDoor;
  const arriveRef = useRef(arriveFrom);
  arriveRef.current = arriveFrom;
  const bodyRef = useRef(onBody);
  bodyRef.current = onBody;
  const greetRef = useRef(greet);
  greetRef.current = greet;
  const greetedRef = useRef(onGreeted);
  greetedRef.current = onGreeted;
  // The last ask to stand by someone that was carried out, until the page hears it was: once is enough.
  const greeted = useRef<number | undefined>(undefined);
  /** Stand in front of the agent asked for, when the stage is in its place and hasn't done so for this ask. */
  const greetIn = (s: Stage, at: string | undefined) => {
    const g = greetRef.current;
    if (!g || g.place !== at || greeted.current === g.n) return;
    greeted.current = g.n;
    s.standBefore(g.agent);
    greetedRef.current?.(g.n);
  };
  // The place the stage shows. A different one arriving is a place come into: on a visit, through a door or by the
  // map; otherwise, the agent gone somewhere else. For the first room to arrive, and any change to the same place,
  // it is the same stage's room changing.
  const shownPlace = useRef(place);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the room and its place arrive together; the room says when.
  useEffect(() => {
    if (!room || !stage.current) return;
    // Lit as the place it is, before it is shown: the lobby and the office stay bright after dark, the town by the sky.
    stage.current.setLights(lightsFor(place));
    const moved = shownPlace.current !== undefined && place !== shownPlace.current;
    if (visitor && moved) stage.current.enter(room, arriveRef.current);
    else stage.current.setRoom(room, moved);
    shownPlace.current = place;
    if (moved) greetIn(stage.current, place);
  }, [room]);
  // Rearranging the room, after any new room above, so what was just saved is in place before the marks go on it.
  const editRef = useRef(edit);
  editRef.current = edit;
  useEffect(() => {
    stage.current?.setEditing(edit ?? null);
  }, [edit]);
  // Asked to stand by someone in the place you are in already: at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new ask says when; the rest is read through refs.
  useEffect(() => {
    if (stage.current && greet) greetIn(stage.current, shownPlace.current);
  }, [greet?.n]);
  const animationsRef = useRef(animations);
  animationsRef.current = animations;
  const animationsKey = animations.join("\n");
  const [problem, setProblem] = useState<string | null>(null);
  // Where the door under the pointer goes, and where on the stage the pointer is.
  const [doorTip, setDoorTip] = useState<{ words: string; x: number; y: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new animation list rebuilds the stage; the effect reads it through a ref.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let gone = false;
    let unsurface: (() => void) | undefined;
    setProblem(null);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    import("./stage")
      .then(({ createStage }) =>
        createStage(el, url, () => live.current, {
          reducedMotion,
          view: visitor ? "room" : viewRef.current,
          animations: animationsRef.current,
          ...(roomRef.current ? { room: roomRef.current } : {}),
          ...(companyRef.current?.length ? { company: companyRef.current } : {}),
          ...(agentRef.current ? { agent: agentRef.current } : {}),
          ...(wearRef.current?.length ? { wear: wearRef.current } : {}),
          ...(looksRef.current ? { looks: looksRef.current } : {}),
          ...(visitor
            ? {
                visitor: true,
                onNear: (who: string | undefined) => nearRef.current?.(who),
                onLine: (who: string, text: string, nearness: number, phone?: boolean) =>
                  lineRef.current?.(who, text, nearness, phone),
              }
            : {}),
          onUse: (action: string, on?: UseSpot, thing?: string) => onUseRef.current?.(action, on, thing),
          onFocus: setReading,
          // A surface under the pointer says what clicking it does, as a door says where it goes; so does the plaque.
          onSurfaceHover: (label: string | undefined, at?: { x: number; y: number }) =>
            setDoorTip(label && at ? { words: `Use ${label} · click or F`, x: at.x, y: at.y } : null),
          onPlaqueHover: (at: { x: number; y: number } | undefined) =>
            setDoorTip(at ? { words: "About this room · click", x: at.x, y: at.y } : null),
          ...(doors
            ? {
                onDoor: (door: RoomDoor) => doorRef.current?.(door),
                onDoorHover: (door: RoomDoor | undefined, at?: { x: number; y: number }) =>
                  setDoorTip(door && at ? { words: doorWords(door), x: at.x, y: at.y } : null),
              }
            : {}),
          lights: lightsFor(placeRef.current),
          // The view toggle and the tools over the top of the stage: what is said stays out from under them, and
          // where they reach far down a short stage the agent is framed clear of them.
          overlays: () => [...(host.current?.parentElement?.querySelectorAll(OVERLAYS) ?? [])],
          hints: () => [...(host.current?.parentElement?.querySelectorAll(HINTS) ?? [])],
          ...(arriveRef.current ? { arriveFrom: arriveRef.current } : {}),
          ...(picking
            ? {
                onPick: (who: string, at: { x: number; y: number }) => {
                  if (bodyRef.current?.(who)) {
                    setPicked(null);
                    return;
                  }
                  const box = host.current?.getBoundingClientRect();
                  const w = box?.width ?? 0;
                  const h = box?.height ?? 0;
                  // Below the click, kept inside the stage.
                  const x = Math.min(Math.max(at.x - (box?.left ?? 0), 130), Math.max(130, w - 130));
                  const y = Math.min(at.y - (box?.top ?? 0) + 10, Math.max(10, h - 220));
                  setPicked({ agent: who, x, y });
                },
              }
            : {}),
          ...(stillRef.current.still
            ? { still: stillRef.current.still, onReady: () => stillRef.current.onReady?.() }
            : {}),
          // Through the ref: the page's latest way to ask, without rebuilding the stage.
          ...(choosing
            ? {
                chooseIdle: (here: string | undefined, hour: number) =>
                  chooseRef.current?.(here, hour) ?? Promise.resolve([]),
              }
            : {}),
        }),
      )
      .then((s) => {
        if (gone) {
          s.dispose();
          return;
        }
        stage.current = s;
        setShown(s);
        shownRef.current?.(true);
        unsurface = s.onSurfaces(setSurfaces);
        if (controlsRef.current)
          controlsRef.current.current = { cue: (c) => s.cue(c), walkBy: (w) => s.walkBy(w), where: () => s.where() };
        s.setInsets(insetRef.current);
        // The room, or who is in it, may have arrived or changed while the stage was loading.
        s.setLights(lightsFor(placeRef.current));
        if (roomRef.current) s.setRoom(roomRef.current);
        shownPlace.current = placeRef.current;
        s.setCompany(companyRef.current ?? []);
        s.setWear(wearRef.current ?? []);
        s.setLooks(looksRef.current ?? {});
        if (emotesRef.current) s.setEmotes(emotesRef.current);
        if (activitiesRef.current) s.setActivities(activitiesRef.current);
        if (speechRef.current) s.setSpeech(speechRef.current);
        if (tasksRef.current) s.setTasks(tasksRef.current);
        if (screenRef.current) s.setScreen(screenRef.current);
        if (calendarRef.current) s.setCalendar(calendarRef.current);
        if (Object.keys(glancesRef.current).length) s.setGlances(glancesRef.current);
        if (editRef.current) s.setEditing(editRef.current);
        greetIn(s, placeRef.current);
      })
      .catch((err: unknown) => {
        if (gone) return;
        const reason = err instanceof Error ? err.message : String(err);
        setProblem(reason);
        stillRef.current.onProblem?.(reason);
      });
    return () => {
      gone = true;
      unsurface?.();
      stage.current?.dispose();
      stage.current = null;
      setShown(null);
      shownRef.current?.(false);
      setSurfaces([]);
      setReading(undefined);
      setDoorTip(null);
      if (controlsRef.current) controlsRef.current.current = null;
    };
  }, [url, animationsKey, choosing, picking, visitor, doors]);
  useEffect(() => {
    if (visitor) setTravel("walk");
  }, [visitor]);

  const choose = (next: StageView) => {
    setView(next);
    stage.current?.setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Remembering the view is a convenience; without storage it just resets.
    }
  };

  if (problem) return <p className="talk-avatar-problem">Couldn't show the avatar: {problem}</p>;
  return (
    // What agents are doing, in the colours the doors and signs use, for everything over the stage.
    <div className={fill ? "talk-stage fill" : "talk-stage"} style={DOING_VARS as CSSProperties}>
      <div
        className="talk-avatar"
        ref={host}
        title={
          edit
            ? "Drag things to move them. Drag the floor to look around."
            : "Drag to look around. Click furniture to send it there."
        }
      />
      <SurfacePortals views={surfaces} data={faces} stage={surfaceStage} />
      {picked && (
        <AgentMenu
          agent={picked.agent}
          at={picked}
          activity={activities?.[picked.agent]}
          actions={menuRef.current?.(picked.agent) ?? []}
          onClose={() => setPicked(null)}
        />
      )}
      {doorTip && (
        <div
          // Near the right of what can be seen, on the pointer's left, so the chat panel doesn't cover it.
          className={`door-tip${doorTip.x > (host.current?.clientWidth ?? 0) - insetRight - DOOR_TIP_ROOM ? " left" : ""}`}
          aria-hidden="true"
          style={{ left: doorTip.x, top: doorTip.y }}
        >
          {doorTip.words}
        </div>
      )}
      {shown && panels?.map((p) => <Anchored key={p.id} panel={p} stage={shown} />)}
      {tools && <div className="talk-tools">{tools}</div>}
      {reading && (
        <button type="button" className="talk-back" onClick={() => stage.current?.focusSurface(null)}>
          ← Step back
        </button>
      )}
      {overlay}
      {visitor && !edit && (
        <>
          <fieldset className="talk-view" aria-label="How you get around">
            {(["walk", "fly"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={travel === t}
                onClick={() => {
                  setTravel(t);
                  stage.current?.setTravel(t);
                }}
              >
                {t === "walk" ? "Walk" : "Fly"}
              </button>
            ))}
          </fieldset>
          <p className="talk-keys">
            {reading
              ? "Esc, F or click away to step back"
              : travel === "walk"
                ? "WASD or arrows to walk · Shift to run · click the floor to go there · click a screen to use it · drag to look · wheel to zoom"
                : "WASD to fly · Shift for speed · E up, Q down · drag to turn · wheel to zoom"}
          </p>
        </>
      )}
      {!fixedView && !visitor && !edit && (
        <fieldset className="talk-view" aria-label="Avatar view">
          {(["room", "close"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => choose(v)}>
              {v === "room" ? "Room" : "Close up"}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/**
 * A panel kept in the world beside what it is about: the stage places it
 * every frame (`Stage.anchorPanel`) and says which side it went, which its
 * tail and its look follow. Real HTML, so keys, focus and screen readers work
 * in it as anywhere on the page.
 */
function Anchored({ panel, stage }: { panel: WorldPanelSpec; stage: Stage }) {
  const el = useRef<HTMLDivElement>(null);
  const awayRef = useRef(panel.onAway);
  awayRef.current = panel.onAway;
  const { anchor, rank, optional, fallback, look, color } = panel;
  const key = JSON.stringify(anchor);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key says when the anchor changed; the anchor is read with it.
  useEffect(() => {
    if (!el.current) return;
    return stage.anchorPanel(el.current, anchor, {
      ...(rank !== undefined ? { rank } : {}),
      ...(optional ? { optional } : {}),
      ...(fallback ? { fallback } : {}),
      onAway: () => awayRef.current?.(),
    });
  }, [stage, key, rank, optional, fallback]);
  return (
    <div
      ref={el}
      className={`world-anchor world-anchor-${look}`}
      data-panel={panel.kind}
      style={color === undefined ? undefined : ({ ["--who-color" as string]: color } as CSSProperties)}
    >
      {/* A pin through it, or a clip at its top, as its look says. */}
      <span className="world-anchor-mark" aria-hidden="true" />
      {panel.node}
    </div>
  );
}

/** Seconds, minutes or hours since, in a few words. */
function since(at: string | undefined): string | undefined {
  const ms = at ? Date.now() - Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `for ${Math.round(ms / 60_000)} min`;
  return `for ${Math.round(ms / 3_600_000)} h`;
}

/**
 * What clicking an agent's body opens: who it is, what it is doing and since
 * when, and what you can do about it. Escape or a click elsewhere closes it.
 */
function AgentMenu({
  agent,
  at,
  activity,
  actions,
  onClose,
}: {
  agent: string;
  at: { x: number; y: number };
  activity: AgentActivity | undefined;
  actions: AgentAction[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Claimed, so the chat page doesn't take the same Escape as stopping a reply.
      e.preventDefault();
      onClose();
    };
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", away);
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", away);
    };
  }, [onClose]);
  const status = activity && activity.doing !== "idle" ? activity.what : "idle";
  const when = activity?.doing !== "idle" ? since(activity?.since) : undefined;
  return (
    <div
      ref={box}
      className="agent-menu"
      role="dialog"
      aria-label={`${agent === "default" ? "This agent" : agent}: what you can do`}
      style={{ left: at.x, top: at.y }}
    >
      <div className="agent-menu-head">
        <strong>{agent === "default" ? "Default agent" : agent}</strong>
        <span className={`agent-menu-status agent-menu-${activity?.doing ?? "idle"}`}>
          {status}
          {activity?.detail ? ` · ${activity.detail}` : ""}
          {when ? ` · ${when}` : ""}
        </span>
      </div>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            try {
              await a.run();
              onClose();
            } catch (err) {
              setProblem(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          {a.label}
        </button>
      ))}
      {problem && <p className="agent-menu-problem">{problem}</p>}
    </div>
  );
}
