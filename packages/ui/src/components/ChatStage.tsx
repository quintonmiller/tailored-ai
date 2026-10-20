import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type DashboardWidgetSpec,
  fetchDashboard,
  fetchPendingApprovals,
  fetchProjectTasks,
  fetchTaskWatcher,
  fetchWidgetData,
  type PendingApprovalRequest,
  type ProjectTask,
  resolveApproval,
  updateProjectTask,
} from "../api";
import { type AgentAction, Avatar, type AvatarControls, type WorldPanelSpec } from "../avatar/Avatar";
import { type Anchor, anchorFor, PANEL_ROOM, plaqueSpot, talkAnchor, type Where } from "../avatar/anchors";
import type { BoardTask } from "../avatar/boards";
import { BODY_TYPE, type BodyChange, type BodyLooks, EMOTE_TYPE, type EmoteRecord } from "../avatar/body";
import {
  type Booked,
  type CalendarView,
  type CronJob,
  dayStart,
  doneBetween,
  doneToday,
  type OwnAgent,
  upcoming,
  type Wake,
} from "../avatar/calendar";
import type { Cue } from "../avatar/cues";
import type { AgentActivity } from "../avatar/doing";
import { doorsAsSaved } from "../avatar/editing";
import type { TaskMove } from "../avatar/Faces";
import { MODEL_TYPE, type ModelDef } from "../avatar/models";
import type { BodyState } from "../avatar/motion";
import {
  type Chatter,
  notesFrom,
  type Outing,
  occupied as occupiedBy,
  outingNow,
  talkedAt,
  withRoutines,
} from "../avatar/routines";
import { bodyFor, DEFAULT_ROOM, type Room, type RoomDoor } from "../avatar/scene";
import { dashboardCards, endpointOf, type Fetched, homeCards, type ScreenCard, screenWidgets } from "../avatar/screens";
import type { BodyMove, Companion, UseSpot } from "../avatar/stage";
import { TALK_AFTER_MS, type Talk, withTalks, YOU } from "../avatar/talk";
import { doorInTown, isOutdoors, tripsBetween } from "../avatar/town";
import { WEAR_TYPE } from "../avatar/wear";
import type { WorldData } from "../avatar/widgets";
import { changeBody, makeGesture } from "../lib/body";
import { useAgentColor, useChosenColors } from "../lib/body-colors";
import { contentText } from "../lib/content";
import { nameOf, newChatKey } from "../lib/conversations";
import { clockTime, wakeWords } from "../lib/did";
import { ANSWERED_ELSEWHERE, answerable, type Need, needsFrom, requestsOf, withQuestions } from "../lib/needs";
import { lineVolume, phoneLine } from "../lib/phone";
import { subscribeStateChanges } from "../lib/state-events";
import { countTasks, LIVE_STATUSES } from "../lib/tasks";
import { hopsAfter, isCommon, moveOf, trailThrough, plaqueWords as wordsOnPlaque } from "../lib/wayfinding";
import { NEW_ROOM_ASK, NewRoom } from "./NewRoom";
import { NewTask } from "./NewTask";
import { type EditablePlace, useRoomEditor } from "./RoomEditor";
import { useVoice } from "./voice";
import { type Said, WorldAgent } from "./WorldAgent";
import { WorldCalendar } from "./WorldCalendar";
import { WorldDashboard } from "./WorldDashboard";
import { comeOrGone, type MapPlace, useWorldMap, WorldMap } from "./WorldMap";
import { NeedCard, NeedsList } from "./WorldNeeds";
import { ROOM_ASK, WorldPlace, withChangeLines } from "./WorldPlace";
import { type ListView, TaskCard, TaskList } from "./WorldTasks";
import { facesIn, useWidgetFeeds, whoseIn } from "./WorldWidgets";

/**
 * The chat page's scene and voice: the agent's 3D body behind the
 * conversation when it has one, and hold-to-talk into the same
 * conversation. Typed and spoken turns are one history.
 */

const STAGE_KEY = "tai.chat.stage";
/** No places come through by doors put in: the same empty list each time, so nothing worked out from it is again. */
const NO_HOPS: string[] = [];
const NO_THROUGH = { at: "", hops: NO_HOPS };
const VOICES_KEY = "tai.world.voices";
/** Lines waiting to be spoken at most: past this, the oldest are let go rather than heard late. */
const VOICE_QUEUE = 2;
/** How wide the chat panel laid over the scene is, on a screen wide enough for one. */
export const PANEL_WIDTH = 440;
/**
 * How long a conversation counts as going on after its last turn. While it
 * does, the avatar stays where it is (or where it was sent) instead of
 * wandering; the first turn after a quiet spell calls it over to face you.
 */
export const CONVERSING_MS = 3 * 60_000;

function saved(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "on";
  } catch {
    return fallback;
  }
}

function remember(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // A convenience: without storage the choice resets next time.
  }
}

/**
 * The agent's room as the server keeps it, a `place` record the agent can
 * change with its `place` tool, redrawn the moment it does. The built-in
 * room until it arrives, and when the server keeps none.
 */
export function useRoom(agent: string, enabled: boolean): SceneInfo {
  const [scene, setScene] = useState<SceneInfo>({
    room: DEFAULT_ROOM,
    company: [],
  });
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    let id: string | undefined;
    // The room as last shown, for whether a model that changed is drawn in it.
    let shown: Room = DEFAULT_ROOM;
    // Only the latest answer counts: an older one arriving late would show the room as it was. A whole answer
    // still owed when a later ask is for the doors alone is taken whole.
    let asked = 0;
    let owed = false;
    /** Ask for the place; `ifDoorsMoved`, only take the answer when its doors aren't where they were. */
    const load = (ifDoorsMoved = false) => {
      const n = ++asked;
      if (!ifDoorsMoved) owed = true;
      const doorsOnly = ifDoorsMoved && !owed;
      return fetch(`/api/ext/builtin:places/${encodeURIComponent(agent || "default")}`)
        .then((res) => (res.ok ? (res.json() as Promise<PlaceInfo>) : null))
        .then((body) => {
          if (gone || n !== asked) return;
          owed = false;
          id = body?.id;
          const next = {
            room: roomOf(body),
            company: companyOf(body),
            ...(id ? { id } : {}),
            ...areaOf(body),
            ...(body?.wear ? { wear: body.wear } : {}),
            looks: looksIn(body, body?.id),
            ...recordOfPlace(body),
          };
          shown = next.room;
          setScene((s) => (doorsOnly && sameDoors(s.room.doors, next.room.doors) ? s : steady(s, next)));
        })
        .catch(() => {
          if (!gone && n === asked && !doorsOnly) setScene({ room: DEFAULT_ROOM, company: [] });
        });
    };
    void load();
    const off = subscribeStateChanges((change) => {
      // Someone came or went, maybe this agent itself: where it is and who is there are asked again. And for
      // someone choosing what a body here wears, or how it looks and carries itself, making over a model that stands
      // here, or changing a record a face here shows, so its picture from across the room says what is true now.
      if (comeOrGone(change.type) || change.type === WEAR_TYPE || change.type === BODY_TYPE) void load();
      else if (drawsModel(shown, change) || facesShow(shown, change.type)) void load();
      // A door put in or taken out somewhere else may be the way back to here, which shows once both sides are in.
      if (change.type === "place" && id && change.id !== id && relinked(change)) void load(true);
      if (change.type !== "place" || !id || change.id !== id) return;
      if (change.op === "delete" || !change.after || resized(change)) void load();
      else {
        // Shown as changed at once; and since where its door goes depends on what is in it, asked again for that,
        // and whole for a model it has now that the page hasn't been sent.
        const next = withModels(change.after as unknown as Room, shown);
        shown = next.room;
        setScene((s) => ({
          ...s,
          // As on a visit: a meeting room's purpose stays its room's while the record has none of its own.
          room: { ...lentTo(next.room, s), doors: doorsAsSaved(s.room.doors, change.after) },
          version: change.version,
        }));
        void load(!next.missing);
      }
    });
    return () => {
      gone = true;
      off();
    };
  }, [agent, enabled]);
  return scene;
}

/** A place as the page shows it: its room with its doors, who is in it, its id, and the area it is in. */
export interface SceneInfo {
  room: Room;
  company: Companion[];
  id?: string;
  area?: string;
  /** What the agent whose place this is wears, for its own body: an agent's own place only. */
  wear?: string[];
  /** How the agent whose place this is chose to look and carry itself: an agent's own place only. */
  looks?: BodyLooks;
  /** What a person rearranging it writes with: the record's version (0 while drawn fresh) and scope. */
  version?: number;
  scope?: string;
  /** A person may rearrange it: anywhere but the town and the office's floors, which are laid out from what there is. */
  editable?: boolean;
  /** Fields shown that aren't the record's own: a meeting room's purpose, from its room. */
  lent?: string[];
}

/** The room the server sent, with its doors; the built-in room when it sent none. */
export function roomOf(info: PlaceInfo | null | undefined): Room {
  if (!info?.place) return DEFAULT_ROOM;
  const models = info.models && Object.keys(info.models).length ? { models: info.models } : {};
  return info.doors?.length ? { ...info.place, doors: info.doors, ...models } : { ...info.place, ...models };
}

/**
 * A place's record as it changed, drawn with the models it had: and whether
 * that is enough, or it now has a model the page hasn't been sent and has to
 * be asked for again.
 */
export function withModels(record: Room, was: Room): { room: Room; missing: boolean } {
  const models = was.models;
  const missing = record.props.some((p) => p.model && !models?.[p.model]);
  return { room: models ? { ...record, models } : record, missing };
}

/** Whether a change is to a model drawn in the room: it is asked for again, to show it as it is now. */
export function drawsModel(room: Room, change: { type: string; id: string }): boolean {
  return change.type === MODEL_TYPE && room.props.some((p) => p.model === change.id);
}

/**
 * Whether a face on a model in the room shows records of this type: a list's
 * or a table's, or a card's record. The room is asked for again when one
 * changes, so the face's picture from across the room is drawn from the
 * records as they are now.
 */
export function facesShow(room: Room, type: string): boolean {
  return Object.values(room.models ?? {}).some((m) =>
    m.parts?.some((p) => p.face?.spec?.query?.type === type || p.face?.spec?.bind?.type === type),
  );
}

const areaOf = (info: PlaceInfo | null | undefined) => (info?.area ? { area: info.area } : {});

/** What a write to the place needs, as the server sent it. */
function recordOfPlace(info: PlaceInfo | null | undefined): Pick<SceneInfo, "version" | "scope" | "editable" | "lent"> {
  if (!info || typeof info.version !== "number" || !info.scope) return {};
  return {
    version: info.version,
    scope: info.scope,
    editable: !!info.editable,
    ...(info.lent?.length ? { lent: info.lent } : {}),
  };
}

/** A room as changed, with what was lent to it before still lent while the record has none of its own. */
function lentTo(room: Room, was: SceneInfo): Room {
  const out: Record<string, unknown> = { ...room };
  for (const field of was.lent ?? [])
    if (out[field] === undefined) out[field] = (was.room as unknown as Record<string, unknown>)[field];
  return out as unknown as Room;
}

/**
 * The place as asked for again, keeping the room it had when nothing in it
 * changed: someone coming or going asks for the whole place, and a new room
 * object would have the stage take down and build every piece of furniture
 * again, and hang every photo afresh.
 */
export function steady(was: SceneInfo | null, next: SceneInfo): SceneInfo {
  if (!was || was.id !== next.id || was.room === next.room) return next;
  return JSON.stringify(was.room) === JSON.stringify(next.room) ? { ...next, room: was.room } : next;
}

/** Whether two lists of doors are the same doors in the same places. */
export function sameDoors(a: RoomDoor[] | undefined, b: RoomDoor[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** A change to the doors put in a place: a door elsewhere shows only once both its sides are in. */
function relinked(change: { before?: Record<string, unknown>; after?: Record<string, unknown> }): boolean {
  return JSON.stringify(change.before?.links ?? []) !== JSON.stringify(change.after?.links ?? []);
}

/** A change that can move a place's doors (made anew, a new size, another area): worth asking for them again. */
function resized(change: { op: string; before?: Record<string, unknown>; after?: Record<string, unknown> }): boolean {
  const { before, after } = change;
  if (!before || !after) return change.op === "create";
  return before.width !== after.width || before.depth !== after.depth || before.area !== after.area;
}

/**
 * Every record of one world-state type, by id, kept current as they change:
 * what every agent is doing (`activity`) and the last thing each said
 * (`speech`), both from `builtin:activity`. Empty when the server keeps none.
 * `stamp` marks each record that comes in while the page is open with when
 * the page heard it, by its own clock (`heard`): a gesture is timed by it.
 */
export function useRecords<T>(type: string, enabled: boolean, stamp = false): Record<string, T> {
  const [records, setRecords] = useState<Record<string, T>>({});
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    fetch(`/api/state/${type}?limit=500`)
      .then((res) => (res.ok ? (res.json() as Promise<{ records?: { id: string; data: T }[] }>) : null))
      .then((body) => {
        if (gone || !body?.records) return;
        // Changes heard while this was loading are newer: they win.
        setRecords((heard) => ({ ...Object.fromEntries(body.records?.map((r) => [r.id, r.data]) ?? []), ...heard }));
      })
      .catch(() => {});
    const off = subscribeStateChanges((change) => {
      if (change.type !== type) return;
      setRecords((all) => {
        const next = { ...all };
        if (change.op === "delete" || !change.after) delete next[change.id];
        else next[change.id] = (stamp ? { ...change.after, heard: Date.now() } : change.after) as unknown as T;
        return next;
      });
    });
    return () => {
      gone = true;
      off();
    };
  }, [type, enabled, stamp]);
  return records;
}

/** A way to sound, for lines down the phone: made the first time one is said; none where the browser has none. */
function soundOut(held: { current: AudioContext | null | undefined }): AudioContext | null {
  if (held.current === undefined) {
    try {
      held.current = typeof AudioContext === "undefined" ? null : new AudioContext();
    } catch {
      held.current = null;
    }
  }
  return held.current;
}

/** How long a line down the phone waits for the browser to let the page's sound out, before it plays plainly instead. */
const SOUND_WAIT_MS = 500;

/**
 * Whether `ctx` is letting sound out, having asked once more if it was held
 * back: waiting no longer than `ms`, as a browser may hold it back for good
 * (some want a fresh tap, not just one made earlier on the page).
 */
async function soundsOut(ctx: AudioContext, ms: number): Promise<boolean> {
  if (ctx.state === "suspended") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ctx.resume().catch(() => {}),
      new Promise<void>((done) => {
        timer = setTimeout(done, ms);
      }),
    ]);
    clearTimeout(timer);
  }
  return ctx.state === "running";
}

/**
 * What agents say, out loud, when you are near them on a visit: each line
 * spoken in the agent's own voice, quieter the further away you stand, one at
 * a time. The far side of a call, heard out of the phone of an agent you
 * stand by, sounds as it would down a telephone line (`phone.ts`). Off until
 * switched on, because the voice may be made on a GPU.
 */
export function useVoicesNearby(on: boolean) {
  const queue = useRef<{ agent: string; text: string; nearness: number; phone: boolean }[]>([]);
  const playing = useRef(false);
  // The phone line's sound, made when first needed and closed with the page.
  const sound = useRef<AudioContext | null | undefined>(undefined);
  useEffect(
    () => () => {
      void sound.current?.close?.().catch(() => {});
      sound.current = undefined;
    },
    [],
  );
  const next = useCallback(async () => {
    if (playing.current) return;
    const line = queue.current.shift();
    if (!line) return;
    playing.current = true;
    let chain: AudioNode[] = [];
    try {
      const res = await fetch("/api/live/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: line.agent, text: line.text }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      const ctx = line.phone ? soundOut(sound) : null;
      if (ctx && (await soundsOut(ctx, SOUND_WAIT_MS))) {
        // Down the line: through the phone's filters, at the phone's volume, rather than the element's own. The
        // element's own way in is let go with the rest once the line is said.
        const source = ctx.createMediaElementSource(audio);
        chain = [source, ...phoneLine(ctx, source, ctx.destination, lineVolume(line.nearness, true))];
      } else audio.volume = lineVolume(line.nearness, line.phone);
      await new Promise<void>((done) => {
        audio.onended = () => done();
        audio.play().catch(() => done());
      });
      URL.revokeObjectURL(url);
    } catch {
      // A line that can't be voiced is still in its bubble.
    } finally {
      for (const node of chain) node.disconnect();
      playing.current = false;
      void next();
    }
  }, []);
  useEffect(() => {
    if (!on) queue.current = [];
  }, [on]);
  return useCallback(
    (agent: string, text: string, nearness: number, phone = false) => {
      if (!on) return;
      queue.current.push({ agent, text, nearness, phone });
      if (queue.current.length > VOICE_QUEUE) queue.current.splice(0, queue.current.length - VOICE_QUEUE);
      void next();
    },
    [on, next],
  );
}

/** How often the boards ask for tasks again. */
const BOARD_REFRESH_MS = 30_000;
/** Tasks kept for the boards and the list: the most recently changed, which is what the server sends first. */
const TASKS_KEPT = 300;

/**
 * Tasks for the boards on the walls and the task list: every one that isn't
 * archived, asked again every half minute. A change made here goes on the
 * boards the moment it is saved (`put`), and they ask again straight after
 * (`reload`) for anything else that changed with it.
 */
export function useBoardTasks(enabled: boolean): {
  tasks: ProjectTask[];
  total: number;
  reload: () => void;
  put: (task: ProjectTask) => void;
} {
  const [state, setState] = useState<{ tasks: ProjectTask[]; total: number }>({ tasks: [], total: 0 });
  const [asked, setAsked] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` is how a reload asks again.
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const load = () =>
      fetchProjectTasks({ status: LIVE_STATUSES.join(","), limit: TASKS_KEPT })
        .then((res) => {
          if (!gone) setState({ tasks: res.tasks, total: res.total ?? res.tasks.length });
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, BOARD_REFRESH_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [enabled, asked]);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const put = useCallback(
    (task: ProjectTask) =>
      setState(({ tasks, total }) => {
        const old = tasks.find((t) => t.id === task.id);
        const rest = tasks.filter((t) => t.id !== task.id);
        // Just changed is the most recently changed: first, as the server would send it. Archived is off the boards.
        if (!LIVE_STATUSES.includes(task.status)) return { tasks: rest, total: old ? total - 1 : total };
        return { tasks: [{ ...old, ...task }, ...rest], total: old ? total : total + 1 };
      }),
    [],
  );
  return { ...state, reload, put };
}

/** How often the screens and calendars on the walls ask again for what they show. */
const WALL_REFRESH_MS = 60_000;

/** The dashboard as the walls have it: its widgets, what the first few's endpoints sent, and whether it was had. */
export interface WallDashboard {
  widgets: DashboardWidgetSpec[];
  fetched: Record<string, Fetched>;
  /** Asked for and answered, with widgets or without. */
  loaded: boolean;
  /** Why it couldn't be had, the last time it was asked for. */
  error?: string;
}

/**
 * The dashboard, for a screen on a wall and the panel it opens: every widget
 * the Board page has, and what the endpoints of the first few, the ones a
 * screen shows, sent. Asked again every minute.
 */
export function useDashboard(enabled: boolean): WallDashboard {
  const [state, setState] = useState<WallDashboard>({ widgets: [], fetched: {}, loaded: false });
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const load = async () => {
      let widgets: DashboardWidgetSpec[];
      try {
        widgets = (await fetchDashboard()).widgets ?? [];
      } catch (err) {
        // What it showed stays up; the panel and an empty screen say why there is nothing newer.
        const error = err instanceof Error ? err.message : String(err);
        if (!gone) setState((was) => ({ ...was, loaded: true, error }));
        return;
      }
      const fetched = await Promise.all(
        screenWidgets(widgets).map(async (w): Promise<[string, Fetched]> => {
          const endpoint = endpointOf(w);
          if (!endpoint) return [w.id, undefined];
          try {
            return [w.id, { data: await fetchWidgetData(endpoint) }];
          } catch (err) {
            return [w.id, { error: err instanceof Error ? err.message : String(err) }];
          }
        }),
      );
      if (!gone) setState({ widgets, fetched: Object.fromEntries(fetched), loaded: true });
    };
    void load();
    const timer = setInterval(load, WALL_REFRESH_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return state;
}

/** A JSON body, or `fallback` when there is none to be had. */
function getJson<T>(url: string, fallback: T): Promise<T> {
  return fetch(url)
    .then((res) => (res.ok ? (res.json() as Promise<T>) : fallback))
    .catch(() => fallback);
}

/**
 * Every wake to come in the week, for the calendars: what agents booked with
 * the `schedule` tool, the cron jobs, and the turns of agents that run on
 * their own, asked again every minute. Null until first asked.
 */
export function useWakes(enabled: boolean): Wake[] | null {
  const [wakes, setWakes] = useState<Wake[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const load = async () => {
      const [booked, cron, own] = await Promise.all([
        getJson<{ schedules?: Booked[] }>("/api/schedules?limit=200", {}),
        getJson<{ enabled?: boolean; jobs?: CronJob[] }>("/api/cron", {}),
        getJson<{ enabled?: boolean; agents?: OwnAgent[] }>("/api/exploratory/agents", {}),
      ]);
      if (gone) return;
      setWakes(
        upcoming({
          booked: booked.schedules ?? [],
          cron: cron.jobs ?? [],
          cronOn: !!cron.enabled,
          own: own.agents ?? [],
          ownOn: !!own.enabled,
        }),
      );
    };
    void load();
    const timer = setInterval(load, WALL_REFRESH_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return wakes;
}

/** The time, to the minute, while `enabled`: what a calendar dates itself by and counts "today" from. */
function useMinute(enabled: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => setNow(Math.floor(Date.now() / 60_000) * 60_000);
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/**
 * Whether making or assigning a task wakes its agent: per kind of change,
 * whether the task watcher is on and reacts to it. Asked again each time a
 * task panel opens, since the config can change under the page; undefined
 * until first asked.
 */
function useTaskWatcher(enabled: boolean): { created: boolean; updated: boolean } | undefined {
  const [watcher, setWatcher] = useState<{ created: boolean; updated: boolean } | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    fetchTaskWatcher()
      .then((w) => {
        if (!gone)
          setWatcher({
            created: w.enabled && w.triggers.includes("created"),
            updated: w.enabled && w.triggers.includes("updated"),
          });
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [enabled]);
  return watcher;
}

/**
 * The approvals this page can answer, from the server's queue: asked for
 * again whenever the requests agents wait on change (`asking`, their ids), and
 * when `fresh` turns true (a card about one opening). Says which requests it
 * was asked for, so a card can tell details still coming from a request the
 * server doesn't hold (asked on Discord, say).
 */
function usePendingApprovals(
  enabled: boolean,
  asking: string,
  fresh: boolean,
): { list: PendingApprovalRequest[]; asked: string | null; failed: boolean } {
  const [got, setGot] = useState<{ list: PendingApprovalRequest[]; asked: string | null; failed: boolean }>({
    list: [],
    asked: null,
    failed: false,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fresh` turning true is how a card asks again.
  useEffect(() => {
    if (!enabled) return;
    if (!asking) {
      setGot({ list: [], asked: "", failed: false });
      return;
    }
    let gone = false;
    fetchPendingApprovals()
      .then((list) => {
        if (!gone) setGot({ list, asked: asking, failed: false });
      })
      .catch(() => {
        if (!gone) setGot({ list: [], asked: asking, failed: true });
      });
    return () => {
      gone = true;
    };
  }, [enabled, asking, fresh]);
  return got;
}

/** Where an agent's body is, from the map, in a few words for a list: "here", "at home", "in #trip". */
export function whereWords(agent: string, places: MapPlace[], here: string | undefined): string | undefined {
  const spot = places.find((p) => p.kind !== "lobby" && p.agents.includes(agent));
  if (!spot) return undefined;
  if (spot.id === here) return "here";
  if (spot.kind === "room") return `in #${spot.name}`;
  return spot.kind === "home" && spot.owner === agent ? "at home" : `in ${spot.name}`;
}

/** Which tasks a place's boards show: everyone's on the square and in the lobby, otherwise those of whoever is there. */
export function tasksFor(place: string | undefined, agents: string[], tasks: BoardTask[]): BoardTask[] {
  if (!place) return [];
  if (isCommon(place)) return tasks;
  const who = place.startsWith("home:") ? [place.slice("home:".length)] : agents;
  return tasks.filter((t) => !!t.assignee && who.includes(t.assignee));
}

/** Whose wakes a place's calendars show, as its boards show tasks: everyone's in common places, otherwise whoever is there. */
export function wakesFor(place: string | undefined, agents: string[], wakes: Wake[]): Wake[] {
  if (!place) return [];
  if (isCommon(place)) return wakes;
  const who = place.startsWith("home:") ? [place.slice("home:".length)] : agents;
  return wakes.filter((w) => who.includes(w.agent));
}

/** When a wake comes, in the few words a screen has room for: "14:30", "Tue 09:00", "any minute now". */
export function wakeWhen(at: number, now: number): string {
  return wakeWords(new Date(at).toISOString(), now) ?? clockTime(at);
}

/** What a calendar shows when every agent is paused. */
export const PAUSED_NOTE = "Agents are paused: nothing wakes until they are resumed.";

/** Agents whose own list of tools leaves out `place`: they can't change a room. */
export function placeless(agents: Record<string, { tools?: unknown }>): Set<string> {
  return new Set(
    Object.entries(agents ?? {}).flatMap(([name, a]) =>
      Array.isArray(a?.tools) && !a.tools.includes("place") ? [name] : [],
    ),
  );
}

interface Roster {
  online: Set<string>;
  names: string[];
  /** Agents without the place tool. */
  placeless: Set<string>;
}

/** What the agents themselves are configured as: whether one runs on its own, which is what can be paused, and whether it can change a room. */
function useAgentRoster(enabled: boolean): Roster {
  const [roster, setRoster] = useState<Roster>({ online: new Set(), names: [], placeless: new Set() });
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    fetch("/api/agents")
      .then((res) => (res.ok ? res.json() : {}))
      .then((agents: Record<string, { online?: { enabled?: boolean }; tools?: unknown }>) => {
        if (!gone)
          setRoster({
            online: new Set(Object.entries(agents ?? {}).flatMap(([name, a]) => (a?.online?.enabled ? [name] : []))),
            names: Object.keys(agents ?? {}).sort(),
            placeless: placeless(agents),
          });
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [enabled]);
  return roster;
}

async function must(res: Promise<Response>, what: string): Promise<void> {
  const r = await res;
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Couldn't ${what} (${r.status}).`);
  }
}

/** The time, every few seconds while `enabled`: what talks that have run out are let go by. */
function useNow(enabled: boolean, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [enabled, everyMs]);
  return now;
}

/** Each speaker's latest line, of two sets of them: what the server keeps, and what only this page heard. */
export function newest(a: Record<string, Said>, b: Record<string, Said>): Record<string, Said> {
  let out = a;
  for (const [who, line] of Object.entries(b)) {
    const was = a[who];
    if (was && Date.parse(was.at) >= Date.parse(line.at)) continue;
    if (out === a) out = { ...a };
    out[who] = line;
  }
  return out;
}

/** How often a talk with you is written again while a reply is still on its way, so it never runs out under it. */
const TALK_AGAIN_MS = 15_000;
/** How often the page looks again at which talks have run out. */
const TALK_TICK_MS = 5_000;

/**
 * Your last exchange in a conversation, as the page holds it: what you last
 * said, and the answer to it once there is one. An answer from before what
 * you last said is no answer to it.
 */
export function lastExchange(messages: { role: string; content: unknown }[]): { said?: string; reply?: string } {
  const text = (m: { content: unknown } | undefined) =>
    m ? contentText(m.content as Parameters<typeof contentText>[0]).trim() : "";
  let reply = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const said = text(m);
      return { ...(said ? { said } : {}), ...(reply ? { reply } : {}) };
    }
    if (!reply && m.role === "assistant") reply = text(m);
  }
  return {};
}

/**
 * The agent's `talk` record while you talk to it on a visit: with `you`,
 * face to face when its body is in the place you are in, on the phone when
 * not. The page is the only one that knows where you are, so it writes it,
 * for every page to show. The page takes it away as you leave (`hangUp`); one
 * closed in the middle of a talk leaves it to run out by itself.
 */
async function talkWithYou(agent: string, near: boolean): Promise<void> {
  await fetch(`/api/state/talk/${encodeURIComponent(agent)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "global",
      data: { with: YOU, ...(near ? {} : { phone: true }), until: new Date(Date.now() + TALK_AFTER_MS).toISOString() },
    }),
  }).catch(() => {});
}

/**
 * Your talk with an agent over, for every page: its `talk` record taken away,
 * while it is still the one with you. A talk the places plugin wrote since,
 * with another agent, is left alone, and so is one changed in between.
 */
async function hangUp(agent: string): Promise<void> {
  const url = `/api/state/talk/${encodeURIComponent(agent)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const record = (await res.json()) as { version?: unknown; data?: { with?: unknown } };
    if (record.data?.with !== YOU || typeof record.version !== "number") return;
    await fetch(`${url}?expectedVersion=${record.version}`, { method: "DELETE" });
  } catch {
    // Left where it is, it runs out by itself.
  }
}

/**
 * Your talk with the agent the chat is with, while you visit somewhere in your
 * own body (`on`): face to face when its body is here (`near`), on the phone
 * when it isn't. While you talk, and for a little after, the agent's `talk`
 * record says so (`talkWithYou`), and your own body shows it too: what this
 * returns as `talk`, which only this page knows. What you say and what it
 * answers show in bubbles, as `lines`: yours over your head, its over its own
 * when it is here and out of your phone when it isn't.
 */
function useTalkWithYou(opts: {
  on: boolean;
  agent: string;
  near: boolean;
  /** A typed message is on its way, until its answer is in. */
  sending: boolean;
  /** A reply is on its way: typed, or spoken. */
  busy: boolean;
  /** What you last said and its answer, typed. */
  exchange: { said?: string; reply?: string };
  now: number;
}): {
  talk: Talk | undefined;
  lines: Record<string, Said>;
  /** Something said out loud: by you (`heard`), or the agent's answer; `voiced`, already played as it was said. */
  spoke: (who: "you" | "agent", text: string, voiced?: boolean) => void;
} {
  const { on, agent, near, sending, busy, exchange, now } = opts;
  const [lines, setLines] = useState<Record<string, Said>>({});
  const [lastAt, setLastAt] = useState(0);
  const onRef = useRef(on);
  onRef.current = on;
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const spoke = useCallback((who: "you" | "agent", text: string, voiced = false) => {
    if (!onRef.current || !text.trim()) return;
    const at = new Date().toISOString();
    const speaker = who === "you" ? YOU : agentRef.current;
    const to = who === "you" ? agentRef.current : YOU;
    setLines((was) => ({ ...was, [speaker]: { text: text.trim(), at, to: [to], ...(voiced ? { voiced } : {}) } }));
    setLastAt(Date.now());
  }, []);
  // Talking to someone else now: nothing has been said to it yet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new agent is what starts the count again.
  useEffect(() => setLastAt(0), [agent]);
  // Back from the visit, what was said on it goes with it: the agent's own view shows nothing of your talk.
  useEffect(() => {
    if (!on) setLines({});
  }, [on]);
  // A typed message going out is what you said; the answer arriving after it, what the agent said back.
  const waiting = useRef(false);
  const said = exchange.said;
  const reply = exchange.reply;
  useEffect(() => {
    if (!sending) return;
    if (said) spoke("you", said);
    waiting.current = true;
  }, [sending, said, spoke]);
  useEffect(() => {
    if (!waiting.current || !reply) return;
    waiting.current = false;
    spoke("agent", reply);
  }, [reply, spoke]);
  // The agent's record: written as you start, again while a reply takes its time, and once more as it comes, so the
  // talk goes on a little after.
  const talking = on && (busy || now - lastAt < TALK_AFTER_MS);
  // The last write of the record, and whose: what hanging up waits for, so a write still on its way can't land after.
  const wrote = useRef<{ agent: string; done: Promise<void> } | undefined>(undefined);
  const write = useCallback((who: string, isNear: boolean) => {
    const prior = wrote.current?.agent === who ? wrote.current.done : Promise.resolve();
    wrote.current = { agent: who, done: prior.then(() => talkWithYou(who, isNear)) };
  }, []);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (!on) {
      wasBusy.current = false;
      return;
    }
    if (busy) {
      wasBusy.current = true;
      write(agent, near);
      const timer = setInterval(() => write(agent, near), TALK_AGAIN_MS);
      return () => clearInterval(timer);
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    write(agent, near);
  }, [on, agent, near, busy, write]);
  // Leaving the visit, or talking to someone else now: the talk is over, on every page at once, rather than the agent
  // staying on the line with nobody for a while.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new agent is what ends the talk with the last one.
  useEffect(() => {
    if (!on) return;
    return () => {
      const last = wrote.current;
      wrote.current = undefined;
      if (last) void last.done.then(() => hangUp(last.agent));
    };
  }, [on, agent]);
  const talk = useMemo(
    (): Talk | undefined =>
      talking
        ? {
            with: agent,
            ...(near ? {} : { phone: true }),
            started: true,
            until: new Date((busy ? now : lastAt) + TALK_AFTER_MS).toISOString(),
          }
        : undefined,
    [talking, agent, near, busy, now, lastAt],
  );
  return { talk, lines, spoke };
}

/** An agent's body home: out of any meeting room it is visiting, and back from any shared place it went to. */
async function sendHome(who: string): Promise<void> {
  for (const type of ["visit", "whereabouts"]) {
    const res = await fetch(`/api/state/${type}/${encodeURIComponent(who)}`, { method: "DELETE" });
    // Nothing to delete is a body that wasn't there to begin with.
    if (res.status !== 404) await must(Promise.resolve(res), "send it home");
  }
}

/**
 * What a person chose for an agent's body to wear, kept on its body record
 * where the agent's own choice goes; null takes the choice away, back to what
 * suits its role.
 */
const dressAgent = (who: string, wear: string[] | null) => changeBody(who, { wear }, "change what it wears");

/**
 * Any place, by id, as a visitor sees it: its room and everyone in it, asked
 * again when someone comes or goes, and redrawn as it changes.
 */
export function useScene(id: string | null): SceneInfo | null {
  const [scene, setScene] = useState<SceneInfo | null>(null);
  useEffect(() => {
    if (!id) {
      setScene(null);
      return;
    }
    let gone = false;
    // As for the agent's own place (`useRoom`): the latest answer only, and a whole one if one is owed.
    let asked = 0;
    let owed = false;
    let shown: Room = DEFAULT_ROOM;
    /** Ask for the place; `ifDoorsMoved`, only take the answer when its doors aren't where they were. */
    const load = (ifDoorsMoved = false) => {
      const n = ++asked;
      if (!ifDoorsMoved) owed = true;
      const doorsOnly = ifDoorsMoved && !owed;
      return fetch(`/api/ext/builtin:places/scene/${encodeURIComponent(id)}`)
        .then((res) => (res.ok ? (res.json() as Promise<PlaceInfo>) : null))
        .then((body) => {
          if (gone || n !== asked) return;
          owed = false;
          const next = { room: roomOf(body), company: companyOf(body), id, ...areaOf(body), ...recordOfPlace(body) };
          shown = next.room;
          setScene((s) => (doorsOnly && s && sameDoors(s.room.doors, next.room.doors) ? s : steady(s, next)));
        })
        .catch(() => {
          if (!gone && n === asked && !doorsOnly) setScene({ room: DEFAULT_ROOM, company: [], id });
        });
    };
    void load();
    const off = subscribeStateChanges((change) => {
      if (comeOrGone(change.type) || change.type === WEAR_TYPE || change.type === BODY_TYPE) void load();
      else if (drawsModel(shown, change) || facesShow(shown, change.type)) void load();
      // A place made, gone, or moved to another area elsewhere may add or take away a door here.
      if (
        change.type === "place" &&
        change.id !== id &&
        (change.op !== "update" || change.before?.area !== change.after?.area)
      )
        void load();
      // A door put in or taken out elsewhere may be the way back to here, which shows once both sides are in.
      else if (change.type === "place" && change.id !== id && relinked(change)) void load(true);
      if (change.type !== "place" || change.id !== id) return;
      if (change.op === "delete" || !change.after || resized(change)) void load();
      else {
        const next = withModels(change.after as unknown as Room, shown);
        shown = next.room;
        setScene((s) =>
          s
            ? {
                ...s,
                // A meeting room's purpose is its room's until its members give it one: still lent, if the record has none.
                room: { ...lentTo(next.room, s), doors: doorsAsSaved(s.room.doors, change.after) },
                version: change.version,
              }
            : s,
        );
        void load(!next.missing);
      }
    });
    return () => {
      gone = true;
      off();
    };
  }, [id]);
  return scene;
}

/**
 * How a body chose to look and carry itself, as the server sends it beside
 * the rest, for the stage: its spot to stay at only when that is in the place
 * it is in (`place`).
 */
export function looksIn(info: Partial<BodyLooks> | null | undefined, place: string | undefined): BodyLooks {
  if (!info) return {};
  const { color, colorName, model, avatar, size, idle, posture, walk, errands, spot } = info;
  return {
    ...(color ? { color } : {}),
    ...(colorName ? { colorName } : {}),
    ...(model ? { model } : {}),
    ...(model && avatar ? { avatar } : {}),
    ...(size ? { size } : {}),
    ...(idle ? { idle } : {}),
    ...(posture ? { posture } : {}),
    ...(walk ? { walk } : {}),
    ...(errands?.length ? { errands } : {}),
    ...(spot && place && spot.place === place ? { spot } : {}),
  };
}

/** What the server says about the place an agent is in. */
export interface PlaceInfo extends Omit<BodyLooks, "wear"> {
  id?: string;
  place?: Room;
  /** Everyone else in it. */
  company?: ({
    agent: string;
    name?: string;
    avatar?: string;
    animations?: string[];
    role?: string;
    wear?: string[];
  } & Omit<BodyLooks, "wear" | "avatar">)[];
  /** Its doors to other places. */
  doors?: RoomDoor[];
  /** The area it is in, by id. */
  area?: string;
  /** Asked for an agent's own place: what the agent is, in a word, and what it wears. */
  role?: string;
  wear?: string[];
  /** The record's version, 0 while it is drawn fresh, and its scope: what a person rearranging it writes with. */
  version?: number;
  scope?: string;
  editable?: boolean;
  lent?: string[];
  /** The models agents made that things in it are, by record id, each face with its component. */
  models?: Record<string, ModelDef>;
}

/**
 * The others in the place, as the stage takes them: each with how it chose
 * to look and carry itself, its body file the model it chose if it chose one.
 * Anyone without a body file is left out.
 */
export function companyOf(info: PlaceInfo | null | undefined): Companion[] {
  return (info?.company ?? []).flatMap((c) => {
    if (!c.avatar) return [];
    const looks = looksIn({ ...c, avatar: undefined }, info?.id);
    return [
      {
        agent: c.agent,
        name: c.name ?? c.agent,
        url: c.avatar,
        animations: c.animations ?? [],
        ...(c.wear?.length ? { wear: c.wear } : {}),
        ...(Object.keys(looks).length ? { looks } : {}),
      },
    ];
  });
}

/**
 * What can be open in the world, one at a time, each beside what it is about
 * (`anchors.ts`). A task opened from the list goes back to it. `at` is the
 * thing in the room it was opened from, a board, a kiosk, a screen or a
 * calendar, which it is kept beside, as is whatever it opens in turn.
 */
type Panel =
  | { kind: "map" }
  | { kind: "tasks"; at?: string }
  | { kind: "task"; id: string; fromList?: boolean; at?: string }
  | { kind: "agent"; agent: string }
  | { kind: "place" }
  | { kind: "new-task"; at?: string }
  | { kind: "new-room"; at?: string }
  | { kind: "needs" }
  | { kind: "need"; agent: string; fromList?: boolean }
  | { kind: "dashboard"; focus?: string; at?: string }
  /** A calendar's full list: one agent's, those of whoever is in the place it hangs in, or everyone's. */
  | { kind: "calendar"; who?: string; here?: true; at?: string };

/** The thing in the room a panel was opened from, as a field to pass on to what it opens next. */
const atOf = (panel: Panel | null): { at?: string } => (panel && "at" in panel && panel.at ? { at: panel.at } : {});

/** How a panel looks for what it is beside: a card by a body, pinned beside a thing, on the plaque, held, docked. */
function lookOf(anchor: Anchor): string {
  if ("agent" in anchor) return "card";
  if ("thing" in anchor) return "pinned";
  if ("plaque" in anchor) return "plaque";
  if ("you" in anchor) return "card";
  return anchor.held === "dock" ? "dock" : "held";
}

/**
 * Your conversation in the world, as the chat page draws it, for the panel
 * the scene keeps beside whoever you talk to. The page draws it after the
 * scene is worked out, as it needs what the scene says (on the phone or not,
 * a spoken turn in progress), and hands it in round the stage.
 */
export const TalkSlot = createContext<ReactNode>(null);

function TalkInSlot() {
  return <>{useContext(TalkSlot)}</>;
}

interface LiveInfo {
  enabled?: boolean;
  avatar?: string;
  animations?: string[];
}

export interface ChatStageOptions {
  /** The agent the conversation on the page is with; "" is the default agent. */
  agent: string;
  /** The conversation on the page; undefined for a new chat. */
  sessionKey: string | undefined;
  /** A typed turn is in flight. */
  sending: boolean;
  /** The chat panel is open over the scene. */
  panelOpen: boolean;
  /** Pixels of the scene's top and bottom the page covers: its toolbar, and on a phone the chat. */
  covered?: { top: number; bottom: number };
  /** A spoken turn finished in this conversation: show it with the rest. */
  onSpoken: (conversation: string | undefined, sessionKey: string) => void;
  /** Hand typed turns the body and a place for their cues, while the body is on screen. */
  setTurnExtras?: (extras: { body?: unknown; onCue?: (cue: { name: string; target?: string }) => void }) => void;
  /** Say when a spoken turn is on its way and when it is done, so switching agents waits for it. */
  setSpeaking?: (speaking: boolean) => void;
  /**
   * Talk to another agent instead: clicked on in the room, stood next to, or
   * gone to. Going to an agent's home is going to talk to it; coming back to
   * the agent you came from is talking to it again.
   */
  onChatWith?: (agent: string) => void;
  /** Start a new chat with an agent, a message already written for the person to send. */
  onDraft?: (agent: string, text: string) => void;
  /**
   * Answer a question an agent asked, a message already started: in the
   * conversation it asked in (`session`) when that is one of yours with it,
   * otherwise your chat with it.
   */
  onReply?: (agent: string, session: string | undefined, text: string) => void;
  /** The approval requests the chat on this page holds, its approval panel showing them. */
  chatApprovals?: string[];
  /** Put the chat on screen. */
  onShowChat?: () => void;
  /** What you last said in the conversation on the page, and its answer once there is one (`lastExchange`). */
  exchange?: { said?: string; reply?: string };
  /** The page draws your conversation in the world (`TalkSlot`): the scene keeps it beside whoever you talk to. */
  dialogue?: boolean;
  /** In a meeting room, the room's own conversation is being read, rather than yours with one of its members. */
  readingRoom?: boolean;
}

export function useChatStage({
  agent,
  sessionKey,
  sending,
  panelOpen,
  covered,
  onSpoken,
  setTurnExtras,
  setSpeaking,
  onChatWith,
  onDraft,
  onReply,
  chatApprovals,
  onShowChat,
  exchange,
  dialogue = false,
  readingRoom = false,
}: ChatStageOptions) {
  // Visiting a place in your own body, walking or flying; null is the agent's own view.
  const [visiting, setVisitingTo] = useState<string | null>(null);
  // The place you came from, when you came through a door: you stand just inside the door back to it.
  const [cameFrom, setCameFrom] = useState<string | undefined>(undefined);
  // The places you came through by doors agents and people put in, for the trail: kept for the place you came to
  // (`at`), so going anywhere any other way leaves them behind.
  const [through, setThrough] = useState<{ at: string; hops: string[] }>(NO_THROUGH);
  /**
   * Go somewhere: by the map (to its start), or through a door from `from`.
   * Only a door someone put in, or going back the way you came by one, says
   * the way you came (`way`): any other way there starts the trail afresh.
   */
  const setVisiting = useCallback((id: string | null, from?: string, way?: { at: string; hops: string[] }) => {
    setCameFrom(from);
    setThrough(way ?? NO_THROUGH);
    setVisitingTo(id);
  }, []);
  // Whose own view the scene shows: the agent you talk to, until you go visiting. Then it stays the agent you
  // came from, whoever you talk to on the way, so "Back to" knows where back is.
  const [home, setHome] = useState(agent);
  const away = useRef(visiting);
  away.current = visiting;
  useEffect(() => {
    if (!away.current) setHome(agent);
  }, [agent]);

  const [info, setInfo] = useState<LiveInfo>({});
  useEffect(() => {
    let gone = false;
    fetch(`/api/live${home ? `?agent=${encodeURIComponent(home)}` : ""}`)
      .then((res) => (res.ok ? (res.json() as Promise<LiveInfo>) : {}))
      .then((body) => {
        if (!gone) setInfo(body ?? {});
      })
      .catch(() => {
        if (!gone) setInfo({});
      });
    return () => {
      gone = true;
    };
  }, [home]);

  const [stageOn, setStageOn] = useState(() => saved(STAGE_KEY, true));
  const has3d = typeof info.avatar === "string";
  const showStage = has3d && stageOn;
  // Where each body last went, and came from, while the world is shown: it walks out by the door to where it went,
  // and in by the door from where it was, when the room has one (a door someone put in, perhaps), rather than by the
  // room's first door.
  const [moves, setMoves] = useState<Record<string, BodyMove>>({});
  useEffect(() => {
    if (!showStage) return;
    return subscribeStateChanges((change) => {
      const move = moveOf(change);
      if (move) setMoves((m) => ({ ...m, [change.id]: move }));
    });
  }, [showStage]);
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 720px)").matches ?? true);
  useEffect(() => {
    const q = window.matchMedia?.("(min-width: 720px)");
    if (!q) return;
    const on = () => setWide(q.matches);
    q.addEventListener?.("change", on);
    return () => q.removeEventListener?.("change", on);
  }, []);

  const own = useRoom(home, has3d);
  // What is open over the stage, one thing at a time: the map, a task, the task list, an agent, a form.
  const [panel, setPanel] = useState<Panel | null>(null);
  const mapOpen = panel?.kind === "map";
  const closePanel = useCallback(() => setPanel(null), []);
  const [listView, setListView] = useState<ListView>({ filter: "open", who: undefined });
  const [near, setNear] = useState<string | undefined>(undefined);
  const visited = useScene(visiting);
  // What is on screen: the place you are going to once it has come, and until then the one you are in, so a door
  // or the map never shows a room that isn't there yet.
  const loading = !!visiting && visited?.id !== visiting;
  const last = useRef<{ visiting: string | null; scene: SceneInfo }>({ visiting: null, scene: own });
  const showing = loading ? last.current : { visiting, scene: visiting ? (visited as SceneInfo) : own };
  last.current = showing;
  const { company, id: placeId } = showing.scene;
  // Rearranging the place on screen yourself (`RoomEditor.tsx`): anywhere the server says a person may, once it has
  // come. What you just saved shows until the page hears of it, so it never jumps back while the word goes round.
  const sceneNow = showing.scene;
  const editable = useMemo(
    (): EditablePlace | undefined =>
      sceneNow.id && sceneNow.editable && sceneNow.version !== undefined && sceneNow.scope && !loading
        ? {
            id: sceneNow.id,
            room: sceneNow.room,
            version: sceneNow.version,
            scope: sceneNow.scope,
            ...(sceneNow.lent ? { lent: sceneNow.lent } : {}),
          }
        : undefined,
    [sceneNow.id, sceneNow.editable, sceneNow.version, sceneNow.scope, sceneNow.lent, sceneNow.room, loading],
  );
  // The map says where you are, for the trail over the stage, and where an agent's body is, for its card and for
  // going to it from what needs you. Opening any of them asks again, for anything new nobody moved to tell it about.
  // Rearranging a room, it says where a door can lead.
  const map = useWorldMap(
    showStage,
    mapOpen || panel?.kind === "agent" || panel?.kind === "needs" || panel?.kind === "calendar",
  );
  // What the editor offers a widget to show: the rooms on the map and the Board's widgets, known further down.
  const editorHas = useRef<{ rooms?: string[]; widgets?: { id: string; title?: string }[] }>({});
  const editor = useRoomEditor(editable, () => editorHas.current, map.places);
  const room = editor.room ?? sceneNow.room;
  // How tall the bar over the stage's foot is while rearranging, for framing the room above it.
  const dock = useRef<HTMLDivElement>(null);
  const [dockTall, setDockTall] = useState(0);
  useEffect(() => {
    const el = dock.current;
    setDockTall(0);
    if (!editor.editing || !el) return;
    // Only ever taller while you rearrange: a longer notice for a moment doesn't nudge the room up and down.
    const measure = () => setDockTall((was) => Math.max(was, Math.round(el.getBoundingClientRect().height)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [editor.editing]);
  // The colour each agent's body is drawn in, as its dot is: the one it chose, or the one its name gives it. Its card
  // and your conversation with it are edged in it.
  const colorOf = useAgentColor();
  // Whether the stage is too narrow for panels beside anything, as the stage itself measures it: they are sheets
  // along its foot. A guess from the screen until it is on screen to say.
  const [sheets, setSheets] = useState(!wide);
  // The stage is on screen, and has been since this view of it came: your conversation is in it then. One that
  // couldn't be shown leaves the chat beside it as the only place to talk.
  const [stageUp, setStageUp] = useState(false);
  const [stageFailed, setStageFailed] = useState(false);
  useEffect(() => {
    if (showStage) return;
    setStageUp(false);
    setStageFailed(false);
  }, [showStage]);
  const onShown = useCallback((up: boolean) => {
    // Taken down only to be built again (another agent, a visit): it is as good as up meanwhile, so the box to type
    // in doesn't hop between the world and the chat's column while the next one loads.
    if (up) {
      setStageUp(true);
      setStageFailed(false);
    }
  }, []);
  const onProblem = useCallback(() => {
    setStageUp(false);
    setStageFailed(true);
  }, []);
  // On a phone the catalogue is a sheet over the foot of the scene, where the bar would be: one at a time.
  const sheet = editor.adding && sheets;
  const hops = through.at && through.at === placeId ? through.hops : NO_HOPS;
  const trail = useMemo(
    () => trailThrough(placeId, hops, map.places, map.areas),
    [placeId, hops, map.places, map.areas],
  );
  const [voicesOn, setVoicesOn] = useState(() => saved(VOICES_KEY, false));
  const hearLine = useVoicesNearby(voicesOn && !!visiting);
  const board = useBoardTasks(showStage);
  const allTasks = board.tasks;
  // A note moved to another column on a board in the room: saved as its card saves it, and put on every board.
  const { put: putTask, reload: reloadTasks } = board;
  const moveTask = useCallback(
    async (id: string, change: TaskMove) => {
      putTask(await updateProjectTask(id, change));
      reloadTasks();
    },
    [putTask, reloadTasks],
  );
  const watcher = useTaskWatcher(
    showStage &&
      (panel?.kind === "task" || panel?.kind === "new-task" || panel?.kind === "tasks" || panel?.kind === "agent"),
  );
  // A new place is a new stage, which says who you are next to from scratch: nobody, until you walk up to someone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: arriving anywhere is what clears it.
  useEffect(() => {
    setNear(undefined);
  }, [visiting]);
  const doings = useRecords<AgentActivity>("activity", showStage);
  // What every agent's day has it doing while it has nothing else to (`routines.ts`): out on an errand, or asleep for
  // the night; and what each room said last, for its whiteboard and its door.
  const outings = useRecords<Outing>("visit", showStage);
  const chatter = useRecords<Chatter>("chatter", showStage);
  const today = useMinute(showStage);
  const chosenColors = useChosenColors();
  // What every agent is doing as the world shows it: a question on a task answered (here, or on the Tasks page) is
  // done with, and one still waiting on you is, whatever became of the turn that asked it.
  const activities = useMemo(() => withQuestions(doings, allTasks), [doings, allTasks]);
  const approvals = usePendingApprovals(showStage, requestsOf(doings), panel?.kind === "need");
  // Everything waiting on you, for the "Needs you" list and each agent's card.
  const needs = useMemo(() => needsFrom(activities, approvals.list, allTasks), [activities, approvals.list, allTasks]);
  const speech = useRecords<Said>("speech", showStage);
  // The gesture each agent is making: its body here makes it.
  const emotes = useRecords<EmoteRecord>(EMOTE_TYPE, showStage, true);
  const { online, names: agentNames, placeless: cantPlace } = useAgentRoster(showStage);
  const canPlace = useCallback((who: string) => !cantPlace.has(who), [cantPlace]);
  // What agents just did to the room on screen shows over their heads, like something they said.
  const said = useMemo(() => withChangeLines(speech, room.changes), [speech, room.changes]);
  const askRoom = useCallback(
    (who: string) => {
      setPanel(null);
      onDraft?.(who, ROOM_ASK);
    },
    [onDraft],
  );
  const shown = home || "default";
  const talking = agent || "default";
  // Where you are says who you talk to: an agent's own home is a conversation with it, and coming back to the
  // agent you came from is one with it again. Anywhere else, the conversation you had goes on. Through a door or
  // by the map, arriving is the same.
  const host = visiting ? (visiting.startsWith("home:") ? visiting.slice("home:".length) : undefined) : shown;
  // Talking to someone is your conversation with them: a card steps aside for it, beside them or on the phone.
  // Arriving at an agent's home to see to what it waits on keeps that card open: it is what you came for.
  const chatWith = useCallback(
    (who: string, arriving = false) => {
      setPanel((open) => (open && open.kind !== "map" && !(arriving && open.kind === "need") ? null : open));
      onChatWith?.(who);
    },
    [onChatWith],
  );
  // On every arrival, even at the agent you are talking to already: that calls off a switch still waiting for a
  // reply, so coming back before it is done keeps you where you came back to.
  const arrived = useRef(host);
  // biome-ignore lint/correctness/useExhaustiveDependencies: arriving decides; who you talk to there is yours to change.
  useEffect(() => {
    if (host === arrived.current) return;
    arrived.current = host;
    if (host) chatWith(host, true);
  }, [host]);
  // What clicking an agent's body offers: talk to it, send it home from a shared place or its day out, pause or wake
  // it. One waiting on you opens what it waits on instead (`onBody`); one busy with something else that still has a
  // question on a task for you offers it first.
  const menuFor = useCallback(
    (who: string): AgentAction[] => {
      const actions: AgentAction[] = [];
      if (needs.some((n) => n.agent === who))
        actions.push({ label: "What it needs from you", run: () => setPanel({ kind: "need", agent: who }) });
      if (who !== talking && onChatWith) actions.push({ label: `Chat with ${who}`, run: () => chatWith(who) });
      // Gone to a shared place, to a meeting room to talk, or out here on its day (`routines.ts`): home is where it
      // goes back to, and stays until that outing would have ended.
      const out = outingNow(outings[who], Date.now());
      const outHere = !!out && out.place === placeId && out.errand !== "sleep";
      if (placeId?.startsWith("shared:") || placeId?.startsWith("room:") || outHere)
        actions.push({
          label: who === shown ? "Go home" : "Send home",
          run: () => sendHome(who),
        });
      if (online.has(who)) {
        const resting = activities[who]?.doing === "asleep" && activities[who]?.detail !== "agents are paused";
        actions.push(
          resting
            ? {
                label: "Wake up",
                run: () =>
                  must(
                    fetch(`/api/exploratory/agents/${encodeURIComponent(who)}/resume`, { method: "POST" }),
                    "wake it",
                  ),
              }
            : {
                label: "Pause for 4 hours",
                run: () =>
                  must(
                    fetch(`/api/exploratory/agents/${encodeURIComponent(who)}/pause`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ hours: 4 }),
                    }),
                    "pause it",
                  ),
              },
        );
      }
      // Everything else about it, without leaving the world; its page is a link in there.
      actions.push({
        label: who === "default" ? "About the default agent" : `About ${who}`,
        run: () => setPanel({ kind: "agent", agent: who }),
      });
      return actions;
    },
    [shown, talking, onChatWith, chatWith, placeId, online, activities, needs, outings],
  );
  // A click on an agent waiting on you opens what it waits on, rather than the menu.
  const onBody = useCallback(
    (who: string) => {
      if (activities[who]?.doing !== "waiting") return false;
      setPanel({ kind: "need", agent: who });
      return true;
    },
    [activities],
  );
  // What the body can do in this room: its moves, the things it can go to, look at and point at, and who is with it.
  // Always the agent's own place: its cues move its own body, which a visit doesn't change.
  const body = useMemo(
    () =>
      bodyFor(
        own.room,
        own.company.map((c) => c.name),
      ),
    [own.room, own.company],
  );

  const controls = useRef<AvatarControls | null>(null);
  // Where each body last was other than out in the town: one that comes out walks from that door to its seat.
  const lastIn = useRef(new Map<string, string>());
  for (const p of map.places) if (p.id !== "town") for (const a of p.agents) lastIn.current.set(a, p.id);
  const townCompany = useMemo((): Companion[] => {
    const plan = map.town;
    if (placeId !== "town" || !plan) return company;
    return company.map((c) => {
      const from = doorInTown(plan, lastIn.current.get(c.agent) ?? `home:${c.agent || "default"}`);
      return from ? { ...c, from } : c;
    });
  }, [company, placeId, map.town]);
  // And one that goes walks to the door of where it went, its home when the map hasn't heard yet.
  const mapRef = useRef(map);
  mapRef.current = map;
  const exitFor = useCallback((agent: string) => {
    const { places, town } = mapRef.current;
    if (!town) return undefined;
    const now = places.find((p) => p.agents.includes(agent))?.id;
    return doorInTown(town, now && now !== "town" ? now : `home:${agent || "default"}`);
  }, []);
  // Who is in each building, for its windows; when each room last talked, for the card on its door; and in a meeting
  // room, what its room said last, for its whiteboard.
  const inside = useMemo(() => (map.town ? [...occupiedBy(map.places, map.town)].sort() : undefined), [map]);
  const talked = useMemo(() => talkedAt(chatter, map.places), [chatter, map.places]);
  const notes = useMemo(() => {
    if (!placeId?.startsWith("room:")) return undefined;
    const name = map.places.find((p) => p.id === placeId)?.name ?? room.name ?? "";
    // Talked when its door says it did, so the board and the door agree.
    return notesFrom(chatter[placeId] as Chatter | undefined, name, today, chosenColors, talked[placeId]);
  }, [placeId, chatter, map.places, room.name, today, chosenColors, talked]);
  // Out in the town, bodies going from one place to another walk the streets: each time the map hears that someone
  // went somewhere, from the door of where they were to the door of where they went.
  const whereWas = useRef<Map<string, string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new map is what says someone moved; the rest is read as it is then.
  useEffect(() => {
    const now = new Map(map.places.flatMap((p) => p.agents.map((a): [string, string] => [a, p.id])));
    const was = whereWas.current;
    whereWas.current = now;
    if (!was || placeId !== "town" || !isOutdoors(room)) return;
    for (const trip of tripsBetween(was, now, room.town)) {
      // Its home on the map says how its owner chose to look: in the street as in any room.
      const home = map.places.find((p) => p.kind === "home" && p.owner === trip.agent);
      const wear = home?.wear;
      fetch(`/api/live${trip.agent === "default" ? "" : `?agent=${encodeURIComponent(trip.agent)}`}`)
        .then((res) => (res.ok ? (res.json() as Promise<LiveInfo>) : null))
        .then((body) => {
          if (!body?.avatar) return;
          controls.current?.walkBy({
            agent: trip.agent,
            name: nameOf(trip.agent),
            url: home?.model ? `/api/live/avatar?model=${encodeURIComponent(home.model)}` : body.avatar,
            animations: body.animations ?? [],
            ...(wear ? { wear } : {}),
            ...(home ? { looks: home } : {}),
            from: trip.from,
            to: trip.to,
          });
        })
        .catch(() => {});
    }
  }, [map.places]);
  // The conversation a voice session talks in. A new chat gets a key on its
  // first spoken turn; the chat adopts it, so what is typed next joins it.
  const minted = useRef<{ agent: string; key: string } | null>(null);
  const inUse = useRef<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [replying, setReplying] = useState("");
  const keyFor = () => {
    // A key made for one agent's new chat is never another's.
    if (!sessionKey && minted.current?.agent !== agent) minted.current = { agent, key: newChatKey(agent) };
    const key = sessionKey ?? (minted.current as { key: string }).key;
    inUse.current = key;
    return key;
  };

  // What you and the agent say out loud, for the bubbles on a visit: filled in below, once your talk with it is known.
  const spokeRef = useRef<(who: "you" | "agent", text: string, voiced?: boolean) => void>(() => {});
  const voice = useVoice({
    agent: agent || undefined,
    sessionKey: keyFor,
    body: showStage && !visiting ? body : undefined,
    measure: showStage,
    onCue: (cue) => controls.current?.cue(cue),
    onHeard: (text) => {
      setHeard(text || null);
      setReplying("");
      spokeRef.current("you", text);
    },
    onText: (delta) => setReplying((r) => r + delta),
    onDone: (turn) => {
      // The conversation the turn was spoken in. None when the page has gone on to another one since: the turn
      // is saved in its own, and the page stays where the person took it.
      const key = inUse.current;
      setHeard(null);
      setReplying("");
      // Played already, sentence by sentence: a bubble, but not to be voiced again by voices nearby.
      spokeRef.current("agent", turn.reply, true);
      if (turn.transcript && key) onSpoken(turn.conversation, key);
    },
  });

  // Typed turns move the body too, while it is on screen: same cues as talking.
  useEffect(() => {
    if (!setTurnExtras) return;
    // On a visit the body on screen is yours: the agent's cues have nothing to move.
    setTurnExtras(showStage && !visiting ? { body, onCue: (cue) => controls.current?.cue(cue) } : {});
    return () => setTurnExtras({});
  }, [showStage, setTurnExtras, body, visiting]);

  // A spoken turn is a reply on its way too: going to another agent waits for it.
  useEffect(() => {
    setSpeaking?.(voice.phase !== "idle");
  }, [voice.phase, setSpeaking]);
  useEffect(() => () => setSpeaking?.(false), [setSpeaking]);

  // Another conversation on the page, or a new chat: the voice session is for the old one.
  const end = voice.end;
  useEffect(() => {
    if (sessionKey === undefined) {
      minted.current = null;
      if (inUse.current) end();
      inUse.current = null;
    } else if (inUse.current && sessionKey !== inUse.current) {
      end();
      inUse.current = null;
    }
  }, [sessionKey, end]);

  // M opens the map, unless the person is typing, or rearranging the room.
  useEffect(() => {
    if (!showStage || editor.editing) return;
    const toggle = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");
      if (e.code !== "KeyM" || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // The map's search takes the focus as it opens: the M that opened it isn't typed into it.
      e.preventDefault();
      setPanel((open) => (open?.kind === "map" ? null : { kind: "map" }));
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [showStage, editor.editing]);

  // Space to talk, like a walkie-talkie, unless the person is typing, or pressing a button in a panel or on a surface
  // in the room. A button in your conversation in the world isn't one of those: Space there talks, as it did on the
  // chat's own buttons.
  const { hold, release } = voice;
  // Whether Space started talking. Letting it go ends that wherever the key comes up: clicking a body while
  // holding it puts the focus in that body's menu, which would otherwise keep the microphone open, and the key
  // coming up there isn't a press of the menu's first button. A ref, so it outlasts the listeners being redone.
  const bySpace = useRef(false);
  useEffect(() => {
    if (!info.enabled) return;
    const typing = (e: KeyboardEvent) =>
      (e.target as HTMLElement | null)?.closest?.(
        "input, textarea, select, [contenteditable='true'], [role='dialog'], .world-surface",
      );
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !typing(e)) {
        e.preventDefault();
        bySpace.current = true;
        void hold();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !bySpace.current) return;
      bySpace.current = false;
      e.preventDefault();
      release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [info.enabled, hold, release]);

  // Talking or typing keeps the conversation going for a while after.
  const busy = voice.active || sending || voice.phase !== "idle";
  const [conversing, setConversing] = useState(false);
  useEffect(() => {
    if (busy) {
      setConversing(true);
      return;
    }
    const quiet = setTimeout(() => setConversing(false), CONVERSING_MS);
    return () => clearTimeout(quiet);
  }, [busy]);

  // Who is talking with whom, face to face or on the phone: the places plugin's records, and your own talk with the
  // agent the chat is with while you visit, which only this page knows. Talks that have run out are let go as time
  // goes by.
  const talkRecords = useRecords<Talk>("talk", showStage);
  const now = useNow(showStage && (busy || conversing || Object.keys(talkRecords).length > 0), TALK_TICK_MS);
  const you = useTalkWithYou({
    on: showStage && !!showing.visiting,
    agent: talking,
    near: !!showing.visiting && company.some((c) => c.agent === talking),
    sending,
    busy,
    exchange: exchange ?? {},
    now,
  });
  spokeRef.current = you.spoke;
  const talks = useMemo(() => (you.talk ? { ...talkRecords, [YOU]: you.talk } : talkRecords), [talkRecords, you.talk]);
  // What every agent is doing as the world shows it, talks and days and all: on the map, on a card.
  const shownActivities = useMemo(
    () => withRoutines(withTalks(activities, talks, now), outings, today),
    [activities, talks, now, outings, today],
  );
  // And on the bodies here, each out at its seat with its company. On its own page, the agent you talk to is with
  // you, whatever its day says, unless it is asleep for the night.
  const stageActivities = useMemo(() => {
    const talking = withTalks(activities, talks, now);
    const all = withRoutines(talking, outings, today, placeId ?? undefined);
    const mine = all[shown];
    if (showing.visiting || !mine?.routine || mine.routine.errand === "sleep") return all;
    const { [shown]: _, ...rest } = all;
    return talking[shown] ? { ...rest, [shown]: talking[shown] } : rest;
  }, [activities, talks, now, outings, today, placeId, shown, showing.visiting]);
  const saidAll = useMemo(() => newest(said, you.lines), [said, you.lines]);

  // A quiet moment, while the page is in view: the agent chooses what it does.
  const chooseIdle = useCallback(
    async (here: string | undefined, hour: number): Promise<Cue[]> => {
      if (document.visibilityState === "hidden") return [];
      const res = await fetch("/api/live/idle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(home ? { agent: home } : {}), body, here, hour }),
      });
      if (!res.ok) throw new Error(`idle choice failed (${res.status})`);
      const data = (await res.json()) as { cues?: Cue[] };
      return Array.isArray(data.cues) ? data.cues : [];
    },
    [home, body],
  );

  const state: BodyState = voice.phase !== "idle" ? voice.phase : sending ? "thinking" : "idle";
  // Who is in the place: on the agent's own view, the agent too.
  const here = useMemo(
    () => [...(showing.visiting ? [] : [shown]), ...company.map((c) => c.agent)],
    [showing.visiting, shown, company],
  );
  // The boards show the tasks of whoever is in the place.
  const boardTasks = useMemo(() => tasksFor(placeId, here, allTasks), [placeId, here, allTasks]);
  // The screens and calendars here: nothing is asked for that no wall shows, or no panel open needs.
  const owner = placeId?.startsWith("home:") ? placeId.slice("home:".length) : undefined;
  // What the things here show (`faceOf`): a screen, a calendar, a clock, or any of them on a display stand.
  const faces = useMemo(() => facesIn(room.props), [room.props]);
  const hasScreen = faces.some((f) => f.face === "dashboard" && !f.arg);
  // A screen kept to one of the Board's widgets needs the Board's widgets wherever it is, a home too.
  const pinsWidget = faces.some((f) => f.face === "dashboard" && !!f.arg);
  const hasCalendar = faces.some((f) => f.face === "calendar");
  const hasAgenda = faces.some((f) => f.face === "agenda");
  const dashboard = useDashboard(showStage && ((hasScreen && !owner) || pinsWidget || panel?.kind === "dashboard"));
  const wakes = useWakes(showStage && (hasCalendar || hasScreen || hasAgenda || panel?.kind === "calendar"));
  const minute = useMinute(
    showStage && (hasCalendar || hasScreen || hasAgenda || faces.length > 0 || panel?.kind === "calendar"),
  );
  // Pausing is for every agent at once, so one asleep because agents are paused means they all are: nothing on a
  // calendar wakes until they are resumed.
  const paused = useMemo(() => Object.values(activities).some((a) => a.detail === "agents are paused"), [activities]);
  const done = useMemo(() => doneToday(allTasks, activities, minute), [allTasks, activities, minute]);
  // A screen in a home goes through what its owner is up to; anywhere else, the dashboard's first few widgets.
  const screenCards = useMemo((): ScreenCard[] | undefined => {
    if (!hasScreen) return undefined;
    if (owner)
      return homeCards(owner, {
        activity: shownActivities[owner],
        tasks: allTasks,
        coming: (wakes ?? [])
          .filter((w) => w.agent === owner)
          .slice(0, 6)
          .map((w) => ({ when: wakeWhen(w.at, minute), what: w.what })),
        now: minute,
      });
    return dashboardCards(dashboard, minute);
  }, [hasScreen, owner, shownActivities, allTasks, wakes, minute, dashboard]);
  // Whose wakes a calendar shows outside a home and the common places: whoever is there. Its full list opens on them too.
  const among = useMemo(() => (owner || isCommon(placeId) ? undefined : here), [owner, placeId, here]);
  // A calendar in a home is its owner's day; on the square and in the lobby, everyone's next wakes; elsewhere, those of
  // whoever is there.
  const calendarView = useMemo((): CalendarView | undefined => {
    if (!hasCalendar) return undefined;
    const lobby = isCommon(placeId);
    const whose = owner ? [owner] : here;
    return {
      title: owner ? `${nameOf(owner)}'s day` : lobby ? "Everyone's next wakes" : "Next wakes for who's here",
      now: minute,
      wakes: wakesFor(placeId, here, wakes ?? []),
      done: lobby ? [] : done.filter((d) => whose.includes(d.agent)),
      names: !owner,
      ...(paused ? { note: PAUSED_NOTE } : {}),
      // Read close up, its month shows what got done on the days gone by: since the start of last month.
      history: doneBetween(allTasks, dayStart(minute - 40 * 86_400_000), minute + 86_400_000).filter(
        (d) => lobby || whose.includes(d.agent),
      ),
    };
  }, [hasCalendar, placeId, owner, here, minute, wakes, done, paused, allTasks]);
  editorHas.current = {
    rooms: map.places.filter((p) => p.kind === "room").map((p) => p.name),
    widgets: dashboard.widgets,
  };
  // The widgets here (a status board, a feed, a chart, a ticker…): what they show, fetched once for all of them.
  const widgetFeeds = useWidgetFeeds({ enabled: showStage, props: room.props, placeId, places: map.places, speech });
  const world = useMemo(
    (): WorldData | undefined =>
      faces.length
        ? {
            activities: shownActivities,
            agents: ["default", ...agentNames.filter((a) => a !== "default")],
            needs,
            feed: widgetFeeds.feed,
            stats: widgetFeeds.stats,
            photos: widgetFeeds.photos,
            ticker: widgetFeeds.ticker,
            wakes: wakes ?? [],
            done,
            ...(whoseIn(placeId, here, map.places) ? { whose: whoseIn(placeId, here, map.places) } : {}),
            ...(owner ? { owner } : {}),
            tasks: allTasks,
            projects: widgetFeeds.projects,
            now: minute,
          }
        : undefined,
    [
      faces.length,
      shownActivities,
      agentNames,
      needs,
      widgetFeeds,
      wakes,
      done,
      placeId,
      here,
      map.places,
      owner,
      allTasks,
      minute,
    ],
  );
  // Approved or denied from a needs-you board: as the card answers it, the agent's turn going on at once. Whatever face
  // asks, nothing with a stricter flow of its own, or whose details the page doesn't have, is approved from here: the
  // card's rule, kept where every face's answer goes through.
  const approve = useCallback(async (need: Need, approved: boolean) => {
    if (!need.request) throw new Error("There's no request to answer.");
    if (approved && !answerable(need)) throw new Error("This one is approved in the chat that asked for it.");
    try {
      await resolveApproval(need.request, approved);
    } catch (err) {
      // Gone from the server: answered already, in another tab, the chat or Discord.
      if (err instanceof Error && /^404\b/.test(err.message)) throw new Error(ANSWERED_ELSEWHERE);
      throw err;
    }
  }, []);
  // Going to an agent's body, for the status board: the function is made further down, each time the page draws.
  const goSeeRef = useRef<(who: string) => boolean>(() => false);
  // What the kiosks (the lobby's, and the office's directory, which opens the map), the boards, the screens and the
  // calendars do when clicked. A note on a board opens its task; anywhere else on a board opens the list, at that
  // column when it was one, and at the owner's tasks in a home. A screen opens what its page is about; a calendar, its
  // full list; the plaque by the door, the room's card. Each opens beside the thing clicked (`thing`), but an agent's
  // card, which goes by the agent.
  const onUse = useCallback(
    (action: string, on?: UseSpot, thing?: string) => {
      const at = thing ? { at: thing } : {};
      if (action === "screen") {
        const card = on && "card" in on ? on.card : undefined;
        if (!owner) setPanel({ kind: "dashboard", ...(card ? { focus: card } : {}), ...at });
        else if (card === "tasks") {
          setListView({ filter: "open", who: owner });
          setPanel({ kind: "tasks", ...at });
        } else if (card === "next") setPanel({ kind: "calendar", who: owner, ...at });
        else setPanel({ kind: "agent", agent: owner });
        return;
      }
      if (action === "agent" && on && "agent" in on) {
        setPanel({ kind: "agent", agent: on.agent });
        return;
      }
      if (action === "go" && on && "agent" in on) {
        // From the status board: to the agent, standing in front of it, its card open beside it.
        setPanel({ kind: "agent", agent: on.agent });
        goSeeRef.current(on.agent);
        return;
      }
      if (action === "need" && on && "agent" in on) {
        setPanel({ kind: "need", agent: on.agent });
        return;
      }
      if (action === "calendar") {
        // A line about an agent opens that agent's list; anywhere else on it, the list the calendar shows.
        const who = on && "agent" in on ? on.agent : owner;
        setPanel({ kind: "calendar", ...(who ? { who } : !isCommon(placeId) ? { here: true } : {}), ...at });
        return;
      }
      if (action === "tasks") {
        if (on && "task" in on) {
          setPanel({ kind: "task", id: on.task, ...at });
          return;
        }
        setListView({
          filter: on && "column" in on ? on.column : "open",
          who: placeId?.startsWith("home:") ? placeId.slice("home:".length) : undefined,
        });
        setPanel({ kind: "tasks", ...at });
      } else if (action === "new-task") setPanel({ kind: "new-task", ...at });
      else if (action === "new-agent")
        onDraft?.(
          "default",
          "I'd like a new agent. Ask me what it should do and how it should come across, then set it up.",
        );
      else if (action === "new-room") setPanel({ kind: "new-room", ...at });
      else if (action === "map") setPanel({ kind: "map" });
      else if (action === "place") setPanel({ kind: "place" });
    },
    [onDraft, placeId, owner],
  );
  // Through a door: on into the place behind it, in your own body, from wherever you are.
  const onDoor = useCallback(
    (door: RoomDoor) => {
      if (!placeId) return;
      // Through a door someone put in, the trail says the way you came; through the town's own, it starts again.
      setVisiting(door.to, placeId, door.by ? { at: door.to, hops: hopsAfter(hops, placeId, door.to) } : undefined);
      // What was open beside something in the place you leave stays there, as walking away from it puts it away:
      // only the list of what waits on you, held in front of you, comes along.
      setPanel((open) => (open?.kind === "needs" ? open : null));
    },
    [placeId, hops, setVisiting],
  );
  // Homes, shared places and meeting rooms are agents' to change, and the lobby a person's; the town and the office
  // are laid out from what there is.
  const changeable = !!placeId && (/^(home|shared|room):/.test(placeId) || placeId === "lobby");
  // Going somewhere: to the agent you came from is back with it. Out on to the street by a building's door (`from`),
  // you stand outside it.
  const go = (id: string, from?: string) => {
    // Back along the way you came by doors put in, the trail keeps the way to there.
    const back = hops.indexOf(id);
    setVisiting(id === own.id ? null : id, from, back >= 0 ? { at: id, hops: hops.slice(0, back) } : undefined);
    setPanel(null);
  };
  // An agent to stand in front of once in its place, asked for by number so asking again is a new ask. Done with
  // once carried out, or once you go anywhere else first: coming back to that place later isn't another ask.
  const [greet, setGreet] = useState<{ agent: string; place: string; n: number } | null>(null);
  const greets = useRef(0);
  const greeted = useCallback((n: number) => setGreet((g) => (g?.n === n ? null : g)), []);
  useEffect(() => {
    setGreet((g) => (g && g.place !== visiting ? null : g));
  }, [visiting]);
  /**
   * Straight to an agent waiting on you, with what it waits on open: into the
   * place its body is in, standing in front of it. In the agent's own view, or
   * when its body is nowhere, the card alone.
   */
  const seeTo = (who: string, fromList = false) => {
    setPanel({ kind: "need", agent: who, ...(fromList ? { fromList: true } : {}) });
    goSee(who);
  };
  /** Into the place an agent's body is in, standing in front of it. False when its body is nowhere to go to. */
  const goSee = (who: string): boolean => {
    const spot = map.places.find((p) => p.kind !== "lobby" && p.agents.includes(who));
    if (!spot) return false;
    if (spot.id === own.id) {
      // Back to the agent you came from, whose own view has no body of yours to stand anywhere.
      if (visiting) setVisiting(null);
      return true;
    }
    if (spot.id !== placeId) setVisiting(spot.id);
    setGreet({ agent: who, place: spot.id, n: ++greets.current });
    return true;
  };
  goSeeRef.current = goSee;
  const tools = (
    <>
      {needs.length > 0 && (
        <button
          type="button"
          className="talk-tool talk-needs"
          aria-expanded={panel?.kind === "needs"}
          title="What agents are waiting on you for"
          onClick={() => setPanel(panel?.kind === "needs" ? null : { kind: "needs" })}
        >
          Needs you · {needs.length}
        </button>
      )}
      <button
        type="button"
        className="talk-tool"
        aria-expanded={mapOpen}
        title="Every place there is (M)"
        onClick={() => setPanel(mapOpen ? null : { kind: "map" })}
      >
        Map
      </button>
      <button
        type="button"
        className="talk-tool"
        aria-expanded={panel?.kind === "tasks"}
        title="Every task, without leaving the world"
        onClick={() => {
          if (panel?.kind === "tasks") return setPanel(null);
          setListView({ filter: "open", who: undefined });
          setPanel({ kind: "tasks" });
        }}
      >
        Tasks
      </button>
      {changeable && (
        <button
          type="button"
          className="talk-tool"
          aria-expanded={panel?.kind === "place"}
          title="What this place is for, who can change it, and what they changed lately"
          onClick={() => setPanel(panel?.kind === "place" ? null : { kind: "place" })}
        >
          Room
        </button>
      )}
      {editable && (
        <button
          type="button"
          className="talk-tool"
          title="Move, turn, add and take away things in this room yourself"
          onClick={(e) => {
            // The button goes as the edit tools come: the focus it had isn't left on whichever takes its place.
            e.currentTarget.blur();
            setPanel(null);
            editor.start();
          }}
        >
          Edit room
        </button>
      )}
      {visiting && (
        <button type="button" className="talk-tool" onClick={() => setVisiting(null)}>
          Back to {nameOf(shown)}
        </button>
      )}
      {visiting && (
        <button
          type="button"
          className="talk-tool"
          aria-pressed={voicesOn}
          title="Hear what agents say when you're near them"
          onClick={() => {
            setVoicesOn(!voicesOn);
            remember(VOICES_KEY, !voicesOn);
          }}
        >
          {voicesOn ? "Voices on" : "Voices off"}
        </button>
      )}
      {visiting && near && near !== talking && onChatWith && (
        <button type="button" className="talk-tool talk-near" onClick={() => chatWith(near)}>
          Talk to {near}
        </button>
      )}
      {trail.length > 0 && <span className="talk-tools-break" aria-hidden="true" />}
      {trail.length > 0 && (
        <nav className="world-trail" aria-label="Where you are">
          {trail.map((step, i) => (
            <span key={`${i}:${step.id}`} className="world-trail-step">
              {i > 0 && (
                <span className="world-trail-sep" aria-hidden="true">
                  ›
                </span>
              )}
              {step.id === placeId ? (
                <span aria-current={i === trail.length - 1 ? "location" : undefined}>{step.label}</span>
              ) : (
                <button type="button" title={`Go to ${step.label}`} onClick={() => go(step.id, step.from)}>
                  {step.label}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}
    </>
  );
  let overlay: ReactNode;
  if (panel?.kind === "map")
    overlay = (
      <WorldMap
        places={map.places}
        areas={map.areas}
        {...(map.town ? { town: map.town } : {})}
        links={map.links}
        problem={map.problem}
        here={placeId}
        {...(placeId === "town" && controls.current ? { you: controls.current.where() } : {})}
        activities={shownActivities}
        onGo={go}
        onNeed={(who) => seeTo(who)}
        onClose={closePanel}
      />
    );
  else if (panel?.kind === "needs")
    overlay = (
      <NeedsList
        needs={needs}
        whereOf={(who) => whereWords(who, map.places, placeId)}
        onOpen={(need: Need) => seeTo(need.agent, true)}
        onClose={closePanel}
      />
    );
  else if (panel?.kind === "need") {
    const who = panel.agent;
    overlay = (
      <NeedCard
        key={who}
        agent={who}
        needs={needs.filter((n) => n.agent === who)}
        loading={approvals.asked !== requestsOf(doings)}
        failed={approvals.failed}
        onOpenTask={(id) => setPanel({ kind: "task", id })}
        onAnswered={(task) => {
          board.put(task);
          board.reload();
        }}
        {...(onReply
          ? {
              onReply: (text: string, session?: string) => {
                setPanel(null);
                onReply(who, session, text);
              },
            }
          : {})}
        inChat={(request) => !!chatApprovals?.includes(request)}
        {...(onShowChat
          ? {
              onShowChat: () => {
                setPanel(null);
                onShowChat();
              },
            }
          : {})}
        onAbout={() => setPanel({ kind: "agent", agent: who })}
        {...(panel.fromList ? { onBack: () => setPanel({ kind: "needs" }) } : {})}
        onClose={closePanel}
      />
    );
  } else if (panel?.kind === "dashboard")
    overlay = (
      <WorldDashboard
        widgets={dashboard.widgets}
        loaded={dashboard.loaded}
        {...(dashboard.error ? { error: dashboard.error } : {})}
        {...(panel.focus ? { focus: panel.focus } : {})}
        onTask={(id) => setPanel({ kind: "task", id, ...atOf(panel) })}
        onTasks={() => {
          setListView({ filter: "open", who: undefined });
          setPanel({ kind: "tasks", ...atOf(panel) });
        }}
        onClose={closePanel}
      />
    );
  else if (panel?.kind === "calendar")
    overlay = (
      <WorldCalendar
        wakes={wakes ?? []}
        done={done}
        who={panel.here ? (among ?? []) : panel.who}
        {...(among ? { here: among } : {})}
        agents={agentNames}
        {...(paused ? { note: PAUSED_NOTE } : {})}
        loading={wakes === null}
        roomName={(ref) => map.places.find((p) => p.id === `room:${ref}`)?.name}
        onWho={(who) =>
          setPanel({ kind: "calendar", ...(Array.isArray(who) ? { here: true } : who ? { who } : {}), ...atOf(panel) })
        }
        onGo={(who) => {
          // Off to it, where its body is: or its card, when it has no body anywhere to go to.
          if (goSee(who)) setPanel(null);
          else setPanel({ kind: "agent", agent: who });
        }}
        onTask={(id) => setPanel({ kind: "task", id, ...atOf(panel) })}
        onClose={closePanel}
      />
    );
  else if (panel?.kind === "new-task")
    overlay = <NewTask agents={agentNames} wakes={watcher?.created} onMade={board.reload} onClose={closePanel} />;
  else if (panel?.kind === "new-room")
    overlay = (
      <NewRoom
        onAsk={() => {
          setPanel(null);
          onDraft?.("default", NEW_ROOM_ASK);
        }}
        onClose={closePanel}
      />
    );
  else if (panel?.kind === "tasks")
    overlay = (
      <TaskList
        tasks={allTasks}
        total={board.total}
        agents={agentNames}
        view={listView}
        onView={setListView}
        onOpen={(id) => setPanel({ kind: "task", id, fromList: true, ...atOf(panel) })}
        onNew={() => setPanel({ kind: "new-task", ...atOf(panel) })}
        onClose={closePanel}
      />
    );
  else if (panel?.kind === "task")
    overlay = (
      <TaskCard
        key={panel.id}
        id={panel.id}
        agents={agentNames}
        wakes={watcher?.updated}
        onSaved={(task) => {
          board.put(task);
          board.reload();
        }}
        {...(panel.fromList ? { onBack: () => setPanel({ kind: "tasks", ...atOf(panel) }) } : {})}
        onClose={closePanel}
      />
    );
  else if (panel?.kind === "place" && placeId)
    overlay = (
      <WorldPlace
        id={placeId}
        room={room}
        // A meeting room is its members' to change, wherever their bodies are: the map lists them all.
        members={map.places.find((p) => p.id === placeId)?.members ?? []}
        canPlace={canPlace}
        {...(onDraft ? { onAsk: askRoom } : {})}
        onClose={closePanel}
      />
    );
  else if (panel?.kind === "agent") {
    const who = panel.agent;
    // A body is in one place: its home, a shared place, or the meeting room of a room it is talking in.
    const spot = map.places.find((p) => p.kind !== "lobby" && p.agents.includes(who));
    const where = spot && {
      id: spot.id,
      name: spot.kind === "room" ? `#${spot.name}` : spot.name,
      home: spot.id === `home:${who}`,
    };
    // What it is and wears, as the map says of its home.
    const homeOf = map.places.find((p) => p.kind === "home" && p.owner === who);
    overlay = (
      <WorldAgent
        key={who}
        agent={who}
        {...(homeOf?.role ? { role: homeOf.role } : {})}
        {...(homeOf
          ? {
              wear: homeOf.wear ?? [],
              chosen: !!homeOf.wearChosen,
              onWear: (wear: string[] | null) => dressAgent(who, wear),
              looks: homeOf,
              onBody: (change: BodyChange) => changeBody(who, change),
              onEmote: (name: string) => makeGesture(who, name),
            }
          : {})}
        activity={shownActivities[who]}
        said={speech[who]}
        roomName={(ref) => map.places.find((p) => p.id === `room:${ref}`)?.name}
        where={where}
        openTasks={countTasks(allTasks, who).open}
        online={online.has(who)}
        talking={who === talking}
        {...(needs.some((n) => n.agent === who) ? { onNeed: () => setPanel({ kind: "need", agent: who }) } : {})}
        tasksWake={watcher ? watcher.created || watcher.updated : undefined}
        onChat={() => chatWith(who)}
        {...(where && where.id !== (visiting ?? own.id) ? { onVisit: () => go(where.id) } : {})}
        onSendHome={() => sendHome(who)}
        onTasks={() => {
          setListView({ filter: "open", who });
          setPanel({ kind: "tasks" });
        }}
        {...(onDraft && canPlace(who) ? { onRedoRoom: () => askRoom(who) } : {})}
        onClose={closePanel}
      />
    );
  }
  // Where each panel goes, in the place on screen: who has a body here, what is in it, and whether its plaque hangs.
  const plaqueWords = changeable && placeId && room.name ? wordsOnPlaque(placeId, room.name) : undefined;
  const where = useMemo(
    (): Where => ({
      here: new Set(here),
      things: room.props.map((p) => ({ id: p.id, kind: p.kind, ...(p.action ? { action: p.action } : {}) })),
      plaque: !!plaqueWords && !!plaqueSpot(room),
    }),
    [here, room, plaqueWords],
  );
  // Your conversation, beside whoever you talk to, unless something else has its place: the whole chat open beside
  // the world, the room being rearranged, the map, that agent's own card, or a meeting room's own conversation.
  const roomTalk = !!showing.visiting?.startsWith("room:") && readingRoom;
  const theirCard = (panel?.kind === "agent" || panel?.kind === "need") && panel.agent === talking;
  const talkShown =
    dialogue && showStage && stageUp && !panelOpen && !editor.editing && !mapOpen && !theirCard && !roomTalk;
  // Face to face when its body is here; on a visit anywhere else, a call.
  const onPhone = !!showing.visiting && !where.here.has(talking);
  const talkColor = colorOf(talking);
  const panels: WorldPanelSpec[] = [];
  if (panel && overlay) {
    const anchor = anchorFor(
      { kind: panel.kind, ...("agent" in panel ? { agent: panel.agent } : {}), ...atOf(panel) },
      where,
    );
    const color = "agent" in panel ? colorOf(panel.agent) : undefined;
    panels.push({
      id: "card",
      kind: panel.kind,
      anchor,
      node: overlay,
      look: lookOf(anchor),
      rank: 2,
      onAway: closePanel,
      ...(color !== undefined ? { color } : {}),
    });
  }
  if (editor.editing && editor.shelf)
    panels.push({
      id: "catalogue",
      kind: "catalogue",
      anchor: { held: "dock" },
      node: editor.shelf,
      look: "dock",
      rank: 2,
    });
  if (talkShown)
    panels.push({
      id: "talk",
      kind: "talk",
      anchor: talkAnchor(talking, where, !!showing.visiting),
      node: <TalkInSlot />,
      look: onPhone ? "phone" : "talk",
      rank: 1,
      optional: true,
      fallback: "dock",
      color: talkColor,
    });
  // A card beside something, or docked at the side, has a strip on the right kept for it, which the stage takes from
  // the scene only when the card needs it (`stripTaken`): a board read up close, the catalogue, a narrow stage. One
  // held in front of you (the map) is read over the scene, and your conversation goes wherever there is room.
  const panelRoom =
    !sheets && panels.some((p) => !p.optional && !("held" in p.anchor && p.anchor.held === "front")) ? PANEL_ROOM : 0;
  const stage: ReactNode =
    showStage && info.avatar ? (
      <Avatar
        // Your own body or the agent's: going from one to the other is a new stage. Between places, the stage
        // stays, and you go on in the same body, at the door you came in by or the start of where the map took you.
        key={showing.visiting ? "visit" : "own"}
        fill
        url={info.avatar}
        animations={info.animations ?? []}
        state={showing.visiting ? "idle" : state}
        loudness={showing.visiting ? () => 0 : voice.loudness}
        engaged={showing.visiting ? false : busy || conversing}
        controls={controls}
        insetRight={panelOpen && wide ? PANEL_WIDTH : 0}
        panelRoom={panelRoom}
        panels={panels}
        onShown={onShown}
        onSheets={setSheets}
        onProblem={onProblem}
        {...(plaqueWords ? { plaque: plaqueWords } : {})}
        insetTop={covered?.top ?? 0}
        // Rearranging, the room is framed above the bar over the stage's foot, so what you drag is never under it; on a
        // phone with the catalogue open, the bar is hidden under the sheet, which `covered` already counts.
        insetBottom={(covered?.bottom ?? 0) + (editor.editing && dockTall && !sheet ? dockTall + 24 : 0)}
        room={room}
        place={placeId}
        arriveFrom={showing.visiting ? cameFrom : undefined}
        onDoor={onDoor}
        company={townCompany}
        moves={moves}
        agent={showing.visiting ? "you" : shown}
        // Your own body wears nothing of the agent's, and looks and carries itself its own way.
        {...(!showing.visiting && own.wear ? { wear: own.wear } : {})}
        {...(!showing.visiting && own.looks ? { looks: own.looks } : {})}
        emotes={emotes}
        activities={stageActivities}
        speech={saidAll}
        menuFor={menuFor}
        visitor={!!showing.visiting}
        onNear={setNear}
        tools={editor.editing ? editor.tools : tools}
        tasks={boardTasks}
        {...(screenCards ? { screen: screenCards } : {})}
        // Outside a home, a screen drawn live goes through the dashboard's widgets, by the Board page's renderers; one
        // kept to a single widget shows it anywhere.
        {...(((hasScreen && !owner) || pinsWidget) && dashboard.widgets.length ? { widgets: dashboard.widgets } : {})}
        onTaskMove={moveTask}
        {...(calendarView ? { calendar: calendarView } : {})}
        {...(world ? { world, onApprove: approve } : {})}
        {...(notes ? { notes } : {})}
        talked={talked}
        {...(inside ? { occupied: inside } : {})}
        exitFor={exitFor}
        onUse={onUse}
        onLine={hearLine}
        overlay={
          editor.editing ? (
            <div
              hidden={sheet}
              ref={dock}
              className="room-edit-dock"
              style={{
                // Clear of the chat's column when it is open, and of the catalogue docked at the side.
                right: (panelOpen && wide ? PANEL_WIDTH : 0) + (editor.adding && !sheets ? PANEL_ROOM : 0) + 16,
                bottom: (covered?.bottom ?? 0) + 16,
              }}
            >
              {editor.bar}
            </div>
          ) : undefined
        }
        greet={greet}
        onGreeted={greeted}
        onBody={onBody}
        {...(editor.stage ? { edit: editor.stage } : {})}
        {...(info.enabled && !showing.visiting ? { chooseIdle } : {})}
      />
    ) : null;

  return {
    has3d,
    stageOn,
    showStage,
    setStageOn: (on: boolean) => {
      setStageOn(on);
      remember(STAGE_KEY, on);
    },
    stage,
    voiceEnabled: !!info.enabled,
    voice,
    /** A spoken turn in progress: what was heard, and the reply so far. */
    spoken: heard === null ? null : { heard, replying },
    /** The place you are visiting and can see, by id; null at the agent's own view. */
    visiting: showing.visiting,
    /** Whose own view the scene shows, and where "Back to" goes. */
    home: shown,
    /** What every agent is doing, talks and all, while the scene is on. */
    activities: shownActivities,
    /** The name of the place on screen, when it has one. */
    placeName: room.name,
    /** Something is open over the stage, or the room is being rearranged: on a phone it needs the chat's screen. */
    worldPanel: !!panel || editor.editing,
    /** The chat is out of sight for what is open: on a phone, anything open is a sheet where the chat would be. */
    chatCovered: showStage && !wide && (!!panel || editor.editing),
    /**
     * Your conversation is shown in the world, beside whoever you talk to, and
     * how: the page draws it into `TalkSlot`. On the phone when they are
     * somewhere else; what to call them; and `brief`, only the last few
     * words, while a card has most of the room.
     */
    talk: talkShown ? { phone: onPhone, name: nameOf(talking), brief: !!panel } : null,
    /**
     * The stage is on screen, so your conversation is in the world (`talk`
     * says whether it is showing just now); or it couldn't be shown, so the
     * chat beside it is the only place to talk.
     */
    stageUp,
    stageFailed,
    /** Close what is open over the stage, and stop rearranging the room. */
    closePanel: () => {
      closePanel();
      editor.stop();
    },
  };
}

/** Hold to talk: press and speak, let go to send. Space works too, when not typing. */
export function TalkButton({ voice }: { voice: ReturnType<typeof useVoice> }) {
  const label =
    voice.phase === "listening"
      ? "Listening… let go to send"
      : voice.phase === "thinking"
        ? "Thinking…"
        : voice.phase === "speaking"
          ? "Speaking… hold to cut in"
          : "Hold to talk";
  return (
    <button
      type="button"
      className={`chat-talk-btn chat-talk-${voice.phase}`}
      aria-label={label}
      title="Hold to talk (or hold Space)"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        void voice.hold();
      }}
      onPointerUp={voice.release}
      onPointerCancel={voice.release}
    >
      <span className="chat-talk-dot" aria-hidden="true" />
      <span className="chat-talk-label">{voice.phase === "idle" ? "Talk" : label}</span>
    </button>
  );
}
