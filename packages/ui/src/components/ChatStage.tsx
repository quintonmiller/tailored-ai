import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DashboardWidgetSpec,
  fetchDashboard,
  fetchPendingApprovals,
  fetchProjectTasks,
  fetchTaskWatcher,
  fetchWidgetData,
  type PendingApprovalRequest,
  type ProjectTask,
} from "../api";
import { type AgentAction, Avatar, type AvatarControls } from "../avatar/Avatar";
import type { BoardTask } from "../avatar/boards";
import {
  type Booked,
  type CalendarView,
  type CronJob,
  doneToday,
  type OwnAgent,
  upcoming,
  type Wake,
} from "../avatar/calendar";
import type { Cue } from "../avatar/cues";
import type { AgentActivity } from "../avatar/doing";
import type { BodyState } from "../avatar/motion";
import { bodyFor, DEFAULT_ROOM, type Room, type RoomDoor } from "../avatar/scene";
import { dashboardCards, endpointOf, type Fetched, homeCards, type ScreenCard, screenWidgets } from "../avatar/screens";
import type { Companion, UseSpot } from "../avatar/stage";
import { WEAR_TYPE } from "../avatar/wear";
import { nameOf, newChatKey } from "../lib/conversations";
import { clockTime, wakeWords } from "../lib/did";
import { type Need, needsFrom, requestsOf, withQuestions } from "../lib/needs";
import { subscribeStateChanges } from "../lib/state-events";
import { countTasks, LIVE_STATUSES } from "../lib/tasks";
import { trailTo } from "../lib/wayfinding";
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

/**
 * The chat page's scene and voice: the agent's 3D body behind the
 * conversation when it has one, and hold-to-talk into the same
 * conversation. Typed and spoken turns are one history.
 */

const STAGE_KEY = "tai.chat.stage";
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
            ...recordOfPlace(body),
          };
          setScene((s) => (doorsOnly && sameDoors(s.room.doors, next.room.doors) ? s : steady(s, next)));
        })
        .catch(() => {
          if (!gone && n === asked && !doorsOnly) setScene({ room: DEFAULT_ROOM, company: [] });
        });
    };
    void load();
    const off = subscribeStateChanges((change) => {
      // Someone came or went, maybe this agent itself: where it is and who is there are asked again. And for
      // someone choosing what a body here wears.
      if (comeOrGone(change.type) || change.type === WEAR_TYPE) void load();
      if (change.type !== "place" || !id || change.id !== id) return;
      if (change.op === "delete" || !change.after || resized(change)) void load();
      else {
        // Shown as changed at once; and since where its door goes depends on what is in it, asked again for that.
        setScene((s) => ({
          ...s,
          room: { ...(change.after as unknown as Room), doors: s.room.doors },
          version: change.version,
        }));
        void load(true);
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
  /** What a person rearranging it writes with: the record's version (0 while drawn fresh) and scope. */
  version?: number;
  scope?: string;
  /** A person may rearrange it: anywhere but a hall, which the building lays out. */
  editable?: boolean;
  /** Fields shown that aren't the record's own: a meeting room's purpose, from its room. */
  lent?: string[];
}

/** The room the server sent, with its doors; the built-in room when it sent none. */
export function roomOf(info: PlaceInfo | null | undefined): Room {
  if (!info?.place) return DEFAULT_ROOM;
  return info.doors?.length ? { ...info.place, doors: info.doors } : info.place;
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
 */
export function useRecords<T>(type: string, enabled: boolean): Record<string, T> {
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
        else next[change.id] = change.after as unknown as T;
        return next;
      });
    });
    return () => {
      gone = true;
      off();
    };
  }, [type, enabled]);
  return records;
}

/**
 * What agents say, out loud, when you are near them on a visit: each line
 * spoken in the agent's own voice, quieter the further away you stand, one at
 * a time. Off until switched on, because the voice may be made on a GPU.
 */
export function useVoicesNearby(on: boolean) {
  const queue = useRef<{ agent: string; text: string; nearness: number }[]>([]);
  const playing = useRef(false);
  const next = useCallback(async () => {
    if (playing.current) return;
    const line = queue.current.shift();
    if (!line) return;
    playing.current = true;
    try {
      const res = await fetch("/api/live/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: line.agent, text: line.text }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.volume = Math.max(0.15, Math.min(1, line.nearness));
      await new Promise<void>((done) => {
        audio.onended = () => done();
        audio.play().catch(() => done());
      });
      URL.revokeObjectURL(url);
    } catch {
      // A line that can't be voiced is still in its bubble.
    } finally {
      playing.current = false;
      void next();
    }
  }, []);
  useEffect(() => {
    if (!on) queue.current = [];
  }, [on]);
  return useCallback(
    (agent: string, text: string, nearness: number) => {
      if (!on) return;
      queue.current.push({ agent, text, nearness });
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

/** Which tasks a place's boards show: everyone's in the lobby, otherwise those of whoever is there. */
export function tasksFor(place: string | undefined, agents: string[], tasks: BoardTask[]): BoardTask[] {
  if (!place) return [];
  if (place === "lobby") return tasks;
  const who = place.startsWith("home:") ? [place.slice("home:".length)] : agents;
  return tasks.filter((t) => !!t.assignee && who.includes(t.assignee));
}

/** Whose wakes a place's calendars show, as its boards show tasks: everyone's in the lobby, otherwise whoever is there. */
export function wakesFor(place: string | undefined, agents: string[], wakes: Wake[]): Wake[] {
  if (!place) return [];
  if (place === "lobby") return wakes;
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

/** An agent's body home: out of any meeting room it is visiting, and back from any shared place it went to. */
async function sendHome(who: string): Promise<void> {
  for (const type of ["visit", "whereabouts"]) {
    const res = await fetch(`/api/state/${type}/${encodeURIComponent(who)}`, { method: "DELETE" });
    // Nothing to delete is a body that wasn't there to begin with.
    if (res.status !== 404) await must(Promise.resolve(res), "send it home");
  }
}

/**
 * What a person chose for an agent's body to wear, kept where the agent's own
 * choice goes; null takes the choice away, back to what suits its role.
 */
async function dressAgent(who: string, wear: string[] | null): Promise<void> {
  const path = `/api/state/${WEAR_TYPE}/${encodeURIComponent(who)}`;
  if (wear === null) {
    const res = await fetch(path, { method: "DELETE" });
    // Nothing to take away is a body already in what suits it.
    if (res.status !== 404) await must(Promise.resolve(res), "change what it wears");
    return;
  }
  await must(
    fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: `agent:${who}`, data: { wear } }),
    }),
    "change what it wears",
  );
}

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
          setScene((s) => (doorsOnly && s && sameDoors(s.room.doors, next.room.doors) ? s : steady(s, next)));
        })
        .catch(() => {
          if (!gone && n === asked && !doorsOnly) setScene({ room: DEFAULT_ROOM, company: [], id });
        });
    };
    void load();
    const off = subscribeStateChanges((change) => {
      if (comeOrGone(change.type) || change.type === WEAR_TYPE) void load();
      // A place made, gone, or moved to another area elsewhere may add or take away a door here.
      if (
        change.type === "place" &&
        change.id !== id &&
        (change.op !== "update" || change.before?.area !== change.after?.area)
      )
        void load();
      if (change.type !== "place" || change.id !== id) return;
      if (change.op === "delete" || !change.after || resized(change)) void load();
      else {
        setScene((s) =>
          s
            ? {
                ...s,
                // A meeting room's purpose is its room's until its members give it one: still lent, if the record has none.
                room: { ...lentTo(change.after as unknown as Room, s), doors: s.room.doors },
                version: change.version,
              }
            : s,
        );
        void load(true);
      }
    });
    return () => {
      gone = true;
      off();
    };
  }, [id]);
  return scene;
}

/** What the server says about the place an agent is in. */
export interface PlaceInfo {
  id?: string;
  place?: Room;
  /** Everyone else in it; `with`, the one here an agent came to see, having messaged it directly. */
  company?: {
    agent: string;
    name?: string;
    avatar?: string;
    animations?: string[];
    with?: string;
    role?: string;
    wear?: string[];
  }[];
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
}

/** The others in the place, as the stage takes them; anyone without a body file is left out. */
export function companyOf(info: PlaceInfo | null | undefined): Companion[] {
  return (info?.company ?? []).flatMap((c) =>
    c.avatar
      ? [
          {
            agent: c.agent,
            name: c.name ?? c.agent,
            url: c.avatar,
            animations: c.animations ?? [],
            ...(c.with ? { with: c.with } : {}),
            ...(c.wear?.length ? { wear: c.wear } : {}),
          },
        ]
      : [],
  );
}

/** What can be open over the stage. A task opened from the list goes back to it. */
type Panel =
  | { kind: "map" }
  | { kind: "tasks" }
  | { kind: "task"; id: string; fromList?: boolean }
  | { kind: "agent"; agent: string }
  | { kind: "place" }
  | { kind: "new-task" }
  | { kind: "new-room" }
  | { kind: "needs" }
  | { kind: "need"; agent: string; fromList?: boolean }
  | { kind: "dashboard"; focus?: string }
  /** A calendar's full list: one agent's, those of whoever is in the place it hangs in, or everyone's. */
  | { kind: "calendar"; who?: string; here?: true };

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
}: ChatStageOptions) {
  // Visiting a place in your own body, walking or flying; null is the agent's own view.
  const [visiting, setVisitingTo] = useState<string | null>(null);
  // The place you came from, when you came through a door: you stand just inside the door back to it.
  const [cameFrom, setCameFrom] = useState<string | undefined>(undefined);
  /** Go somewhere: by the map (to its start), or through a door from `from`. */
  const setVisiting = useCallback((id: string | null, from?: string) => {
    setCameFrom(from);
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
  const editor = useRoomEditor(editable);
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
  // Everything but the map sits in the chat's column while it is open, so the scene stays in view beside it; while
  // you rearrange the room, the catalogue does too.
  const side = (!!panel && panel.kind !== "map") || editor.adding;
  // The map says where you are, for the trail over the stage, and where an agent's body is, for its card and for
  // going to it from what needs you. Opening any of them asks again, for anything new nobody moved to tell it about.
  const map = useWorldMap(
    showStage,
    mapOpen || panel?.kind === "agent" || panel?.kind === "needs" || panel?.kind === "calendar",
  );
  const trail = useMemo(() => trailTo(placeId, map.places, map.areas), [placeId, map.places, map.areas]);
  const [voicesOn, setVoicesOn] = useState(() => saved(VOICES_KEY, false));
  const hearLine = useVoicesNearby(voicesOn && !!visiting);
  const board = useBoardTasks(showStage);
  const allTasks = board.tasks;
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
  // What every agent is doing as the world shows it: a question on a task answered (here, or on the Tasks page) is
  // done with, and one still waiting on you is, whatever became of the turn that asked it.
  const activities = useMemo(() => withQuestions(doings, allTasks), [doings, allTasks]);
  const approvals = usePendingApprovals(showStage, requestsOf(doings), panel?.kind === "need");
  // Everything waiting on you, for the "Needs you" list and each agent's card.
  const needs = useMemo(() => needsFrom(activities, approvals.list, allTasks), [activities, approvals.list, allTasks]);
  const speech = useRecords<Said>("speech", showStage);
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
  // Talking to someone is the chat: a panel in its column steps aside, or the click would seem to do nothing.
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
  // What clicking an agent's body offers: talk to it, send it home from a shared place, pause or wake it. One
  // waiting on you opens what it waits on instead (`onBody`); one busy with something else that still has a question
  // on a task for you offers it first.
  const menuFor = useCallback(
    (who: string): AgentAction[] => {
      const actions: AgentAction[] = [];
      if (needs.some((n) => n.agent === who))
        actions.push({ label: "What it needs from you", run: () => setPanel({ kind: "need", agent: who }) });
      if (who !== talking && onChatWith) actions.push({ label: `Chat with ${who}`, run: () => chatWith(who) });
      // Gone to a shared place, or to a meeting room to talk: home is where it goes back to.
      if (placeId?.startsWith("shared:") || placeId?.startsWith("room:"))
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
    [shown, talking, onChatWith, chatWith, placeId, online, activities, needs],
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

  const voice = useVoice({
    agent: agent || undefined,
    sessionKey: keyFor,
    body: showStage && !visiting ? body : undefined,
    measure: showStage,
    onCue: (cue) => controls.current?.cue(cue),
    onHeard: (text) => {
      setHeard(text || null);
      setReplying("");
    },
    onText: (delta) => setReplying((r) => r + delta),
    onDone: (turn) => {
      // The conversation the turn was spoken in. None when the page has gone on to another one since: the turn
      // is saved in its own, and the page stays where the person took it.
      const key = inUse.current;
      setHeard(null);
      setReplying("");
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

  // Space to talk, like a walkie-talkie, unless the person is typing, or pressing a button in a panel.
  const { hold, release } = voice;
  // Whether Space started talking. Letting it go ends that wherever the key comes up: clicking a body while
  // holding it puts the focus in that body's menu, which would otherwise keep the microphone open, and the key
  // coming up there isn't a press of the menu's first button. A ref, so it outlasts the listeners being redone.
  const bySpace = useRef(false);
  useEffect(() => {
    if (!info.enabled) return;
    const typing = (e: KeyboardEvent) =>
      (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog']");
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
  const hasScreen = room.props.some((p) => p.kind === "screen");
  const hasCalendar = room.props.some((p) => p.kind === "calendar");
  const dashboard = useDashboard(showStage && ((hasScreen && !owner) || panel?.kind === "dashboard"));
  const wakes = useWakes(showStage && (hasCalendar || hasScreen || panel?.kind === "calendar"));
  const minute = useMinute(showStage && (hasCalendar || hasScreen || panel?.kind === "calendar"));
  // Pausing is for every agent at once, so one asleep because agents are paused means they all are: nothing on a
  // calendar wakes until they are resumed.
  const paused = useMemo(() => Object.values(activities).some((a) => a.detail === "agents are paused"), [activities]);
  const done = useMemo(() => doneToday(allTasks, activities, minute), [allTasks, activities, minute]);
  // A screen in a home goes through what its owner is up to; anywhere else, the dashboard's first few widgets.
  const screenCards = useMemo((): ScreenCard[] | undefined => {
    if (!hasScreen) return undefined;
    if (owner)
      return homeCards(owner, {
        activity: activities[owner],
        tasks: allTasks,
        coming: (wakes ?? [])
          .filter((w) => w.agent === owner)
          .slice(0, 6)
          .map((w) => ({ when: wakeWhen(w.at, minute), what: w.what })),
        now: minute,
      });
    return dashboardCards(dashboard, minute);
  }, [hasScreen, owner, activities, allTasks, wakes, minute, dashboard]);
  // Whose wakes a calendar shows outside a home and the lobby: whoever is there. Its full list opens on them too.
  const among = useMemo(() => (owner || placeId === "lobby" ? undefined : here), [owner, placeId, here]);
  // A calendar in a home is its owner's day; in the lobby, everyone's next wakes; elsewhere, those of whoever is there.
  const calendarView = useMemo((): CalendarView | undefined => {
    if (!hasCalendar) return undefined;
    const lobby = placeId === "lobby";
    const whose = owner ? [owner] : here;
    return {
      title: owner ? `${nameOf(owner)}'s day` : lobby ? "Everyone's next wakes" : "Next wakes for who's here",
      now: minute,
      wakes: wakesFor(placeId, here, wakes ?? []),
      done: lobby ? [] : done.filter((d) => whose.includes(d.agent)),
      names: !owner,
      ...(paused ? { note: PAUSED_NOTE } : {}),
    };
  }, [hasCalendar, placeId, owner, here, minute, wakes, done, paused]);
  // What the lobby's kiosks, the boards, the screens and the calendars do when clicked. A note on a board opens its
  // task; anywhere else on a board opens the list, at that column when it was one, and at the owner's tasks in a
  // home. A screen opens what its page is about; a calendar, its full list.
  const onUse = useCallback(
    (action: string, on?: UseSpot) => {
      if (action === "screen") {
        const card = on && "card" in on ? on.card : undefined;
        if (!owner) setPanel({ kind: "dashboard", ...(card ? { focus: card } : {}) });
        else if (card === "tasks") {
          setListView({ filter: "open", who: owner });
          setPanel({ kind: "tasks" });
        } else if (card === "next") setPanel({ kind: "calendar", who: owner });
        else setPanel({ kind: "agent", agent: owner });
        return;
      }
      if (action === "calendar") {
        setPanel({ kind: "calendar", ...(owner ? { who: owner } : placeId !== "lobby" ? { here: true } : {}) });
        return;
      }
      if (action === "tasks") {
        if (on && "task" in on) {
          setPanel({ kind: "task", id: on.task });
          return;
        }
        setListView({
          filter: on && "column" in on ? on.column : "open",
          who: placeId?.startsWith("home:") ? placeId.slice("home:".length) : undefined,
        });
        setPanel({ kind: "tasks" });
      } else if (action === "new-task") setPanel({ kind: "new-task" });
      else if (action === "new-agent")
        onDraft?.(
          "default",
          "I'd like a new agent. Ask me what it should do and how it should come across, then set it up.",
        );
      else if (action === "new-room") setPanel({ kind: "new-room" });
    },
    [onDraft, placeId, owner],
  );
  // Through a door: on into the place behind it, in your own body, from wherever you are.
  const onDoor = useCallback(
    (door: RoomDoor) => {
      if (!placeId) return;
      setVisiting(door.to, placeId);
      // The map covers the stage, so it closes; a panel in the chat's column stays open beside the new place.
      setPanel((open) => (open?.kind === "map" ? null : open));
    },
    [placeId, setVisiting],
  );
  // Homes, shared places and meeting rooms are agents' to change, and the lobby a person's; the halls are the building's.
  const changeable = !!placeId && (/^(home|shared|room):/.test(placeId) || placeId === "lobby");
  // Going somewhere: to the agent you came from is back with it.
  const go = (id: string) => {
    setVisiting(id === own.id ? null : id);
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
                <button type="button" title={`Go to ${step.label}`} onClick={() => go(step.id)}>
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
        problem={map.problem}
        here={placeId}
        activities={activities}
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
        onTask={(id) => setPanel({ kind: "task", id })}
        onTasks={() => {
          setListView({ filter: "open", who: undefined });
          setPanel({ kind: "tasks" });
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
        onWho={(who) => setPanel({ kind: "calendar", ...(Array.isArray(who) ? { here: true } : who ? { who } : {}) })}
        onGo={(who) => {
          // Off to it, where its body is: or its card, when it has no body anywhere to go to.
          if (goSee(who)) setPanel(null);
          else setPanel({ kind: "agent", agent: who });
        }}
        onTask={(id) => setPanel({ kind: "task", id })}
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
        onOpen={(id) => setPanel({ kind: "task", id, fromList: true })}
        onNew={() => setPanel({ kind: "new-task" })}
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
        {...(panel.fromList ? { onBack: () => setPanel({ kind: "tasks" }) } : {})}
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
            }
          : {})}
        activity={activities[who]}
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
        insetRight={(panelOpen || side) && wide ? PANEL_WIDTH : 0}
        insetTop={covered?.top ?? 0}
        // Rearranging, the room is framed above the bar over the stage's foot, so what you drag is never under it.
        insetBottom={(covered?.bottom ?? 0) + (editor.editing && dockTall ? dockTall + 24 : 0)}
        room={room}
        place={placeId}
        arriveFrom={showing.visiting ? cameFrom : undefined}
        onDoor={onDoor}
        company={company}
        agent={showing.visiting ? "you" : shown}
        // Your own body wears nothing of the agent's.
        {...(!showing.visiting && own.wear ? { wear: own.wear } : {})}
        activities={activities}
        speech={said}
        menuFor={menuFor}
        visitor={!!showing.visiting}
        onNear={setNear}
        tools={editor.editing ? editor.tools : tools}
        tasks={boardTasks}
        {...(screenCards ? { screen: screenCards } : {})}
        {...(calendarView ? { calendar: calendarView } : {})}
        onUse={onUse}
        onLine={hearLine}
        overlay={
          editor.editing ? (
            <>
              {/* On a phone the catalogue is a sheet over the foot of the scene, where the bar would be: one at a time. */}
              <div
                hidden={editor.adding && !wide}
                ref={dock}
                className="room-edit-dock"
                style={{
                  right: ((panelOpen || side) && wide ? PANEL_WIDTH : 0) + 16,
                  bottom: (covered?.bottom ?? 0) + 16,
                }}
              >
                {editor.bar}
              </div>
              {editor.shelf}
            </>
          ) : (
            overlay
          )
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
    /** What every agent is doing, while the scene is on. */
    activities,
    /** The name of the place on screen, when it has one. */
    placeName: room.name,
    /** Something is open over the stage, or the room is being rearranged: on a phone it needs the chat's screen. */
    worldPanel: !!panel || editor.editing,
    /** What is open sits in the chat's column: the chat steps aside until it closes. */
    sidePanel: side,
    /** The chat is out of sight for what is open: a panel in its column, or on a phone anything at all. */
    chatCovered: showStage && (side || (!wide && (!!panel || editor.editing))),
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
