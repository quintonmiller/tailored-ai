import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchProjectTasks, fetchTaskWatcher, type ProjectTask } from "../api";
import { type AgentAction, Avatar, type AvatarControls } from "../avatar/Avatar";
import type { BoardSpot, BoardTask } from "../avatar/boards";
import type { Cue } from "../avatar/cues";
import type { AgentActivity } from "../avatar/doing";
import type { BodyState } from "../avatar/motion";
import { bodyFor, DEFAULT_ROOM, type Room } from "../avatar/scene";
import type { Companion } from "../avatar/stage";
import { nameOf, newChatKey } from "../lib/conversations";
import { subscribeStateChanges } from "../lib/state-events";
import { countTasks, LIVE_STATUSES } from "../lib/tasks";
import { NEW_ROOM_ASK, NewRoom } from "./NewRoom";
import { NewTask } from "./NewTask";
import { useVoice } from "./voice";
import { type Said, WorldAgent } from "./WorldAgent";
import { useWorldMap, WorldMap } from "./WorldMap";
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
export function useRoom(agent: string, enabled: boolean): { room: Room; company: Companion[]; id?: string } {
  const [scene, setScene] = useState<{ room: Room; company: Companion[]; id?: string }>({
    room: DEFAULT_ROOM,
    company: [],
  });
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    let id: string | undefined;
    const load = () =>
      fetch(`/api/ext/builtin:places/${encodeURIComponent(agent || "default")}`)
        .then((res) => (res.ok ? (res.json() as Promise<PlaceInfo>) : null))
        .then((body) => {
          if (gone) return;
          id = body?.id;
          setScene({ room: body?.place ?? DEFAULT_ROOM, company: companyOf(body), ...(id ? { id } : {}) });
        })
        .catch(() => {
          if (!gone) setScene({ room: DEFAULT_ROOM, company: [] });
        });
    void load();
    const off = subscribeStateChanges((change) => {
      // Someone came or went, maybe this agent itself: where it is and who is there are asked again.
      if (change.type === "whereabouts") void load();
      if (change.type !== "place" || !id || change.id !== id) return;
      if (change.op === "delete" || !change.after) void load();
      else setScene((s) => ({ ...s, room: change.after as unknown as Room }));
    });
    return () => {
      gone = true;
      off();
    };
  }, [agent, enabled]);
  return scene;
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

/** Which tasks a place's boards show: everyone's in the lobby, otherwise those of whoever is there. */
export function tasksFor(place: string | undefined, agents: string[], tasks: BoardTask[]): BoardTask[] {
  if (!place) return [];
  if (place === "lobby") return tasks;
  const who = place.startsWith("home:") ? [place.slice("home:".length)] : agents;
  return tasks.filter((t) => !!t.assignee && who.includes(t.assignee));
}

/** What the agents themselves are configured as: whether one runs on its own, which is what can be paused. */
function useAgentRoster(enabled: boolean): { online: Set<string>; names: string[] } {
  const [roster, setRoster] = useState<{ online: Set<string>; names: string[] }>({ online: new Set(), names: [] });
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    fetch("/api/agents")
      .then((res) => (res.ok ? res.json() : {}))
      .then((agents: Record<string, { online?: { enabled?: boolean } }>) => {
        if (!gone)
          setRoster({
            online: new Set(Object.entries(agents ?? {}).flatMap(([name, a]) => (a?.online?.enabled ? [name] : []))),
            names: Object.keys(agents ?? {}).sort(),
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

/**
 * Any place, by id, as a visitor sees it: its room and everyone in it, asked
 * again when someone comes or goes, and redrawn as it changes.
 */
export function useScene(id: string | null): { room: Room; company: Companion[]; id?: string } | null {
  const [scene, setScene] = useState<{ room: Room; company: Companion[]; id?: string } | null>(null);
  useEffect(() => {
    if (!id) {
      setScene(null);
      return;
    }
    let gone = false;
    const load = () =>
      fetch(`/api/ext/builtin:places/scene/${encodeURIComponent(id)}`)
        .then((res) => (res.ok ? (res.json() as Promise<PlaceInfo>) : null))
        .then((body) => {
          if (!gone) setScene({ room: body?.place ?? DEFAULT_ROOM, company: companyOf(body), id });
        })
        .catch(() => {
          if (!gone) setScene({ room: DEFAULT_ROOM, company: [], id });
        });
    void load();
    const off = subscribeStateChanges((change) => {
      if (change.type === "whereabouts") void load();
      if (change.type !== "place" || change.id !== id) return;
      if (change.op === "delete" || !change.after) void load();
      else setScene((s) => (s ? { ...s, room: change.after as unknown as Room } : s));
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
  company?: { agent: string; name?: string; avatar?: string; animations?: string[] }[];
}

/** The others in the place, as the stage takes them; anyone without a body file is left out. */
export function companyOf(info: PlaceInfo | null | undefined): Companion[] {
  return (info?.company ?? []).flatMap((c) =>
    c.avatar ? [{ agent: c.agent, name: c.name ?? c.agent, url: c.avatar, animations: c.animations ?? [] }] : [],
  );
}

/** What can be open over the stage. A task opened from the list goes back to it. */
type Panel =
  | { kind: "map" }
  | { kind: "tasks" }
  | { kind: "task"; id: string; fromList?: boolean }
  | { kind: "agent"; agent: string }
  | { kind: "new-task" }
  | { kind: "new-room" };

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
}

export function useChatStage({
  agent,
  sessionKey,
  sending,
  panelOpen,
  onSpoken,
  setTurnExtras,
  setSpeaking,
  onChatWith,
  onDraft,
}: ChatStageOptions) {
  // Visiting a place in your own body, walking or flying; null is the agent's own view.
  const [visiting, setVisiting] = useState<string | null>(null);
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
  // Everything but the map sits in the chat's column while it is open, so the scene stays in view beside it.
  const side = !!panel && panel.kind !== "map";
  const closePanel = useCallback(() => setPanel(null), []);
  const [listView, setListView] = useState<ListView>({ filter: "open", who: undefined });
  const [near, setNear] = useState<string | undefined>(undefined);
  const visited = useScene(visiting);
  const { room, company, id: placeId } = visited ?? own;
  // The map also says where an agent's body is, for its card.
  const map = useWorldMap((mapOpen || panel?.kind === "agent") && showStage);
  const [voicesOn, setVoicesOn] = useState(() => saved(VOICES_KEY, false));
  const hearLine = useVoicesNearby(voicesOn && !!visiting);
  const board = useBoardTasks(showStage);
  const allTasks = board.tasks;
  const watcher = useTaskWatcher(
    showStage && (panel?.kind === "task" || panel?.kind === "new-task" || panel?.kind === "tasks"),
  );
  useEffect(() => {
    if (!visiting) setNear(undefined);
  }, [visiting]);
  const activities = useRecords<AgentActivity>("activity", showStage);
  const speech = useRecords<Said>("speech", showStage);
  const { online, names: agentNames } = useAgentRoster(showStage);
  const shown = home || "default";
  const talking = agent || "default";
  // Where you are says who you talk to: an agent's own home is a conversation with it, and coming back to the
  // agent you came from is one with it again. Anywhere else, the conversation you had goes on.
  const host = visiting ? (visiting.startsWith("home:") ? visiting.slice("home:".length) : undefined) : shown;
  // On every arrival, even at the agent you are talking to already: that calls off a switch still waiting for a
  // reply, so coming back before it is done keeps you where you came back to.
  const arrived = useRef(host);
  // biome-ignore lint/correctness/useExhaustiveDependencies: arriving decides; who you talk to there is yours to change.
  useEffect(() => {
    if (host === arrived.current) return;
    arrived.current = host;
    if (host) onChatWith?.(host);
  }, [host]);
  // What clicking an agent's body offers: talk to it, send it home from a shared place, pause or wake it.
  const menuFor = useCallback(
    (who: string): AgentAction[] => {
      const actions: AgentAction[] = [];
      if (who !== talking && onChatWith) actions.push({ label: `Chat with ${who}`, run: () => onChatWith(who) });
      if (placeId?.startsWith("shared:"))
        actions.push({
          label: who === shown ? "Go home" : "Send home",
          run: () =>
            must(fetch(`/api/state/whereabouts/${encodeURIComponent(who)}`, { method: "DELETE" }), "send it home"),
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
    [shown, talking, onChatWith, placeId, online, activities],
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

  // M opens the map, unless the person is typing.
  useEffect(() => {
    if (!showStage) return;
    const toggle = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");
      if (e.code === "KeyM" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey)
        setPanel((open) => (open?.kind === "map" ? null : { kind: "map" }));
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [showStage]);

  // Space to talk, like a walkie-talkie, unless the person is typing, or pressing a button in a panel.
  const { hold, release } = voice;
  useEffect(() => {
    if (!info.enabled) return;
    const typing = (e: KeyboardEvent) =>
      (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog']");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !typing(e)) {
        e.preventDefault();
        void hold();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e)) release();
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
  // The boards show the tasks of whoever is in the place: on the agent's own view, the agent too.
  const boardTasks = useMemo(
    () => tasksFor(placeId, [...(visiting ? [] : [shown]), ...company.map((c) => c.agent)], allTasks),
    [placeId, visiting, shown, company, allTasks],
  );
  // What the lobby's kiosks and the boards do when clicked. A note on a board opens its task; anywhere else on a
  // board opens the list, at that column when it was one, and at the owner's tasks in a home.
  const onUse = useCallback(
    (action: string, on?: BoardSpot) => {
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
    [onDraft, placeId],
  );
  const tools = (
    <>
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
        <button type="button" className="talk-tool talk-near" onClick={() => onChatWith(near)}>
          Talk to {near}
        </button>
      )}
    </>
  );
  // Going somewhere: to the agent you came from is back with it.
  const go = (id: string) => {
    setVisiting(id === own.id ? null : id);
    setPanel(null);
  };
  let overlay: ReactNode;
  if (panel?.kind === "map")
    overlay = (
      <WorldMap
        places={map.places}
        problem={map.problem}
        here={visiting ?? own.id}
        activities={activities}
        onGo={go}
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
  else if (panel?.kind === "agent") {
    const who = panel.agent;
    const spot = map.places.find((p) => (p.kind === "home" || p.kind === "shared") && p.agents.includes(who));
    const where = spot && { id: spot.id, name: spot.name, home: spot.id === `home:${who}` };
    overlay = (
      <WorldAgent
        key={who}
        agent={who}
        activity={activities[who]}
        said={speech[who]}
        roomName={(ref) => map.places.find((p) => p.id === `room:${ref}`)?.name}
        where={where}
        openTasks={countTasks(allTasks, who).open}
        online={online.has(who)}
        talking={who === talking}
        onChat={() => {
          setPanel(null);
          onChatWith?.(who);
        }}
        {...(where && where.id !== (visiting ?? own.id) ? { onVisit: () => go(where.id) } : {})}
        onSendHome={() =>
          must(fetch(`/api/state/whereabouts/${encodeURIComponent(who)}`, { method: "DELETE" }), "send it home")
        }
        onTasks={() => {
          setListView({ filter: "open", who });
          setPanel({ kind: "tasks" });
        }}
        onClose={closePanel}
      />
    );
  }
  const stage: ReactNode =
    showStage && info.avatar ? (
      <Avatar
        // A new place is a new stage: you arrive at its start, not wherever you stood in the last one.
        key={visiting ?? "own"}
        fill
        url={info.avatar}
        animations={info.animations ?? []}
        state={visiting ? "idle" : state}
        loudness={visiting ? () => 0 : voice.loudness}
        engaged={visiting ? false : busy || conversing}
        controls={controls}
        insetRight={(panelOpen || side) && wide ? PANEL_WIDTH : 0}
        room={room}
        company={company}
        agent={visiting ? "you" : shown}
        activities={activities}
        speech={speech}
        menuFor={menuFor}
        visitor={!!visiting}
        onNear={setNear}
        tools={tools}
        tasks={boardTasks}
        onUse={onUse}
        onLine={hearLine}
        overlay={overlay}
        {...(info.enabled && !visiting ? { chooseIdle } : {})}
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
    /** The place you are visiting, by id; null at the agent's own view. */
    visiting,
    /** Whose own view the scene shows, and where "Back to" goes. */
    home: shown,
    /** What every agent is doing, while the scene is on. */
    activities,
    /** The name of the place on screen, when it has one. */
    placeName: room.name,
    /** Something is open over the stage: on a phone it needs the screen the chat would take. */
    worldPanel: !!panel,
    /** What is open sits in the chat's column: the chat steps aside until it closes. */
    sidePanel: side,
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
