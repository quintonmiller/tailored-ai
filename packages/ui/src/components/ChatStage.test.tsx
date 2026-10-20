/**
 * The chat page's scene and voice: the 3D view only for an agent with a
 * body, and talking out loud into the conversation on the page, with the
 * reply played as it streams and the agent's cues reaching its body. The
 * browser's microphone, recorder and audio are faked; the stream is real
 * enough to split an event across two network chunks.
 */
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PANEL_ROOM } from "../avatar/anchors";
import { doingCss } from "../avatar/doing";
import type { StageInput } from "../avatar/stage";
import { doorInTown } from "../avatar/town";
import {
  type ChatStageOptions,
  companyOf,
  drawsModel,
  facesShow,
  keptOnArrival,
  lastExchange,
  newest,
  roomOf,
  TalkButton,
  TalkSlot,
  tasksFor,
  useChatStage,
  wakesFor,
  withModels,
} from "./ChatStage";
import { agentColor } from "./WorldMap";

const stage = vi.hoisted(() => ({
  calls: [] as {
    url: string;
    input: StageInput;
    animations?: string[];
    chooseIdle?: (here: string | undefined, hour: number) => Promise<unknown>;
    onPick?: (agent: string, at: { x: number; y: number }) => void;
  }[],
  /** Whether each stage made was a visitor's. */
  visitors: [] as boolean[],
  /** Each agent a stage was asked to stand you in front of. */
  greeted: [] as string[],
  /** The last visitor stage's way to say a line started near you. */
  onLine: undefined as ((agent: string, text: string, nearness: number, phone?: boolean) => void) | undefined,
  /** The last stage's way to say a kiosk or a board was clicked. */
  onUse: undefined as ((action: string, on?: Record<string, string>, thing?: string) => void) | undefined,
  /** The last stage's listener for which surfaces are live: a test hands it surfaces to draw faces into. */
  surfaces: undefined as ((views: unknown[]) => void) | undefined,
  /** What the boards were told to show, each time. */
  tasks: [] as { id: string }[][],
  /** The pages the screens were told to go through, each time. */
  screens: [] as { id: string; title: string; rows?: { text: string }[] }[][],
  /** What the calendars were told to show, each time. */
  calendars: [] as { title: string; names: boolean; wakes: { key: string }[]; done: { key: string }[] }[],
  /** The last visitor stage's report of who you are standing next to. */
  onNear: undefined as ((agent: string | undefined) => void) | undefined,
  /** The last stage's report of whose bodies are in the place, those walking out included. */
  onPresent: undefined as ((agents: string[]) => void) | undefined,
  /** What the stage was told each agent last said, each time. */
  speech: [] as Record<string, { text: string; at: string }>[],
  cues: [] as string[],
  insets: [] as number[],
  /** The strip beside the chat's column kept for panels in the world, each time the insets were set. */
  panelRooms: [] as number[],
  /** Every room the stage was shown, first to last. */
  rooms: [] as { name?: string; props: { name: string }[]; doors?: { to: string; along: number }[] }[],
  /** Who else the stage was told is in the room, each time. */
  company: [] as string[][],
  /** What each of them wears, each time, by agent. */
  companyWear: [] as Record<string, string[]>[],
  /** How each of them chose to look and carry itself, each time, by agent. */
  companyLooks: [] as Record<string, Record<string, unknown> | undefined>[],
  /** How the stage's own body chose to look: as it was made, and each time after. */
  looks: [] as Record<string, unknown>[],
  /** The gestures the stage was told agents are making, each time. */
  emotes: [] as Record<string, { name: string; at: string }>[],
  /** What the stage's own body was told to wear: as it was made, and each time after. */
  wears: [] as string[][],
  /** What the stage was told each agent is doing, each time. */
  activities: [] as Record<string, { doing: string }>[],
  /** The agent each stage was made for. */
  agents: [] as (string | undefined)[],
  /** Stages on screen now: what render() waits for, instead of a fixed sleep a slow runner outlasts. */
  mounted: 0,
  /** The last stage's way to say a door was gone through. */
  onDoor: undefined as ((door: { to: string }) => void) | undefined,
  /** The place each stage was made coming from, through a door. */
  arrivals: [] as (string | undefined)[],
  /** Where each place come into on the same stage was come from. */
  entered: [] as (string | undefined)[],
  /** For each room shown in place of the last, whether the agent had gone to another place. */
  moves: [] as boolean[],
  /** How each stage was told to light its place, at the start and each time after. */
  lights: [] as string[],
  /** Bodies the stage was told to show going by in the town: who, from where, to where. */
  walks: [] as { agent: string; from: [number, number]; to: [number, number] }[],
  /** The last stage's way to say the pointer is over a door, or left it. */
  onDoorHover: undefined as ((door: { to: string } | undefined, at?: { x: number; y: number }) => void) | undefined,
  /** The panels kept beside things now, by their element, with what each is beside and how it goes. */
  anchored: new Map<
    HTMLElement,
    { anchor: unknown; opts?: { rank?: number; optional?: boolean; fallback?: string; onAway?: () => void } }
  >(),
  /** What each stage's plaque said, each time it was told. */
  plaques: [] as (string | undefined)[],
  /** What the stage was told its whiteboards say, each time. */
  notes: [] as ({ room: string; talked?: string; lines: { who: string; words: string }[] } | undefined)[],
  /** When each room last talked, as the stage was told for its doors, each time. */
  talked: [] as Record<string, string>[],
  /** Which buildings have someone in them, as the stage was told for their windows, each time. */
  occupied: [] as string[][],
  /** The last stage's way to ask where a body leaving the town goes. */
  exitFor: undefined as ((agent: string) => [number, number] | undefined) | undefined,
  /** The last stage's way to ask where a body last went, and came from. */
  wentBy: undefined as ((agent: string) => { from?: string; to?: string } | undefined) | undefined,
}));
vi.mock("../avatar/stage", () => ({
  createStage: async (
    _host: HTMLElement,
    url: string,
    input: StageInput,
    opts: {
      animations?: string[];
      chooseIdle?: (here: string | undefined, hour: number) => Promise<unknown>;
      agent?: string;
      onPick?: (agent: string, at: { x: number; y: number }) => void;
      visitor?: boolean;
      onNear?: (agent: string | undefined) => void;
      onPresent?: (agents: string[]) => void;
      onUse?: (action: string, on?: Record<string, string>, thing?: string) => void;
      onLine?: (agent: string, text: string, nearness: number, phone?: boolean) => void;
      company?: { agent: string }[];
      wear?: string[];
      looks?: Record<string, unknown>;
      onDoor?: (door: { to: string }) => void;
      arriveFrom?: string;
      lights?: string;
      onDoorHover?: (door: { to: string } | undefined, at?: { x: number; y: number }) => void;
      exitFor?: (agent: string) => [number, number] | undefined;
      wentBy?: (agent: string) => { from?: string; to?: string } | undefined;
    },
  ) => {
    stage.exitFor = opts.exitFor;
    stage.wentBy = opts.wentBy;
    stage.onLine = opts.onLine;
    stage.onDoor = opts.onDoor;
    stage.wears.push(opts.wear ?? []);
    stage.looks.push(opts.looks ?? {});
    stage.onDoorHover = opts.onDoorHover;
    if (opts.lights) stage.lights.push(opts.lights);
    stage.arrivals.push(opts.arriveFrom);
    stage.visitors.push(!!opts.visitor);
    stage.onNear = opts.onNear;
    stage.onPresent = opts.onPresent;
    stage.onUse = opts.onUse;
    stage.calls.push({ url, input, animations: opts.animations, chooseIdle: opts.chooseIdle, onPick: opts.onPick });
    stage.agents.push(opts.agent);
    stage.mounted++;
    return {
      dispose: () => {
        stage.mounted--;
      },
      setView: () => {},
      setInsets: ({ right, panels = 0 }: { right: number; panels?: number }) => {
        stage.insets.push(right);
        stage.panelRooms.push(panels);
      },
      setRoom: (room: { name?: string; props: { name: string }[] }, moved?: boolean) => {
        stage.rooms.push(room);
        stage.moves.push(!!moved);
      },
      enter: (room: { name?: string; props: { name: string }[] }, from: string | undefined) => {
        stage.rooms.push(room);
        stage.entered.push(from);
      },
      setCompany: (company: { agent: string; wear?: string[]; looks?: Record<string, unknown> }[]) => {
        stage.company.push(company.map((c) => c.agent));
        stage.companyWear.push(Object.fromEntries(company.map((c) => [c.agent, c.wear ?? []])));
        stage.companyLooks.push(Object.fromEntries(company.map((c) => [c.agent, c.looks])));
      },
      setWear: (wear: string[]) => stage.wears.push(wear),
      setLooks: (looks: Record<string, unknown>) => stage.looks.push(looks),
      setEmotes: (e: Record<string, { name: string; at: string }>) => stage.emotes.push(e),
      standBefore: (agent: string) => stage.greeted.push(agent),
      setActivities: (a: Record<string, { doing: string }>) => stage.activities.push(a),
      setSpeech: (sp: Record<string, { text: string; at: string }>) => stage.speech.push(sp),
      setTasks: (t: { id: string }[]) => stage.tasks.push(t),
      setScreen: (cards: { id: string; title: string }[]) => stage.screens.push(cards),
      setCalendar: (view: { title: string; names: boolean; wakes: { key: string }[]; done: { key: string }[] }) =>
        stage.calendars.push(view),
      setLights: (l: string) => stage.lights.push(l),
      setGlances: () => {},
      setNotes: (n: (typeof stage.notes)[number]) => stage.notes.push(n),
      setTalked: (t: Record<string, string>) => stage.talked.push(t),
      setOccupied: (b: string[]) => stage.occupied.push(b),
      cue: (c: { name: string; target?: string }) => stage.cues.push(c.target ? `${c.name}:${c.target}` : c.name),
      onSurfaces: (listener: (views: unknown[]) => void) => {
        stage.surfaces = listener;
        listener([]);
        return () => {};
      },
      surfaceReady: () => {},
      focusSurface: () => {},
      surfacePoint: () => undefined,
      addSurface: () => () => {},
      where: () => [-4, 9] as [number, number],
      walkBy: (w: { agent: string; from: [number, number]; to: [number, number] }) =>
        stage.walks.push({ agent: w.agent, from: w.from, to: w.to }),
      anchorPanel: (
        el: HTMLElement,
        anchor: unknown,
        o?: { rank?: number; optional?: boolean; onAway?: () => void },
      ) => {
        const pin = { anchor, ...(o ? { opts: o } : {}) };
        stage.anchored.set(el, pin);
        return () => {
          if (stage.anchored.get(el) === pin) stage.anchored.delete(el);
        };
      },
      setPlaque: (words: string | undefined) => stage.plaques.push(words),
    };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no EventSource; this one lets a test push world-state changes. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(event: string, fn: (ev: { data: string }) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }
  emit(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn({ data: JSON.stringify(data) });
  }
  close() {}
}

/** Where the agent is, and who else is there with a body, as the server says. */
let placeId = "home:talker";
let company: ({ agent: string; name: string; avatar: string; animations: string[]; wear?: string[] } & Record<
  string,
  unknown
>)[] = [];
/** What the agent whose home it is wears, as its place says. */
let ownWear: string[] | undefined;
/** How the agent whose home it is chose to look, as its place says. */
let ownLooks: Record<string, unknown> = {};
/** The models a body can be drawn in, as the server lists them. */
let modelNames: string[] = ["robot.vrm"];
/** How the planner chose to look, as the map says of its home. */
let plannerLooks: Record<string, unknown> = {};
/** The gestures agents are making, as the server's emote records say. */
let emoteRecords: { id: string; data: { name: string; at: string } }[] = [];
/** The `body` records there are, as the dots by names read them: a colour an agent chose. */
let bodyRecords: { id: string; data: { color?: string } }[] = [];
/** What writing what a body wears answers: 200, or a failure. */
let wearStatus = 200;
/** Where the door of the agent's own place is, as the server says. */
let homeDoorAlong = 1;
/** The agents as configured: which run on their own. */
let agentsInfo: Record<string, { online?: { enabled?: boolean } }> = {};
/** The last thing each agent said, as the server's speech records say. */
let speechRecords: { id: string; data: { agent: string; text: string; at: string } }[] = [];
/** Bodies out on their day, as the places plugin's `visit` records say. */
let outingRecords: { id: string; data: Record<string, unknown> }[] = [];
/** Where agents went to live, as `whereabouts` records: none is everyone at home. */
let whereaboutsRecords: { id: string; data: Record<string, unknown> }[] = [];
/** What rooms said last, as the places plugin's `chatter` records say. */
let chatterRecords: { id: string; data: Record<string, unknown> }[] = [];
/** Agents the page was asked to switch to. */
const chattedWith: string[] = [];
/** New chats the page was asked to start, with what to say. */
const drafts: [string, string][] = [];
/** Answers the page was asked to start, to whom, in which conversation, with what to say. */
const replies: [string, string | undefined, string][] = [];
/** What every agent is doing, as the server's activity records say. */
let activityRecords: { id: string; data: { agent: string; doing: string; what: string; [more: string]: unknown } }[] =
  [];
/** The tasks the server keeps; a PATCH changes them, as the server would. */
let taskRows: Record<string, unknown>[] = [];
/** Every change sent to a task, in order. */
const patches: { id: string; body: Record<string, unknown> }[] = [];
/** When set, the boards' next look at the tasks waits for this: the server slow to answer. */
let tasksHeld: Promise<void> | null = null;
/** The task watcher, as the server says it runs. */
let watcherInfo = { enabled: true, triggers: ["created", "updated"] };
/** Agents that run on their own, as the exploratory worker keeps them. */
let ownAgents: Record<string, unknown>[] = [];
/** Places on the map besides the usual ones: an agent made since the page opened. */
let mapExtra: Record<string, unknown>[] = [];
/** Where planner's body is on the map: at home, or gone to the trip's meeting room. */
let plannerAt = "home:planner";
/** Who the scene of planner's home has in it. */
let plannerHome = ["planner"];
// When the map says the trip's room last woke someone, if it says.
let tripTalked: string | undefined;
/** The town's plan, as small as it can be: the town hall, two houses, and the office. */
const townPlan = {
  width: 100,
  depth: 100,
  square: { at: [0, 0], radius: 11 },
  shore: { sand: 40, sea: 50 },
  stream: { points: [], width: 2.6, bridges: [] },
  park: { at: [20, -20], size: [20, 14], pond: { at: [20, -20], size: [8, 5] } },
  roads: [],
  buildings: [
    {
      id: "lobby",
      kind: "hall",
      at: [0, -20],
      facing: 0,
      size: [18, 9, 6.5],
      label: "Town hall",
      style: 0.5,
      street: "The square",
    },
    {
      id: "office",
      kind: "office",
      at: [24, -10],
      facing: 0,
      size: [14, 10, 9],
      label: "Office",
      style: 0.5,
      street: "The Avenue",
    },
    {
      id: "home:planner",
      kind: "house",
      at: [-36, -10],
      facing: 90,
      size: [5.2, 4.6, 3],
      label: "planner",
      owner: "planner",
      style: 0.3,
      street: "Maple Lane",
    },
    {
      id: "home:talker",
      kind: "house",
      at: [-24, -10],
      facing: -90,
      size: [5.2, 4.6, 3],
      label: "talker",
      owner: "talker",
      style: 0.6,
      street: "Maple Lane",
    },
  ],
  plots: [],
  trees: [],
  lamps: [],
};
/** Things on the agent's own walls besides the usual: a screen, a calendar. */
let homeExtra: Record<string, unknown>[] = [];
/** Things out on the square: the town hall's board and calendar. */
let townExtra: Record<string, unknown>[] = [];
/** The wakes agents booked, as `GET /api/schedules` lists them. */
let bookedRows: Record<string, unknown>[] = [];
/** The dashboard's widgets, as `GET /api/dashboard` resolves them. */
let dashboardWidgets: Record<string, unknown>[] = [];
/** The dashboard can't be had: `GET /api/dashboard` fails. */
let dashboardDown = false;

/** The agent's own room, as the server keeps it. */
const home = {
  name: "talker's room",
  width: 4.2,
  depth: 3.6,
  height: 2.5,
  props: [{ id: "armchair", name: "the reading chair", kind: "armchair", at: [-1, 0], facing: 90, spot: "armchair" }],
  spots: [
    { id: "middle", name: "the middle of the room", place: "the middle of the room", at: [0.15, 0.35], facing: 20 },
    {
      id: "armchair",
      name: "on the reading chair",
      place: "the reading chair",
      at: [-0.4, 0],
      facing: 90,
      activity: "sit",
      item: "armchair",
    },
  ],
  start: "middle",
};

let root: Root;
let container: HTMLDivElement;
let liveInfo: Record<string, unknown>;
let sessionStatus: number;
let turnChunks: string[];
const posts: { url: string; body: unknown }[] = [];
const deleted: string[] = [];
/** Records a DELETE finds nothing to remove at: answered 404. */
let missing: string[] = [];
/** Each agent's `talk` record as the server keeps it, for a GET of it. */
let talkRows: Record<string, { version: number; data: Record<string, unknown> }> = {};
const audios: { src: string; onended: (() => void) | null }[] = [];
const spoken: [string | undefined, string][] = [];

/** When set, a spoken turn's last event waits for this: a reply still on its way. */
let turnHeld: Promise<void> | null = null;

function streamed(chunks: string[], wait: Promise<void> | null = null): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const [i, c] of chunks.entries()) {
          if (wait && i === chunks.length - 1) await wait;
          controller.enqueue(encoder.encode(c));
        }
        controller.close();
      },
    }),
  );
}

class FakeRecorder {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  liveInfo = {
    enabled: true,
    avatar: "/api/live/avatar?agent=talker",
    animations: ["/api/live/animations/0?agent=talker"],
  };
  sessionStatus = 201;
  turnHeld = null;
  posts.length = 0;
  deleted.length = 0;
  missing = [];
  talkRows = {};
  audios.length = 0;
  spoken.length = 0;
  extras.length = 0;
  stage.calls.length = 0;
  stage.cues.length = 0;
  stage.insets.length = 0;
  stage.panelRooms.length = 0;
  stage.rooms.length = 0;
  stage.arrivals.length = 0;
  stage.entered.length = 0;
  stage.walks.length = 0;
  stage.notes.length = 0;
  stage.talked.length = 0;
  stage.occupied.length = 0;
  stage.exitFor = undefined;
  stage.wentBy = undefined;
  stage.moves.length = 0;
  stage.company.length = 0;
  stage.activities.length = 0;
  stage.speech.length = 0;
  stage.visitors.length = 0;
  stage.greeted.length = 0;
  stage.tasks.length = 0;
  stage.screens.length = 0;
  stage.calendars.length = 0;
  stage.anchored.clear();
  stage.plaques.length = 0;
  homeExtra = [];
  townExtra = [];
  bookedRows = [];
  dashboardWidgets = [];
  dashboardDown = false;
  drafts.length = 0;
  replies.length = 0;
  chattedWith.length = 0;
  agentsInfo = {};
  speechRecords = [];
  outingRecords = [];
  whereaboutsRecords = [];
  chatterRecords = [];
  mapExtra = [];
  plannerAt = "home:planner";
  plannerHome = ["planner"];
  tripTalked = undefined;
  stage.agents.length = 0;
  activityRecords = [];
  taskRows = [
    {
      id: "t1",
      title: "Book flights",
      description: "Out Friday, back Monday.",
      status: "backlog",
      assignee: "talker",
      author: "sam",
      tags: [],
      project_id: "p1",
      created_at: "2026-10-01 09:00:00",
      updated_at: "2026-10-02 09:00:00",
    },
    {
      id: "t2",
      title: "Pack",
      description: "",
      status: "in_progress",
      assignee: "someone-else",
      author: "sam",
      tags: [],
      project_id: "p1",
      created_at: "2026-10-03 09:00:00",
      updated_at: "2026-10-03 09:00:00",
    },
  ];
  patches.length = 0;
  tasksHeld = null;
  watcherInfo = { enabled: true, triggers: ["created", "updated"] };
  ownAgents = [];
  placeId = "home:talker";
  company = [];
  ownWear = undefined;
  ownLooks = {};
  modelNames = ["robot.vrm"];
  plannerLooks = {};
  emoteRecords = [];
  bodyRecords = [];
  wearStatus = 200;
  stage.wears.length = 0;
  stage.companyWear.length = 0;
  stage.companyLooks.length = 0;
  stage.looks.length = 0;
  stage.emotes.length = 0;
  homeDoorAlong = 1;
  stage.mounted = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  const audio = btoa("mp3-bytes");
  turnChunks = [
    'event: transcript\ndata: {"text":"come sit down"}\n\n',
    'event: cue\ndata: {"seq":0,"name":"wave"}\n\n',
    'event: text\ndata: {"delta":"Coming over."}\n\n',
    // An event whose name and data arrive in different chunks.
    "event: audio\n",
    `data: {"seq":0,"text":"Coming over.","mimeType":"audio/mpeg","data":"${audio}"}\n\n`,
    'event: cue\ndata: {"seq":1,"name":"go","target":"the couch"}\n\n',
    'event: done\ndata: {"transcript":"come sit down","reply":"Coming over.","timings":{"sttMs":120,"firstAudioMs":900}}\n\n',
  ];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: () => {} }] })) },
  });
  vi.stubGlobal(
    "Audio",
    class {
      onended: (() => void) | null = null;
      constructor(readonly src: string) {
        audios.push(this);
      }
      play() {
        return Promise.resolve();
      }
      pause() {}
    },
  );
  URL.createObjectURL = vi.fn(() => `blob:${audios.length}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/live?")) return new Response(JSON.stringify(liveInfo));
      if (url.startsWith("/api/state/activity")) return new Response(JSON.stringify({ records: activityRecords }));
      if (url.startsWith("/api/state/speech")) return new Response(JSON.stringify({ records: speechRecords }));
      if (url.startsWith("/api/state/emote?")) return new Response(JSON.stringify({ records: emoteRecords }));
      if (url.startsWith("/api/state/body?")) return new Response(JSON.stringify({ records: bodyRecords }));
      if (url.startsWith("/api/state/visit?")) return new Response(JSON.stringify({ records: outingRecords }));
      if (url.startsWith("/api/state/whereabouts?"))
        return new Response(JSON.stringify({ records: whereaboutsRecords }));
      if (url.startsWith("/api/state/chatter")) return new Response(JSON.stringify({ records: chatterRecords }));
      if (url === "/api/agents") return new Response(JSON.stringify(agentsInfo));
      if (url === "/api/ext/builtin:places/map")
        return new Response(
          JSON.stringify({
            places: [
              { id: "town", name: "the town", kind: "town", agents: [] },
              {
                id: "home:talker",
                name: "talker's room",
                kind: "home",
                owner: "talker",
                agents: ["talker"],
                via: "town",
                street: "Maple Lane",
              },
              {
                id: "home:planner",
                name: "planner's room",
                kind: "home",
                owner: "planner",
                agents: plannerAt === "home:planner" ? ["planner"] : [],
                via: "town",
                street: "Maple Lane",
                role: "travel agent",
                wear: ["adventurer hat"],
                ...plannerLooks,
              },
              {
                id: "room:local:trip",
                name: "trip",
                kind: "room",
                agents: plannerAt === "room:local:trip" ? ["planner", "writer"] : ["writer"],
                via: "office",
                ...(tripTalked ? { talked: tripTalked } : {}),
              },
              ...mapExtra,
            ],
            areas: [{ id: "main", name: "the town", places: ["town", "lobby"] }],
            town: townPlan,
          }),
        );
      if (url === `/api/ext/builtin:places/scene/${encodeURIComponent("home:planner")}`)
        return new Response(
          JSON.stringify({
            id: "home:planner",
            place: { ...home, name: "planner's room" },
            company: plannerHome.map((a) => ({ agent: a, name: a, avatar: `/api/live/avatar?agent=${a}` })),
            doors: [{ wall: "back", along: 1, to: "town", label: "Maple Lane", kind: "town" }],
          }),
        );
      if (url === `/api/ext/builtin:places/scene/${encodeURIComponent("town")}`)
        return new Response(
          JSON.stringify({
            id: "town",
            place: { ...home, name: "the town", props: townExtra, town: townPlan },
            company: [],
            doors: [
              { wall: "front", along: 0, at: [0, -15.5], facing: 0, to: "lobby", label: "Town hall", kind: "lobby" },
              {
                wall: "front",
                along: 0,
                at: [-33.7, -10],
                facing: 90,
                to: "home:planner",
                label: "planner",
                kind: "home",
                occupant: "planner",
              },
              {
                wall: "front",
                along: 0,
                at: [-26.3, -10],
                facing: -90,
                to: "home:talker",
                label: "talker",
                kind: "home",
                occupant: "talker",
              },
            ],
          }),
        );
      if (url === `/api/ext/builtin:places/scene/${encodeURIComponent("room:local:trip")}`)
        return new Response(
          JSON.stringify({
            id: "room:local:trip",
            place: { ...home, name: "trip" },
            company: ["planner", "writer"].map((a) => ({ agent: a, name: a, avatar: `/api/live/avatar?agent=${a}` })),
          }),
        );
      if (url.startsWith("/api/project-tasks") && init?.method === "POST") {
        posts.push({ url: "/api/project-tasks", body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: "t9" }), { status: 201 });
      }
      const one = url.match(/^\/api\/project-tasks\/([^/?]+)$/);
      if (one && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push({ id: one[1], body });
        taskRows = taskRows.map((t) => (t.id === one[1] ? { ...t, ...body, updated_at: "2026-10-04 09:00:00" } : t));
        return new Response(JSON.stringify(taskRows.find((t) => t.id === one[1])));
      }
      if (one) return new Response(JSON.stringify({ ...taskRows.find((t) => t.id === one[1]), comments: [] }));
      if (url.startsWith("/api/project-tasks")) {
        await tasksHeld;
        const statuses = new URL(url, "http://t").searchParams.get("status")?.split(",") ?? [];
        const tasks = taskRows.filter((t) => statuses.includes(String(t.status)));
        return new Response(JSON.stringify({ tasks, total: tasks.length }));
      }
      if (url === "/api/projects/p1") return new Response(JSON.stringify({ id: "p1", title: "Lisbon trip" }));
      if (url === "/api/task-watcher") return new Response(JSON.stringify(watcherInfo));
      if (url.startsWith("/api/schedules")) return new Response(JSON.stringify({ schedules: bookedRows }));
      if (url === "/api/cron") return new Response(JSON.stringify({ enabled: false, jobs: [] }));
      if (url === "/api/dashboard")
        return dashboardDown
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500, statusText: "Internal Server Error" })
          : new Response(JSON.stringify({ widgets: dashboardWidgets }));
      if (url === "/api/health") return new Response(JSON.stringify({ status: "ok", model: "a-model", uptime: 600 }));
      if (url === "/api/exploratory/agents")
        return new Response(JSON.stringify({ enabled: true, activity: null, agents: ownAgents }));
      if (url.startsWith("/api/exploratory/runs")) return new Response(JSON.stringify({ runs: [] }));
      if (url.startsWith("/api/exploratory/agents/")) {
        posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response("{}");
      }
      if (url === "/api/ext/builtin:places/talker")
        return new Response(
          JSON.stringify({
            type: "place",
            id: placeId,
            version: 1,
            place: homeExtra.length ? { ...home, props: [...home.props, ...homeExtra] } : home,
            company,
            doors: [{ wall: "back", along: homeDoorAlong, to: "town", label: "Maple Lane", kind: "town" }],
            ...(ownWear ? { wear: ownWear } : {}),
            ...ownLooks,
          }),
        );
      if (url.startsWith("/api/state/talk/") && init?.method === "PUT") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("{}");
      }
      const talkRow = url.match(/^\/api\/state\/talk\/([^/?]+)$/);
      if (talkRow && !init?.method) {
        const row = talkRows[decodeURIComponent(talkRow[1])];
        return row
          ? new Response(JSON.stringify({ type: "talk", id: talkRow[1], ...row }))
          : new Response(JSON.stringify({ error: "No talk record" }), { status: 404 });
      }
      if (url === "/api/live/models") return new Response(JSON.stringify({ models: modelNames }));
      if (url.match(/^\/api\/state\/body\/[^/?]+$/) && !init?.method)
        return new Response(JSON.stringify({ error: "No body record" }), { status: 404 });
      if ((url.startsWith("/api/state/body/") || url.startsWith("/api/state/emote/")) && init?.method === "PUT") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (wearStatus !== 200)
          return new Response(JSON.stringify({ error: "The store is read-only." }), { status: wearStatus });
        return new Response("{}");
      }
      if (init?.method === "DELETE") {
        deleted.push(url);
        if (missing.includes(url)) return new Response(JSON.stringify({ error: "No record" }), { status: 404 });
        return new Response("{}");
      }
      if (url === "/api/live/sessions") {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        if (sessionStatus !== 201)
          return new Response(JSON.stringify({ error: "Live sessions are off." }), { status: sessionStatus });
        return new Response(JSON.stringify({ id: `live-${posts.length}`, conversation: "conv-1" }), { status: 201 });
      }
      if (url === "/api/live/say") {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(new Blob(["voice"], { type: "audio/mpeg" }));
      }
      if (url === "/api/live/idle") {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ cues: [{ name: "go", target: "the window" }] }));
      }
      if (url.endsWith("/turn")) {
        posts.push({ url, body: "audio" });
        return streamed(turnChunks, turnHeld);
      }
      return new Response("{}");
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const extras: { body?: unknown; onCue?: (c: { name: string; target?: string }) => void }[] = [];

function Harness({ following, ...props }: Partial<ChatStageOptions> & { following?: boolean }) {
  // As the chat page does: switching who you talk to changes the agent the scene is told about.
  const [agent, setAgent] = useState("talker");
  const scene = useChatStage({
    agent,
    sessionKey: "web:kitchen",
    sending: false,
    panelOpen: true,
    onSpoken: (conversation, key) => spoken.push([conversation, key]),
    setTurnExtras: (e) => extras.push(e),
    onChatWith: (name) => {
      chattedWith.push(name);
      if (following) setAgent(name);
    },
    onDraft: (name, text) => drafts.push([name, text]),
    onReply: (name, session, text) => replies.push([name, session, text]),
    ...props,
  });
  return (
    <div>
      {scene.stage}
      {scene.has3d && (
        <button type="button" className="toggle-3d" onClick={() => scene.setStageOn(!scene.stageOn)}>
          3D
        </button>
      )}
      {scene.voiceEnabled && <TalkButton voice={scene.voice} />}
      {scene.voice.error && <p className="voice-error">{scene.voice.error}</p>}
      {scene.talk && (
        <p className="talk-shown">
          {scene.talk.phone ? "on the phone with" : "beside"} {scene.talk.name}
          {scene.talk.brief ? ", briefly" : ""}
        </p>
      )}
    </div>
  );
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Render the scene; `talk` is what the page would draw as your conversation in the world. */
async function render(props: Partial<ChatStageOptions> & { following?: boolean } = {}, talk: ReactNode = null) {
  await act(async () => {
    root.render(
      <TalkSlot.Provider value={talk}>
        <Harness {...props} />
      </TalkSlot.Provider>,
    );
  });
  // The stage is imported on demand: when one is due, wait until it exists.
  const due = typeof liveInfo.avatar === "string" && localStorage.getItem("tai.chat.stage") !== "off";
  await act(async () => {
    await vi.waitFor(
      () => {
        if (due && stage.mounted < 1) throw new Error("the stage has not loaded yet");
      },
      { timeout: 3000, interval: 10 },
    );
  });
  await settle();
}

async function talk() {
  const button = container.querySelector(".chat-talk-btn") as HTMLButtonElement;
  await act(async () => {
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  await settle();
  await act(async () => {
    button.dispatchEvent(new Event("pointerup", { bubbles: true }));
  });
  await settle();
}

describe("the chat page's scene", () => {
  it("shows the agent's body, with its animations, framed beside the chat panel", async () => {
    await render();
    expect(stage.calls.map((c) => c.url)).toEqual(["/api/live/avatar?agent=talker"]);
    expect(stage.calls[0].animations).toEqual(["/api/live/animations/0?agent=talker"]);
    expect(stage.insets.at(-1)).toBeGreaterThan(0);
    // Everything over the stage says what agents are doing in the colours its doors and signs use.
    const over = container.querySelector(".talk-stage") as HTMLElement;
    expect(over.style.getPropertyValue("--doing-waiting")).toBe(doingCss("waiting"));
    expect(over.style.getPropertyValue("--doing-stuck")).toBe(doingCss("stuck"));
  });

  it("shows the agent's own room, and redraws it the moment the agent changes it", async () => {
    await render();
    expect(stage.rooms.at(-1)?.name).toBe("talker's room");
    // What the body is told it can go to comes from that room.
    const aimed = (extras.at(-1)?.body as { aimed: { verb: string; targets: string[] }[] }).aimed;
    expect(aimed.find((a) => a.verb === "go")?.targets).toContain("the reading chair");
    const rearranged = {
      ...home,
      props: [...home.props, { id: "lamp", name: "the lamp", kind: "lamp", at: [1, -1], facing: 0 }],
    };
    // Someone else's room changing is not this one.
    await act(async () =>
      FakeEventSource.last?.emit("change", { type: "place", id: "home:other", op: "update", after: rearranged }),
    );
    expect(stage.rooms.at(-1)?.props).toHaveLength(1);
    await act(async () =>
      FakeEventSource.last?.emit("change", { type: "place", id: "home:talker", op: "update", after: rearranged }),
    );
    await settle();
    // Its door stayed where it was, so the room stands as changed, not drawn again from the server's answer.
    expect(stage.rooms.at(-1)?.props.map((p) => p.name)).toEqual(["the reading chair", "the lamp"]);
    const drawn = stage.rooms.length;
    expect(stage.rooms.at(-1)?.doors?.map((d) => d.along)).toEqual([1]);
    // A change that moves the door (something cleared from the end of a wall): the door moves with it.
    homeDoorAlong = 2.5;
    await act(async () =>
      FakeEventSource.last?.emit("change", { type: "place", id: "home:talker", op: "update", after: home }),
    );
    await settle();
    expect(stage.rooms.length).toBeGreaterThan(drawn);
    expect(stage.rooms.at(-1)?.doors?.map((d) => d.along)).toEqual([2.5]);
  });

  it("shows who else is in the room, and the agent knows they are there", async () => {
    placeId = "shared:lounge";
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    await render();
    expect(stage.company.at(-1)).toEqual(["planner"]);
    const body = extras.at(-1)?.body as { looks: string; aimed: { verb: string; targets: string[] }[] };
    expect(body.looks).toMatch(/with planner/);
    expect(body.aimed.find((a) => a.verb === "look")?.targets).toContain("planner");
    const drawn = stage.rooms.length;
    // Someone leaves: the room is asked again, and they go, the room itself left standing rather than built again.
    company = [];
    await act(async () => FakeEventSource.last?.emit("change", { type: "whereabouts", id: "planner", op: "delete" }));
    await settle();
    expect(stage.company.at(-1)).toEqual([]);
    expect(stage.rooms.length).toBe(drawn);
    // Someone comes to talk: a visit is coming too.
    company = [{ agent: "writer", name: "writer", avatar: "/api/live/avatar?agent=writer", animations: [] }];
    await act(async () => FakeEventSource.last?.emit("change", { type: "visit", id: "writer", op: "create" }));
    await settle();
    expect(stage.company.at(-1)).toEqual(["writer"]);
    expect(stage.rooms.length).toBe(drawn);
  });

  it("tells the stage where each body went and came from, a visit beginning and ending where the body lives", async () => {
    await render();
    const emit = (change: Record<string, unknown>) =>
      act(async () => FakeEventSource.last?.emit("change", { op: "update", ...change }));
    // Planner lives in the lounge now, and goes out on its day to a friend's, then back.
    await emit({ type: "whereabouts", id: "planner", op: "create", after: { place: "shared:lounge" } });
    expect(stage.wentBy?.("planner")).toEqual({ from: "home:planner", to: "shared:lounge" });
    await emit({ type: "visit", id: "planner", op: "create", after: { place: "home:writer", errand: "friend" } });
    expect(stage.wentBy?.("planner")).toEqual({ from: "shared:lounge", to: "home:writer" });
    await emit({ type: "visit", id: "planner", op: "delete", before: { place: "home:writer" } });
    expect(stage.wentBy?.("planner")).toEqual({ from: "home:writer", to: "shared:lounge" });
    // Writer has no whereabouts: it lives at home.
    await emit({ type: "visit", id: "writer", op: "create", after: { place: "room:local:trip" } });
    expect(stage.wentBy?.("writer")).toEqual({ from: "home:writer", to: "room:local:trip" });
  });

  it("tells the stage who is here, and leaves out anyone without a body to draw", () => {
    expect(
      companyOf({
        company: [
          { agent: "planner", avatar: "/api/live/avatar?agent=planner" },
          { agent: "writer", avatar: "/api/live/avatar?agent=writer" },
          { agent: "ghost" },
        ],
      }),
    ).toEqual([
      { agent: "planner", name: "planner", url: "/api/live/avatar?agent=planner", animations: [] },
      { agent: "writer", name: "writer", url: "/api/live/avatar?agent=writer", animations: [] },
    ]);
  });

  it("tells the stage when the agent has gone to another place, rather than its room changing", async () => {
    await render();
    const before = stage.moves.length;
    // It goes to the lounge: a new place, whoever is there already about.
    placeId = "shared:lounge";
    await act(async () => FakeEventSource.last?.emit("change", { type: "whereabouts", id: "talker", op: "create" }));
    await settle();
    expect(stage.moves.slice(before)).toEqual([true]);
    // The lounge changing round it is the same place.
    const rearranged = { ...home, props: home.props.slice(0, 1) };
    await act(async () =>
      FakeEventSource.last?.emit("change", { type: "place", id: "shared:lounge", op: "update", after: rearranged }),
    );
    await settle();
    expect(stage.moves.at(-1)).toBe(false);
  });

  it("shows what every agent is doing, and keeps up as that changes", async () => {
    activityRecords = [{ id: "talker", data: { agent: "talker", doing: "thinking", what: "thinking" } }];
    await render();
    expect(stage.agents.at(-1)).toBe("talker");
    expect(stage.activities.at(-1)?.talker?.doing).toBe("thinking");
    const working = { agent: "planner", doing: "working", what: "taking a photo", look: "camera" };
    await act(async () =>
      FakeEventSource.last?.emit("change", { type: "activity", id: "planner", op: "update", after: working }),
    );
    expect(stage.activities.at(-1)).toMatchObject({ talker: { doing: "thinking" }, planner: { doing: "working" } });
    // Other kinds of record are none of its business; a record that goes, goes.
    const before = stage.activities.length;
    await act(async () => FakeEventSource.last?.emit("change", { type: "plan", id: "x", op: "update", after: {} }));
    expect(stage.activities.length).toBe(before);
    await act(async () => FakeEventSource.last?.emit("change", { type: "activity", id: "planner", op: "delete" }));
    expect(Object.keys(stage.activities.at(-1) ?? {})).toEqual(["talker"]);
  });

  it("hands the stage what each agent last said, and each new line as it is said", async () => {
    speechRecords = [
      { id: "planner", data: { agent: "planner", text: "Flights booked.", at: "2026-10-18T10:00:00Z" } },
    ];
    await render();
    expect(stage.speech.at(-1)?.planner?.text).toBe("Flights booked.");
    const line = { agent: "writer", text: "Draft is up.", at: "2026-10-18T10:00:05Z" };
    await act(async () =>
      FakeEventSource.last?.emit("change", { type: "speech", id: "writer", op: "update", after: line }),
    );
    expect(stage.speech.at(-1)).toMatchObject({
      planner: { text: "Flights booked." },
      writer: { text: "Draft is up." },
    });
  });

  async function pick(agent: string) {
    const onPick = stage.calls.at(-1)?.onPick;
    expect(onPick).toBeDefined();
    await act(async () => onPick?.(agent, { x: 200, y: 150 }));
    await settle();
    return [...container.querySelectorAll(".agent-menu button")] as HTMLButtonElement[];
  }

  async function press(buttons: HTMLButtonElement[], label: string) {
    const button = buttons.find((b) => b.textContent === label);
    expect(button, `no "${label}" in ${buttons.map((b) => b.textContent).join(", ")}`).toBeDefined();
    await act(async () => button?.click());
    await settle();
  }

  it("opens a menu on an agent's body: what it is doing, and what you can do about it", async () => {
    placeId = "shared:lounge";
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    agentsInfo = { planner: { online: { enabled: true } } };
    activityRecords = [{ id: "planner", data: { agent: "planner", doing: "working", what: "taking a photo" } }];
    whereaboutsRecords = [{ id: "planner", data: { place: "shared:lounge" } }];
    await render();
    const buttons = await pick("planner");
    expect(container.querySelector(".agent-menu-head")?.textContent).toMatch(/planner.*taking a photo/);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Chat with planner",
      "Send home",
      "Pause for 4 hours",
      "About planner",
    ]);
    // Home from the shared place it went to: the record it has, and not a visit it doesn't have, which would only be
    // a 404 in the console.
    await press(buttons, "Send home");
    expect(deleted).toEqual(["/api/state/whereabouts/planner"]);
    expect(container.querySelector(".agent-menu-problem")).toBeNull();
    // Done, it closes.
    expect(container.querySelector(".agent-menu")).toBeNull();
    await press(await pick("planner"), "Pause for 4 hours");
    expect(posts.find((p) => p.url === "/api/exploratory/agents/planner/pause")?.body).toEqual({ hours: 4 });
    await press(await pick("planner"), "Chat with planner");
    expect(chattedWith).toEqual(["planner"]);
  });

  it("wakes a paused agent, and offers nothing that doesn't apply to the agent you are talking to at home", async () => {
    agentsInfo = { talker: { online: { enabled: true } } };
    activityRecords = [
      { id: "talker", data: { agent: "talker", doing: "asleep", what: "asleep", detail: "paused" } as never },
    ];
    await render();
    const buttons = await pick("talker");
    expect(buttons.map((b) => b.textContent)).toEqual(["Wake up", "About talker"]);
    await press(buttons, "Wake up");
    expect(posts.some((p) => p.url === "/api/exploratory/agents/talker/resume")).toBe(true);
  });

  it("offers no pause for an agent that doesn't run on its own, and closes on Escape", async () => {
    await render();
    const buttons = await pick("talker");
    expect(buttons.map((b) => b.textContent)).toEqual(["About talker"]);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.querySelector(".agent-menu")).toBeNull();
  });

  it("opens the map, goes to a room in your own body, and comes back to the agent", async () => {
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    const rooms = [...container.querySelectorAll(".world-map-place")] as HTMLButtonElement[];
    // The meeting room, and the town last, where you arrive by the map.
    expect(rooms.map((r) => r.querySelector(".world-map-name")?.textContent)).toEqual(["#trip", "the town"]);
    // Agents by name, the one whose home you are in marked.
    const people = [...container.querySelectorAll(".world-map-who")];
    expect(people.map((p) => p.querySelector(".world-map-who-name")?.textContent)).toEqual(["planner", "talker"]);
    expect(people[1].getAttribute("aria-current")).toBe("location");
    await act(async () => rooms[0].click());
    await settle(60);
    // A new stage, the visitor's, with everyone in the room as company, and the map put away.
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.company.at(-1)).toEqual(["planner", "writer"]);
    expect(container.querySelector(".world-map")).toBeNull();
    // The agent's cues have no body to move while you visit.
    expect(extras.at(-1)?.body).toBeUndefined();
    // Standing next to someone offers to talk to them.
    await act(async () => stage.onNear?.("writer"));
    await act(async () => tool("Talk to writer").click());
    expect(chattedWith).toEqual(["writer"]);
    await act(async () => tool("Back to talker").click());
    await settle(60);
    expect(stage.visitors.at(-1)).toBe(false);
    expect(extras.at(-1)?.body).toBeDefined();
  });

  it("goes through doors in your own body: out of the agent's room on to the street, and on into another home", async () => {
    await render({ following: true });
    expect(stage.rooms.at(-1)?.doors?.map((d) => d.to)).toEqual(["town"]);
    // From the agent's own view, a door starts a visit: your body, come out of the door on the other side.
    await act(async () => stage.onDoor?.({ to: "town" }));
    await settle(60);
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.arrivals.at(-1)).toBe("home:talker");
    expect(stage.rooms.at(-1)?.name).toBe("the town");
    // The street is nobody's home: the conversation goes on.
    expect(chattedWith).toEqual([]);
    const made = stage.calls.length;
    // On through the next door: the same stage, the same body, into planner's home from the street, talking to planner.
    await act(async () => stage.onDoor?.({ to: "home:planner" }));
    await settle(60);
    expect(stage.calls.length).toBe(made);
    expect(stage.entered.at(-1)).toBe("town");
    expect(stage.rooms.at(-1)?.name).toBe("planner's room");
    expect(stage.company.at(-1)).toEqual(["planner"]);
    expect(chattedWith).toEqual(["planner"]);
    // The map takes you somewhere at its start, not by a door: still the same stage.
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    const trip = [...container.querySelectorAll(".world-map-place")].find((b) =>
      b.querySelector(".world-map-name")?.textContent?.startsWith("#trip"),
    ) as HTMLButtonElement;
    await act(async () => trip.click());
    await settle(60);
    expect(stage.calls.length).toBe(made);
    expect(stage.entered.at(-1)).toBeUndefined();
    expect(stage.rooms.at(-1)?.name).toBe("trip");
  });

  it("talks to the agent whose home you go to, and to the one you came from when you come back", async () => {
    await render({ following: true });
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    /** By the map, to a room by its name or an agent's home by the agent's. */
    const go = async (name: string) => {
      await act(async () => tool("Map").click());
      await settle();
      const place = [...container.querySelectorAll(".world-map-name, .world-map-who-name")]
        .find((n) => n.textContent?.startsWith(name))
        ?.closest("button") as HTMLButtonElement;
      await act(async () => place.click());
      await settle(60);
    };
    await go("planner");
    expect(chattedWith).toEqual(["planner"]);
    // Still you in your own body, come from talker's: the way back says so.
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.calls.at(-1)?.url).toBe("/api/live/avatar?agent=talker");
    expect(tool("Back to talker")).toBeDefined();
    // A meeting room has nobody in particular to talk to: the conversation goes on.
    await go("#trip");
    expect(chattedWith).toEqual(["planner"]);
    await act(async () => tool("Back to talker").click());
    await settle(60);
    expect(chattedWith).toEqual(["planner", "talker"]);
    expect(stage.visitors.at(-1)).toBe(false);
    expect(stage.agents.at(-1)).toBe("talker");
    // Going to talker's own home on the map is coming back too.
    await go("planner");
    await go("talker");
    expect(chattedWith).toEqual(["planner", "talker", "planner", "talker"]);
    expect(stage.visitors.at(-1)).toBe(false);
  });

  it("keeps your conversation face to face while the agent walks out, and makes it a call once it has gone", async () => {
    // Sent home, the conversation card said "On the phone with artist" while artist still sat beside you.
    await render({ following: true, dialogue: true, panelOpen: false });
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    const planner = [...container.querySelectorAll(".world-map-who")].find(
      (b) => b.querySelector(".world-map-who-name")?.textContent === "planner",
    ) as HTMLButtonElement;
    await act(async () => planner.click());
    await settle(60);
    expect(chattedWith.at(-1)).toBe("planner");
    const shown = () => container.querySelector(".talk-shown")?.textContent;
    expect(shown()).toBe("beside planner");
    await act(async () => stage.onPresent?.(["planner"]));
    // Off out: the scene has it gone, but its body is still on its way to the door.
    plannerHome = [];
    await act(async () => FakeEventSource.last?.emit("change", { type: "visit", id: "planner", op: "create" }));
    await settle(60);
    expect(stage.company.at(-1)).toEqual([]);
    expect(shown()).toBe("beside planner");
    // Through the door: now it's a call.
    await act(async () => stage.onPresent?.([]));
    await settle();
    expect(shown()).toBe("on the phone with planner");
  });

  it("goes from the status board to an agent, its card open beside it once you get there", async () => {
    // The docs say a click on the board takes you to it with its card open; arriving at its home closed the card.
    await render({ following: true });
    await settle(60);
    await act(async () => stage.onUse?.("go", { agent: "planner" }));
    await settle(60);
    expect(chattedWith).toEqual(["planner"]);
    expect(stage.visitors.at(-1)).toBe(true);
    expect(container.querySelector(".world-agent .world-agent-name")?.textContent).toMatch(/planner/);
    // Arriving somewhere with another agent's card open still puts that card away: it isn't what you came for.
    expect(keptOnArrival({ kind: "agent", agent: "writer" }, "planner", true)).toBe(false);
    expect(keptOnArrival({ kind: "agent", agent: "planner" }, "planner", false)).toBe(false);
    expect(keptOnArrival({ kind: "map" }, "planner", false)).toBe(true);
  });

  it("goes straight to an agent waiting on you, in front of it once, and not again on a later visit", async () => {
    activityRecords = [
      {
        id: "planner",
        data: {
          agent: "planner",
          doing: "waiting",
          what: "has a question for you",
          question: "Window or aisle?",
          session: "s-asked",
        },
      },
    ];
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Needs you · 1").click());
    await settle();
    const row = container.querySelector(".world-needs-row") as HTMLButtonElement;
    await act(async () => row.click());
    await settle(60);
    // Into planner's home in your own body, standing in front of it, with its question open.
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.company.at(-1)).toEqual(["planner"]);
    expect(stage.greeted).toEqual(["planner"]);
    expect(container.querySelector(".world-need")?.textContent).toContain("Window or aisle?");
    // The 3D view off and on again: a new stage, in the same place, and you aren't sent to planner again.
    const toggle = () => container.querySelector(".toggle-3d") as HTMLButtonElement;
    await act(async () => toggle().click());
    await settle();
    const made = stage.calls.length;
    await act(async () => toggle().click());
    await settle(60);
    expect(stage.calls.length).toBe(made + 1);
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.greeted).toEqual(["planner"]);
    // The answer goes to the conversation it asked in.
    await act(async () => tool("Needs you · 1").click());
    await settle();
    await act(async () => (container.querySelector(".world-needs-row") as HTMLButtonElement).click());
    await settle(60);
    expect(stage.greeted).toEqual(["planner", "planner"]);
    await act(async () => tool("Answer in the chat").click());
    expect(replies).toEqual([["planner", "s-asked", "About your question, “Window or aisle?”: "]]);
    // Back, and to planner's home again by the map: a visit like any other, from its start.
    await act(async () => tool("Back to talker").click());
    await settle(60);
    expect(stage.visitors.at(-1)).toBe(false);
    await act(async () => tool("Map").click());
    await settle();
    const planner = [...container.querySelectorAll(".world-map-who-name")]
      .find((n) => n.textContent === "planner")
      ?.closest("button") as HTMLButtonElement;
    await act(async () => planner.click());
    await settle(60);
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.greeted).toEqual(["planner", "planner"]);
  });

  it("says who you came back to even when the switch away never happened, so a waiting one is called off", async () => {
    // Not following: as when the switch to planner is still waiting for a reply.
    await render();
    await act(async () =>
      ([...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === "Map") as HTMLElement).click(),
    );
    await settle();
    const planner = [...container.querySelectorAll(".world-map-who")].find(
      (b) => b.querySelector(".world-map-who-name")?.textContent === "planner",
    ) as HTMLButtonElement;
    await act(async () => planner.click());
    await settle(60);
    await act(async () =>
      (
        [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === "Back to talker") as HTMLElement
      ).click(),
    );
    await settle(60);
    expect(chattedWith).toEqual(["planner", "talker"]);
  });

  it("speaks what agents say near you, once you turn voices on, quieter further away", async () => {
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    await act(async () => (container.querySelector(".world-map-place") as HTMLButtonElement).click());
    await settle(60);
    // Off to start with: a line said nearby is only a bubble.
    await act(async () => stage.onLine?.("writer", "Draft is up.", 0.8));
    expect(posts.some((p) => p.url === "/api/live/say")).toBe(false);
    await act(async () => tool("Voices off").click());
    await act(async () => stage.onLine?.("writer", "Draft is up.", 0.5));
    await settle();
    expect(posts.find((p) => p.url === "/api/live/say")?.body).toEqual({ agent: "writer", text: "Draft is up." });
    const played = audios.at(-1) as unknown as { volume: number };
    expect(played.volume).toBeCloseTo(0.5);
    // Remembered for next time.
    expect(localStorage.getItem("tai.world.voices")).toBe("on");
  });

  it("plays the far side of a call down a telephone line, out of the phone of the one you stand by", async () => {
    const made: { kind: string; type?: string; value?: number; of?: string }[] = [];
    const node = (extra: Record<string, unknown> = {}, name = "node") => ({
      ...extra,
      connect: (next: unknown) => next,
      disconnect: () => made.push({ kind: "let go", of: name }),
    });
    const param = (kind: string) => {
      const p = { _v: 0 } as { _v: number; value: number };
      Object.defineProperty(p, "value", {
        get: () => p._v,
        set: (v: number) => {
          p._v = v;
          made.push({ kind, value: v });
        },
      });
      return p;
    };
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = node();
        createMediaElementSource() {
          made.push({ kind: "source" });
          return node({}, "source");
        }
        createBiquadFilter() {
          const f = node({ frequency: param("frequency"), Q: param("q"), gain: param("boost") });
          return new Proxy(f, {
            set: (t, k, v) => {
              if (k === "type") made.push({ kind: "filter", type: v });
              return Reflect.set(t, k, v);
            },
          });
        }
        createDynamicsCompressor() {
          made.push({ kind: "compressor" });
          return node({
            threshold: param("threshold"),
            knee: param("knee"),
            ratio: param("ratio"),
            attack: param("attack"),
            release: param("release"),
          });
        }
        createGain() {
          return node({ gain: param("volume") });
        }
        resume() {
          return Promise.resolve();
        }
      },
    );
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    await act(async () => (container.querySelector(".world-map-place") as HTMLButtonElement).click());
    await settle(60);
    await act(async () => tool("Voices off").click());
    // The far side of a call: down the line, through the phone's band and squeezed, quieter than a voice in the room.
    await act(async () => stage.onLine?.("writer", "On it.", 1, true));
    await settle();
    expect(posts.find((p) => p.url === "/api/live/say")?.body).toEqual({ agent: "writer", text: "On it." });
    expect(made.filter((m) => m.kind === "filter").map((m) => m.type)).toEqual(["highpass", "lowpass", "peaking"]);
    expect(made.some((m) => m.kind === "compressor")).toBe(true);
    expect(made.find((m) => m.kind === "volume")?.value).toBeLessThan(1);
    // Played through the line, not at the element's own volume; and the line let go once it is said, the element's
    // own way into it too.
    const played = audios.at(-1) as unknown as { volume?: number; onended: (() => void) | null };
    expect(played.volume).toBeUndefined();
    await act(async () => played.onended?.());
    await settle();
    expect(made.filter((m) => m.kind === "let go").length).toBe(6);
    expect(made.some((m) => m.kind === "let go" && m.of === "source")).toBe(true);
  });

  it("plays the far side plainly, quieter, when the browser never lets the phone line's sound out", async () => {
    let wired = 0;
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        createMediaElementSource() {
          wired++;
          return {};
        }
        // Held back for good: a promise that never settles.
        resume() {
          return new Promise(() => {});
        }
      },
    );
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    await act(async () => (container.querySelector(".world-map-place") as HTMLButtonElement).click());
    await settle(60);
    await act(async () => tool("Voices off").click());
    await act(async () => stage.onLine?.("writer", "On it.", 1, true));
    await settle(700);
    expect(wired).toBe(0);
    const played = audios.at(-1) as unknown as { volume?: number; onended: (() => void) | null };
    expect(played.volume).toBeCloseTo(0.7);
    // And the next line is still heard: nothing is left waiting on the browser.
    await act(async () => played.onended?.());
    await act(async () => stage.onLine?.("planner", "Thanks.", 0.8));
    await settle();
    expect(posts.filter((p) => p.url === "/api/live/say").map((p) => (p.body as { text: string }).text)).toEqual([
      "On it.",
      "Thanks.",
    ]);
  });

  it("puts the agent you talk to from somewhere else on the phone, and you too, with your words over your head", async () => {
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    // Out into the town, where talker's body isn't.
    await act(async () =>
      (
        [...container.querySelectorAll(".world-map-place")].find((b) =>
          b.textContent?.startsWith("the town"),
        ) as HTMLButtonElement
      ).click(),
    );
    await settle(60);
    expect(stage.visitors.at(-1)).toBe(true);
    // You send talker a message, and wait for the answer.
    await render({ sending: true, exchange: { said: "Where are we on the itinerary?" } });
    await settle();
    const wrote = posts.find((p) => p.url === "/api/state/talk/talker")?.body as {
      data: { with: string; phone?: boolean; until: string };
    };
    expect(wrote.data).toMatchObject({ with: "you", phone: true });
    expect(Date.parse(wrote.data.until)).toBeGreaterThan(Date.now());
    const shown = stage.activities.at(-1) as Record<string, { doing: string; what?: string; talk?: unknown }>;
    expect(shown.you).toMatchObject({ doing: "talking", what: "on the phone with talker", talk: { phone: true } });
    expect(stage.speech.at(-1)?.you?.text).toBe("Where are we on the itinerary?");
    // The answer comes, and shows as said by talker: out of your phone, as talker isn't here.
    await render({ sending: false, exchange: { said: "Where are we on the itinerary?", reply: "By noon." } });
    await settle();
    expect(stage.speech.at(-1)?.talker?.text).toBe("By noon.");
    // Typed, it was never heard out loud: voices nearby may say it.
    expect((stage.speech.at(-1)?.talker as { voiced?: boolean }).voiced).toBeUndefined();
    expect(posts.filter((p) => p.url === "/api/state/talk/talker").length).toBeGreaterThan(1);
  });

  it("shows a spoken turn on a visit in bubbles, its reply marked as heard already so it isn't voiced twice", async () => {
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    await act(async () =>
      (
        [...container.querySelectorAll(".world-map-place")].find((b) =>
          b.textContent?.startsWith("the town"),
        ) as HTMLButtonElement
      ).click(),
    );
    await settle(60);
    await act(async () => tool("Voices off").click());
    await talk();
    expect(stage.speech.at(-1)?.you?.text).toBe("come sit down");
    // The turn played the reply itself, sentence by sentence.
    expect(stage.speech.at(-1)?.talker).toMatchObject({ text: "Coming over.", to: ["you"], voiced: true });
  });

  it("ends your talk with an agent as you leave the visit, on every page, but not a talk it has with another", async () => {
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    const visitHall = async () => {
      await act(async () => tool("Map").click());
      await settle();
      await act(async () =>
        (
          [...container.querySelectorAll(".world-map-place")].find((b) =>
            b.textContent?.startsWith("the town"),
          ) as HTMLButtonElement
        ).click(),
      );
      await settle(60);
    };
    await visitHall();
    await render({ sending: true, exchange: { said: "Where are we?" } });
    await render({ sending: false, exchange: { said: "Where are we?", reply: "By noon." } });
    talkRows.talker = { version: 3, data: { with: "you", phone: true } };
    await act(async () => tool("Back to talker").click());
    await settle(60);
    expect(deleted).toEqual(["/api/state/talk/talker?expectedVersion=3"]);
    // And what was said on the visit goes with it: the agent's own view shows nothing of it.
    expect(stage.speech.at(-1)?.talker).toBeUndefined();
    expect(stage.speech.at(-1)?.you).toBeUndefined();
    // Once more, but by the time you leave the places plugin has it talking with someone else: that talk stays.
    deleted.length = 0;
    await visitHall();
    await render({ sending: true, exchange: { said: "And now?" } });
    talkRows.talker = { version: 5, data: { with: "writer", phone: true } };
    await act(async () => tool("Back to talker").click());
    await settle(60);
    expect(deleted).toEqual([]);
  });

  it("talks face to face with an agent you visit, and shows others' talks as they change", async () => {
    await render({ following: true });
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    const planner = [...container.querySelectorAll(".world-map-who")].find(
      (b) => b.querySelector(".world-map-who-name")?.textContent === "planner",
    ) as HTMLButtonElement;
    await act(async () => planner.click());
    await settle(60);
    expect(chattedWith.at(-1)).toBe("planner");
    await render({ following: true, sending: true, exchange: { said: "Ready?" } });
    await settle();
    const wrote = posts.filter((p) => p.url === "/api/state/talk/planner").at(-1)?.body as {
      data: { with: string; phone?: boolean };
    };
    expect(wrote.data.with).toBe("you");
    expect(wrote.data.phone).toBeUndefined();
    // Someone else's talk, as the places plugin writes it: on the page at once, in its words.
    const until = new Date(Date.now() + 30_000).toISOString();
    await act(async () =>
      FakeEventSource.last?.emit("change", {
        type: "talk",
        id: "writer",
        op: "create",
        after: { with: "editor", phone: true, until },
      }),
    );
    await settle();
    const shown = stage.activities.at(-1) as Record<string, { what?: string }>;
    expect(shown.writer?.what).toBe("on the phone with editor");
  });

  it("opens and closes the map with M, unless you are typing", async () => {
    await render();
    const press = new KeyboardEvent("keydown", { code: "KeyM", cancelable: true });
    await act(async () => window.dispatchEvent(press));
    await settle();
    expect(container.querySelector(".world-map")).not.toBeNull();
    // The M that opened it isn't typed into its search as it takes the focus.
    expect(press.defaultPrevented).toBe(true);
    const field = document.createElement("textarea");
    container.appendChild(field);
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", bubbles: true })));
    expect(container.querySelector(".world-map")).not.toBeNull();
  });

  it("asks for the map again each time it opens, so an agent made since is on it", async () => {
    await render();
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    const people = () =>
      [...container.querySelectorAll(".world-map-who-name")].map((p) => p.textContent).filter((n) => n !== "talker");
    await act(async () => tool("Map").click());
    await settle();
    expect(people()).toEqual(["planner"]);
    // An agent made from the lobby's kiosk: nobody came or went, so nothing says so but the map itself.
    mapExtra = [
      { id: "home:newcomer", name: "newcomer's room", kind: "home", owner: "newcomer", agents: ["newcomer"] },
    ];
    await act(async () => tool("Map").click());
    await settle();
    await act(async () => tool("Map").click());
    await settle();
    expect(people()).toEqual(["newcomer", "planner"]);
  });

  it("says where you are over the stage, from the town down, and each step goes there", async () => {
    await render({ following: true });
    await settle(60);
    const trail = () => container.querySelector(".world-trail");
    const step = (label: string) =>
      [...(trail()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
    expect(trail()?.textContent).toBe("Town›Maple Lane›talker's home");
    expect(trail()?.querySelector("[aria-current]")?.textContent).toBe("talker's home");
    // The street's step takes you out of the door on to it, in your own body.
    await act(async () => step("Maple Lane")?.click());
    await settle(60);
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.arrivals.at(-1)).toBe("home:talker");
    expect(trail()?.textContent).toBe("Town");
    // Into planner's home and back out by the town's step: on the square this time, not by any door.
    await act(async () => stage.onDoor?.({ to: "home:planner" }));
    await settle(60);
    expect(trail()?.textContent).toBe("Town›Maple Lane›planner's home");
    await act(async () => step("Town")?.click());
    await settle(60);
    expect(stage.entered.at(-1)).toBeUndefined();
    expect(stage.rooms.at(-1)?.name).toBe("the town");
  });

  it("shows bodies going by in the town, from the door of where they were to the door of where they went", async () => {
    await render();
    await act(async () => stage.onDoor?.({ to: "town" }));
    await settle(60);
    expect(stage.walks).toEqual([]);
    // Planner goes to talk in the trip's room, which is in the office: out of its front door, and to the office's.
    plannerAt = "room:local:trip";
    await act(async () => FakeEventSource.last?.emit("change", { type: "visit", id: "planner", op: "create" }));
    await settle(60);
    expect(stage.walks.map((w) => w.agent)).toEqual(["planner"]);
    const [walk] = stage.walks;
    expect(walk.from[0]).toBeGreaterThan(-36 + 2.3);
    expect(walk.from[1]).toBeCloseTo(-10);
    expect(walk.to[0]).toBeCloseTo(24);
    expect(walk.to[1]).toBeGreaterThan(-10 + 5);
    // Back home again, the same way back.
    plannerAt = "home:planner";
    await act(async () => FakeEventSource.last?.emit("change", { type: "visit", id: "planner", op: "delete" }));
    await settle(60);
    expect(stage.walks.at(-1)).toEqual({ agent: "planner", from: walk.to, to: walk.from });
  });

  it("shows each agent's day: out at its seat, the buildings with someone in them lit, and what a room said on its whiteboard", async () => {
    const said = new Date(Date.now() - 5 * 60_000).toISOString();
    activityRecords = [{ id: "planner", data: { agent: "planner", doing: "idle", what: "idle" } }];
    outingRecords = [
      {
        id: "planner",
        data: {
          place: "town",
          until: "2099-01-01T00:00:00Z",
          spot: "cafe-1-a",
          errand: "cafe",
          what: "having a coffee at the café",
        },
      },
    ];
    chatterRecords = [
      {
        id: "room:local:trip",
        data: {
          room: "trip",
          last: said,
          lines: [{ id: "1", who: "planner", agent: "planner", words: "Flights are booked…", at: said }],
        },
      },
    ];
    await render();
    await act(async () => stage.onDoor?.({ to: "town" }));
    await settle(60);
    const planner = stage.activities.at(-1)?.planner as unknown as { what: string; routine?: Record<string, unknown> };
    expect(planner).toMatchObject({
      what: "having a coffee at the café",
      routine: { errand: "cafe", spot: "cafe-1-a" },
    });
    // Writer is in the trip's meeting room, on the office's floor: the office is lit, and both homes with someone in.
    expect(stage.occupied.at(-1)).toEqual(["home:planner", "home:talker", "office"]);
    // Leaving the town, a body walks to the door of where it went: home, as the map says.
    expect(stage.exitFor?.("planner")).toEqual(doorInTown(townPlan as never, "home:planner"));
    // Clicked, it says where it is, though it has nothing to do, and you can send it home from its day out.
    const buttons = await pick("planner");
    expect(container.querySelector(".agent-menu-head")?.textContent).toMatch(/planner.*having a coffee at the café/);
    await press(buttons, "Send home");
    // Its day out ends; it lives at home, which is no record, so there is none to delete (and no 404 for it).
    expect(deleted).toEqual(["/api/state/visit/planner"]);
    // The card on the trip's door, and its whiteboard inside.
    expect(stage.talked.at(-1)?.["room:local:trip"]).toBe(said);
    // The room woke someone since it last said anything: the door and the board both say so.
    tripTalked = new Date(Date.now() - 2 * 60_000).toISOString();
    await act(async () => FakeEventSource.last?.emit("change", { type: "visit", id: "writer", op: "update" }));
    await settle(60);
    expect(stage.talked.at(-1)?.["room:local:trip"]).toBe(tripTalked);
    await act(async () => stage.onDoor?.({ to: "room:local:trip" }));
    await settle(60);
    expect(stage.notes.at(-1)).toEqual({
      room: "trip",
      // Counted from the start of this minute: one or two minutes, by where in the minute it is.
      talked: expect.stringMatching(/^talked [12] min ago$/),
      lines: [{ who: "planner", agent: "planner", words: "Flights are booked…", ink: expect.any(String) }],
    });
  });

  it("lights a home as a home, and the town by the sky and its street lamps", async () => {
    await render({ following: true });
    await settle(60);
    expect(stage.lights.at(-1)).toBe("home");
    await act(async () => stage.onDoor?.({ to: "town" }));
    await settle(60);
    expect(stage.lights.at(-1)).toBe("outdoor");
    await act(async () => stage.onDoor?.({ to: "home:planner" }));
    await settle(60);
    expect(stage.lights.at(-1)).toBe("home");
  });

  it("says where a door goes while the pointer is over it", async () => {
    await render();
    await settle(60);
    await act(async () =>
      stage.onDoorHover?.({ to: "town", kind: "town", label: "Maple Lane" } as never, { x: 40, y: 60 }),
    );
    const tip = container.querySelector(".door-tip") as HTMLElement;
    expect(tip.textContent).toBe("out to Maple Lane");
    expect([tip.style.left, tip.style.top]).toEqual(["40px", "60px"]);
    await act(async () => stage.onDoorHover?.(undefined));
    expect(container.querySelector(".door-tip")).toBeNull();
  });

  it("shows the agent's own tasks on the boards in its room", async () => {
    await render();
    await settle(60);
    expect(stage.tasks.at(-1)?.map((t) => t.id)).toEqual(["t1"]);
  });

  it("makes a task from the kiosk, assigned to whoever you pick", async () => {
    agentsInfo = { planner: {}, writer: {} };
    await render();
    await act(async () => stage.onUse?.("new-task"));
    const form = container.querySelector(".new-task") as HTMLFormElement;
    expect(form).not.toBeNull();
    const set = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    };
    await act(async () => set(form.querySelector("input") as HTMLInputElement, "Book the ferry"));
    await act(async () => set(form.querySelector("select") as HTMLSelectElement, "writer"));
    expect(form.textContent).toMatch(/writer starts on it/);
    await act(async () => form.requestSubmit());
    await settle();
    expect(posts.find((p) => p.url === "/api/project-tasks")?.body).toEqual({
      title: "Book the ferry",
      assignee: "writer",
    });
    expect(container.querySelector(".new-task-made")?.textContent).toBe('Made "Book the ferry" for writer.');
  });

  /** Set a field's value the way typing would, so React hears it. */
  const fill = async (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  };
  const buttonsIn = (selector: string) => [...container.querySelectorAll(`${selector} button`)] as HTMLButtonElement[];
  const shownOnBoard = () => stage.tasks.at(-1)?.map((t) => `${t.id}:${(t as { status?: string }).status}`);

  it("opens a task's card from its note on a board, and every change is on the board at once", async () => {
    await render();
    await settle(60);
    expect(shownOnBoard()).toEqual(["t1:backlog"]);
    await act(async () => stage.onUse?.("tasks", { task: "t1" }));
    await settle();
    const card = container.querySelector(".world-task") as HTMLElement;
    expect(card.querySelector(".world-panel-title")?.textContent).toBe("Book flights");
    expect(card.textContent).toMatch(/Out Friday, back Monday\./);
    expect(card.querySelector(".world-facts")?.textContent).toMatch(
      /Who\s*talker.*Project\s*Lisbon trip.*Made.*by sam/,
    );
    expect(card.querySelector('a[href="#/tasks/t1"]')).not.toBeNull();
    expect(window.location.hash).not.toMatch(/tasks/);

    // One click moves it, and the board shows it moved without waiting for its next look, even one asked straight
    // after the change and slow to come back.
    let answer = () => {};
    tasksHeld = new Promise<void>((r) => {
      answer = r;
    });
    await press(buttonsIn(".world-task-status"), "Doing");
    expect(patches.at(-1)).toEqual({ id: "t1", body: { status: "in_progress" } });
    expect(shownOnBoard()).toEqual(["t1:in_progress"]);
    tasksHeld = null;
    await act(async () => answer());
    await settle();
    expect(shownOnBoard()).toEqual(["t1:in_progress"]);
    expect(card.querySelector('.world-task-status button[aria-pressed="true"]')?.textContent).toBe("Doing");

    // Its words, edited in place; Escape in a box lets go of the edit, not the card.
    await press(buttonsIn(".world-task-words"), "Edit");
    const title = card.querySelector(".world-task-edit input") as HTMLInputElement;
    await act(async () => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(card.querySelector(".world-task-edit")).toBeNull();
    expect(container.querySelector(".world-task")).not.toBeNull();
    await press(buttonsIn(".world-task-words"), "Edit");
    await fill(card.querySelector(".world-task-edit input") as HTMLInputElement, "Book the flights");
    await fill(card.querySelector(".world-task-edit textarea") as HTMLTextAreaElement, "TAP, Friday 09:40.");
    await act(async () => (card.querySelector(".world-task-edit") as HTMLFormElement).requestSubmit());
    await settle();
    expect(patches.at(-1)).toEqual({
      id: "t1",
      body: { title: "Book the flights", description: "TAP, Friday 09:40." },
    });
    expect(card.querySelector(".world-panel-title")?.textContent).toBe("Book the flights");

    // Archived, it's off the boards.
    await press(buttonsIn(".world-task"), "Archive");
    expect(patches.at(-1)).toEqual({ id: "t1", body: { status: "archived" } });
    expect(shownOnBoard()).toEqual([]);
    // Escape closes it, and says so, so the chat page doesn't take it as stopping a reply too.
    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    await act(async () => window.dispatchEvent(esc));
    expect(container.querySelector(".world-task")).toBeNull();
    expect(esc.defaultPrevented).toBe(true);
  });

  it("moves a note to another column on a board's live face: saved as its card saves it, and on every board at once", async () => {
    await render();
    await settle(60);
    expect(shownOnBoard()).toEqual(["t1:backlog"]);
    // The board on the wall is live and being read: its face is drawn into the surface the stage made for it.
    const el = document.createElement("div");
    document.body.appendChild(el);
    const board = { id: "board", name: "the task board", kind: "board", at: [0, -3], facing: 0, label: "Tasks" };
    await act(async () =>
      stage.surfaces?.([
        { id: "0:board", el, px: [845, 525], label: "the task board", use: "focus", focused: true, prop: board },
      ]),
    );
    const note = el.querySelector("[data-column='todo'] .sf-note") as HTMLElement;
    expect(note.textContent).toContain("Book flights");
    await act(async () =>
      note.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true })),
    );
    await settle();
    expect(patches.at(-1)).toEqual({ id: "t1", body: { status: "in_progress" } });
    expect(shownOnBoard()).toEqual(["t1:in_progress"]);
    expect(el.querySelector("[data-column='doing'] .sf-note")?.textContent).toContain("Book flights");
    el.remove();
  });

  it("opens an agent's list of wakes from a line about it on a calendar", async () => {
    await render();
    await settle(60);
    await act(async () => stage.onUse?.("calendar", { agent: "planner" }));
    await settle();
    expect(container.querySelector(".world-panel")?.textContent).toMatch(/planner/);
  });

  it("gives a task to an agent, saying first whether that wakes it", async () => {
    agentsInfo = { planner: {}, writer: {} };
    await render();
    await act(async () => stage.onUse?.("tasks", { task: "t1" }));
    await settle();
    const card = container.querySelector(".world-task") as HTMLElement;
    await fill(card.querySelector(".world-task-assign select") as HTMLSelectElement, "planner");
    // Not a promise: the watcher doesn't start the agent it last started on a task again.
    expect(card.querySelector(".world-task-assign")?.textContent).toMatch(
      /Assigning wakes planner: the task watcher starts it on this task, unless planner was the last agent it started on it\./,
    );
    await press(buttonsIn(".world-task-assign"), "Assign");
    expect(patches.at(-1)).toEqual({ id: "t1", body: { assignee: "planner" } });
    expect(card.querySelector(".world-facts")?.textContent).toMatch(/Who\s*planner/);

    // With the watcher off, it says nobody is woken.
    watcherInfo = { enabled: false, triggers: ["created", "updated"] };
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => stage.onUse?.("tasks", { task: "t2" }));
    await settle();
    await fill(container.querySelector(".world-task-assign select") as HTMLSelectElement, "writer");
    expect(container.querySelector(".world-task-assign")?.textContent).toMatch(
      /task watcher is off, so writer isn't woken/,
    );
  });

  it("opens the task list from a board, at the column clicked, and a row opens its card with a way back", async () => {
    agentsInfo = { planner: {}, talker: {} };
    await render();
    await settle(60);
    // At an agent's home, away from any note: that agent's open tasks.
    await act(async () => stage.onUse?.("tasks", {}));
    await settle();
    const list = () => container.querySelector(".world-list-panel") as HTMLElement;
    expect(list().querySelector(".world-panel-title")?.textContent).toBe("talker's tasks");
    const rows = () => [...list().querySelectorAll(".world-list-title")].map((r) => r.textContent);
    expect(rows()).toEqual(["Book flights"]);
    expect(list().querySelector('a[href="#/tasks"]')?.textContent).toBe("Open the Tasks page");
    // Anyone's, newest first.
    await fill(list().querySelector(".world-list-who select") as HTMLSelectElement, ":anyone");
    expect(rows()).toEqual(["Pack", "Book flights"]);
    await press(buttonsIn(".world-list-filters"), "To do1");
    expect(rows()).toEqual(["Book flights"]);
    // A column of the board opens the list at that column.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => stage.onUse?.("tasks", { column: "doing" }));
    await settle();
    expect(list().querySelector('.world-list-filters button[aria-pressed="true"]')?.textContent).toBe("Doing0");
    await press(buttonsIn(".world-list-filters"), "Open1");
    await act(async () => (list().querySelector(".world-list-row") as HTMLButtonElement).click());
    await settle();
    expect(container.querySelector(".world-task .world-panel-title")?.textContent).toBe("Book flights");
    await press(buttonsIn(".world-task .world-panel-head"), "← All tasks");
    expect(list()).not.toBeNull();
    await press(buttonsIn(".world-list-tools"), "+ New task");
    expect(container.querySelector(".new-task")).not.toBeNull();
    expect(container.querySelector(".world-list-panel")).toBeNull();
  });

  it("opens every task from the Tasks button, wherever you are", async () => {
    await render();
    await settle(60);
    const tool = [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === "Tasks") as HTMLElement;
    await act(async () => tool.click());
    await settle();
    expect(container.querySelector(".world-list-panel .world-panel-title")?.textContent).toBe("Every task");
    await act(async () => tool.click());
    expect(container.querySelector(".world-list-panel")).toBeNull();
  });

  it("opens the list at the default agent's tasks in its home, though it isn't one of the configured agents", async () => {
    agentsInfo = { planner: {} };
    placeId = "home:default";
    await render();
    await settle(60);
    await act(async () => stage.onUse?.("tasks", {}));
    await settle();
    const list = container.querySelector(".world-list-panel") as HTMLElement;
    const whose = list.querySelector(".world-list-who select") as HTMLSelectElement;
    expect(list.querySelector(".world-panel-title")?.textContent).toBe("Default agent's tasks");
    // The picker says whose they are, so picking anyone's is a change it hears.
    expect(whose.value).toBe("default");
    expect(list.querySelectorAll(".world-list-title")).toHaveLength(0);
    await fill(whose, ":anyone");
    expect([...list.querySelectorAll(".world-list-title")].map((r) => r.textContent)).toEqual(["Pack", "Book flights"]);
  });

  it("brings the chat back when you pick someone to talk to while a panel has its place", async () => {
    placeId = "shared:lounge";
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    await render();
    await settle(60);
    const tool = [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === "Tasks") as HTMLElement;
    await act(async () => tool.click());
    await settle();
    expect(container.querySelector(".world-list-panel")).not.toBeNull();
    await press(await pick("planner"), "Chat with planner");
    expect(chattedWith).toEqual(["planner"]);
    expect(container.querySelector(".world-list-panel")).toBeNull();
  });

  it("opens an agent's card from its menu: what it's doing, what it said, when it next runs, and what you can do", async () => {
    agentsInfo = { planner: { online: { enabled: true } } };
    activityRecords = [{ id: "planner", data: { agent: "planner", doing: "working", what: "taking a photo" } }];
    speechRecords = [
      {
        id: "planner",
        data: {
          agent: "planner",
          text: "Flights are booked.",
          at: new Date().toISOString(),
          room: "local:trip",
        } as never,
      },
    ];
    ownAgents = [
      {
        name: "planner",
        enabled_in_state: true,
        paused_until: null,
        last_tick_at: new Date().toISOString(),
        current_interval_ms: 30 * 60_000,
        cadence: null,
      },
    ];
    taskRows = taskRows.map((t) => (t.id === "t2" ? { ...t, assignee: "planner" } : t));
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    await render();
    await settle(60);
    await press(await pick("planner"), "About planner");
    await settle(60);
    const card = container.querySelector(".world-agent") as HTMLElement;
    const facts = card.querySelector(".world-facts")?.textContent;
    expect(facts).toMatch(/Now\s*taking a photo/);
    expect(facts).toMatch(/Flights are booked\. in #trip · just now/);
    expect(facts).toMatch(/Runs on its own about every 30 min\. Next around/);
    expect(facts).toMatch(/Where\s*At home/);
    expect(card.querySelector('a[href="#/agents/planner"]')?.textContent).toBe("Open its page");
    // Its own home is somewhere else: go to it.
    expect(buttonsIn(".world-agent-actions").map((b) => b.textContent)).toEqual([
      "Chat with planner",
      "Go to it",
      "Redo its room",
      "Pause for 4 hours",
    ]);
    await press(buttonsIn(".world-agent-actions"), "Pause for 4 hours");
    expect(posts.find((p) => p.url === "/api/exploratory/agents/planner/pause")?.body).toEqual({ hours: 4 });
    // Its tasks, in the list.
    await act(async () => (card.querySelector(".world-panel-inline") as HTMLButtonElement).click());
    await settle();
    expect(container.querySelector(".world-list-panel .world-panel-title")?.textContent).toBe("planner's tasks");
    expect([...container.querySelectorAll(".world-list-title")].map((r) => r.textContent)).toEqual(["Pack"]);
  });

  it("dresses each body in what it wears, yours in nothing of the agent's, and changes it from the agent's card", async () => {
    ownWear = ["cap", "lanyard"];
    company = [
      {
        agent: "planner",
        name: "planner",
        avatar: "/api/live/avatar?agent=planner",
        animations: [],
        wear: ["satchel"],
      },
    ];
    await render();
    await settle(60);
    expect(stage.wears.at(-1)).toEqual(["cap", "lanyard"]);
    expect(stage.companyWear.at(-1)).toEqual({ planner: ["satchel"] });
    // Its card says what it is for and what it wears, with a chip for each thing a body can wear.
    await press(await pick("planner"), "About planner");
    await settle(60);
    const card = container.querySelector(".world-agent") as HTMLElement;
    expect(card.querySelector(".world-agent-role")?.textContent).toBe("travel agent");
    expect(card.querySelector(".world-agent-wear")?.textContent).toMatch(
      /^An adventurer hat · what suits a travel agent/,
    );
    // The chips are a click away, so the card by its shoulder stays short.
    expect(card.querySelector(".world-wear-chip")).toBeNull();
    await act(async () => (card.querySelector(".world-agent-wear [aria-expanded]") as HTMLButtonElement).click());
    const chips = [...card.querySelectorAll(".world-wear-chip")] as HTMLButtonElement[];
    expect(chips.filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.textContent)).toEqual([
      "adventurer hat",
    ]);
    // A cap goes on in place of the hat, written where the agent's own choice goes: its body record.
    await act(async () => chips.find((c) => c.textContent === "cap")?.click());
    await settle(30);
    expect(posts.find((p) => p.url === "/api/state/body/planner")?.body).toEqual({
      scope: "agent:planner",
      data: { wear: ["cap"] },
      expectedVersion: 0,
    });
    // A wear record from before it was the body's is taken away, so it can't bring an old choice back.
    expect(deleted).toContain("/api/state/wear/planner");
    // Visiting, the body is yours: it wears nothing of the agent's.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => tool("Map").click());
    await settle();
    await act(async () => (container.querySelector(".world-map-place") as HTMLButtonElement).click());
    await settle(60);
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.wears.at(-1)).toEqual([]);
  });

  it("draws each body as it chose to look and carry itself, a spot to stay at only in the place it is in", async () => {
    ownLooks = {
      color: "#2a8a8a",
      colorName: "teal",
      idle: "sleepy",
      model: "fox.vrm",
      avatar: "/api/live/avatar?model=fox.vrm",
      spot: { place: "home:talker", spot: "couch", name: "on the couch" },
    };
    company = [
      {
        agent: "planner",
        name: "planner",
        avatar: "/api/live/avatar?agent=planner",
        animations: [],
        color: "#ee7f6d",
        walk: "brisk",
        size: 1.2,
        spot: { place: "shared:lounge", spot: "window", name: "at the window" },
      },
    ];
    await render();
    await settle(60);
    expect(stage.looks.at(-1)).toEqual({
      color: "#2a8a8a",
      colorName: "teal",
      idle: "sleepy",
      model: "fox.vrm",
      avatar: "/api/live/avatar?model=fox.vrm",
      spot: { place: "home:talker", spot: "couch", name: "on the couch" },
    });
    // Its spot is in another place: nothing to go to here.
    expect(stage.companyLooks.at(-1)).toEqual({ planner: { color: "#ee7f6d", walk: "brisk", size: 1.2 } });
  });

  it("changes how an agent looks and carries itself from its card, and asks it for a gesture", async () => {
    plannerLooks = {
      color: "#2a8a8a",
      colorName: "teal",
      idle: "calm",
      spot: { place: "home:planner", spot: "couch", name: "on the couch" },
    };
    modelNames = ["robot.vrm", "fox.vrm"];
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    await render();
    await settle(60);
    await press(await pick("planner"), "About planner");
    await settle(60);
    const card = container.querySelector(".world-agent") as HTMLElement;
    expect(card.querySelector(".world-agent-body")?.textContent).toMatch(/^teal · calm · change/);
    await act(async () => (card.querySelector(".world-agent-body .world-panel-inline") as HTMLButtonElement).click());
    await settle(30);
    // The model can be chosen when there is more than one; the one it chose is pressed.
    expect([...card.querySelectorAll(".body-select option")].map((o) => o.textContent)).toEqual([
      "Its own",
      "robot",
      "fox",
    ]);
    expect(card.querySelector('.body-swatch[aria-label="teal"]')?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => (card.querySelector('.body-swatch[aria-label="coral"]') as HTMLButtonElement).click());
    await settle(30);
    expect(posts.filter((p) => p.url === "/api/state/body/planner").at(-1)?.body).toMatchObject({
      scope: "agent:planner",
      data: { color: "#ee7f6d", colorName: "coral" },
    });
    const chip = (group: string, label: string) =>
      [...card.querySelectorAll(`[aria-label="${group}"] .world-wear-chip`)].find(
        (c) => c.textContent === label,
      ) as HTMLButtonElement;
    expect(chip("How planner idles", "calm").getAttribute("aria-pressed")).toBe("true");
    // What it likes doing, in the words the agent is told, kept by their names.
    await act(async () => chip("What planner likes doing when idle", "plants").click());
    await settle(30);
    expect(posts.filter((p) => p.url === "/api/state/body/planner").at(-1)?.body).toMatchObject({
      data: { errands: ["water"] },
    });
    await act(async () => chip("How planner walks", "sneak").click());
    await settle(30);
    expect(posts.filter((p) => p.url === "/api/state/body/planner").at(-1)?.body).toMatchObject({
      data: { walk: "sneak" },
    });
    await act(async () => chip("Ask planner to make a gesture", "dance").click());
    await settle(30);
    expect(posts.find((p) => p.url === "/api/state/emote/planner")?.body).toMatchObject({
      scope: "global",
      data: { name: "dance" },
    });
    // Where it chose to stay, and a way to let it go where it likes again.
    expect(card.querySelector(".body-controls")?.textContent).toMatch(/Stayson the couch · let it roam/);
  });

  it("hands the stage the gesture each agent is making, as it changes", async () => {
    const at = new Date().toISOString();
    emoteRecords = [{ id: "planner", data: { name: "wave", at } }];
    await render();
    await settle(60);
    expect(stage.emotes.at(-1)).toEqual({ planner: { name: "wave", at } });
    await act(async () =>
      FakeEventSource.last?.emit("change", {
        type: "emote",
        id: "talker",
        op: "create",
        after: { name: "cheer", at },
      }),
    );
    await settle(30);
    // Heard while the page was open: timed from when the page heard it, by its own clock.
    expect(stage.emotes.at(-1)).toMatchObject({ talker: { name: "cheer", heard: expect.any(Number) } });
    expect(stage.emotes.at(-1)?.planner).not.toHaveProperty("heard");
  });

  it("saves a colour from the picker once, when it closes, not at every step of a drag", async () => {
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    await render();
    await settle(60);
    await press(await pick("planner"), "About planner");
    await settle(60);
    const card = container.querySelector(".world-agent") as HTMLElement;
    await act(async () => (card.querySelector(".world-agent-body .world-panel-inline") as HTMLButtonElement).click());
    await settle(30);
    const picker = card.querySelector('input[type="color"]') as HTMLInputElement;
    const saves = () => posts.filter((p) => p.url === "/api/state/body/planner");
    // Dragging round the picker: each step shows, none is saved.
    for (const hex of ["#112233", "#334455", "#556677"]) {
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(picker, hex);
        picker.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await settle(30);
    expect(picker.value).toBe("#556677");
    expect(saves()).toHaveLength(0);
    // Closed: saved once, as the colour it ended on.
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    await settle(30);
    expect(saves()).toHaveLength(1);
    expect(saves()[0].body).toMatchObject({ data: { color: "#556677" } });
  });

  it("puts the card's choice back when a change to a body couldn't be saved", async () => {
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    wearStatus = 500;
    await render();
    await settle(60);
    await press(await pick("planner"), "About planner");
    await settle(60);
    const card = container.querySelector(".world-agent") as HTMLElement;
    await act(async () => (card.querySelector(".world-agent-body .world-panel-inline") as HTMLButtonElement).click());
    await settle(30);
    const coral = () => card.querySelector('.body-swatch[aria-label="coral"]') as HTMLButtonElement;
    await act(async () => coral().click());
    await settle(30);
    expect(posts.some((p) => p.url === "/api/state/body/planner")).toBe(true);
    // Not saved, so not chosen: the swatch isn't pressed, and the card says why.
    expect(coral().getAttribute("aria-pressed")).toBe("false");
    expect(card.querySelector(".body-swatch-own")?.getAttribute("aria-pressed")).toBe("true");
    expect(card.querySelector(".agent-menu-problem")?.textContent).toMatch(/Couldn't change its body/);
  });

  it("puts the card's chips back when what a body wears couldn't be saved", async () => {
    company = [
      {
        agent: "planner",
        name: "planner",
        avatar: "/api/live/avatar?agent=planner",
        animations: [],
        wear: ["satchel"],
      },
    ];
    wearStatus = 500;
    await render();
    await settle(60);
    await press(await pick("planner"), "About planner");
    await settle(60);
    const card = container.querySelector(".world-agent") as HTMLElement;
    await act(async () => (card.querySelector(".world-agent-wear [aria-expanded]") as HTMLButtonElement).click());
    const pressed = () =>
      [...card.querySelectorAll(".world-wear-chip")]
        .filter((c) => c.getAttribute("aria-pressed") === "true")
        .map((c) => c.textContent);
    expect(pressed()).toEqual(["adventurer hat"]);
    await act(async () =>
      ([...card.querySelectorAll(".world-wear-chip")] as HTMLButtonElement[])
        .find((c) => c.textContent === "cap")
        ?.click(),
    );
    await settle(30);
    expect(posts.some((p) => p.url === "/api/state/body/planner")).toBe(true);
    // Nothing was saved, so the card says what the body still wears, and why the change didn't take.
    expect(pressed()).toEqual(["adventurer hat"]);
    expect(card.querySelector(".world-agent-wear")?.textContent).toMatch(/^An adventurer hat/);
    expect(card.querySelector(".agent-menu-problem")?.textContent).toMatch(/Couldn't change what it wears/);
  });

  it("shows what an agent just did to the room over its head, and every change on the room's card", async () => {
    await render();
    await settle(60);
    const at = new Date().toISOString();
    const changed = {
      ...home,
      purpose: "planning trips",
      changes: [{ who: "talker", what: "added the fish tank", at }],
    };
    await act(async () =>
      FakeEventSource.last?.emit("change", { type: "place", id: "home:talker", op: "update", after: changed }),
    );
    await settle();
    expect(stage.speech.at(-1)?.talker).toEqual({ text: "Added the fish tank.", at });
    await press(buttonsIn(".talk-tools"), "Room");
    const card = container.querySelector(".world-place") as HTMLElement;
    expect(card.textContent).toMatch(/planning trips/);
    expect([...card.querySelectorAll(".world-changes li")].map((li) => li.textContent)).toEqual([
      "talker added the fish tankjust now",
    ]);
    await press(buttonsIn(".world-place"), "Ask talker to make it fit its work");
    expect(drafts.at(-1)).toEqual(["talker", expect.stringMatching(/reflect what you've been working on/)]);
  });

  it("offers to have an agent redo its room only when it has the place tool", async () => {
    agentsInfo = { planner: { tools: ["read", "room"] } as never };
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    await render();
    await settle(60);
    await press(await pick("planner"), "About planner");
    await settle(60);
    expect(buttonsIn(".world-agent-actions").map((b) => b.textContent)).not.toContain("Redo its room");
  });

  it("says on an agent's card when every agent is paused, and that a task calls one only with the watcher on", async () => {
    placeId = "shared:lounge";
    agentsInfo = { planner: { online: { enabled: true } }, writer: {} };
    activityRecords = [
      {
        id: "planner",
        data: { agent: "planner", doing: "asleep", what: "asleep", detail: "agents are paused" } as never,
      },
    ];
    ownAgents = [
      {
        name: "planner",
        enabled_in_state: true,
        paused_until: null,
        last_tick_at: new Date().toISOString(),
        current_interval_ms: 30 * 60_000,
        cadence: null,
      },
    ];
    company = ["planner", "writer"].map((a) => ({
      agent: a,
      name: a,
      avatar: `/api/live/avatar?agent=${a}`,
      animations: [],
    }));
    await render();
    await settle(60);
    const facts = () => container.querySelector(".world-agent .world-facts")?.textContent ?? "";
    await press(await pick("planner"), "About planner");
    await settle(60);
    expect(facts()).toMatch(/Every agent is paused, so it doesn't run on its own until that is lifted\./);
    expect(facts()).not.toMatch(/Next around/);

    await press(await pick("writer"), "About writer");
    await settle(60);
    expect(facts()).toMatch(/when you talk to it, or a room, a task or a wake it booked calls it/);
    watcherInfo = { enabled: false, triggers: ["created", "updated"] };
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await press(await pick("writer"), "About writer");
    await settle(60);
    expect(facts()).toMatch(/when you talk to it, or a room or a wake it booked calls it/);
  });

  it("stops talking when Space comes up in a menu that opened while it was held", async () => {
    await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
    await settle();
    // Clicking a body while holding Space: its menu has the focus when the key comes up.
    const [first] = await pick("talker");
    const up = new KeyboardEvent("keyup", { code: "Space", bubbles: true, cancelable: true });
    await act(async () => first.dispatchEvent(up));
    await settle();
    expect(posts.some((p) => p.url.endsWith("/turn"))).toBe(true);
    // Coming up there isn't a press of the menu's button.
    expect(up.defaultPrevented).toBe(true);
  });

  it("talks while Space is held on a button in your conversation in the world, as on the chat's own buttons", async () => {
    await render(
      { dialogue: true, panelOpen: false },
      <button type="button" className="fake-send">
        Send
      </button>,
    );
    // Clicked with the mouse, Send keeps the focus: Space is still talking, not another press of it.
    const button = container.querySelector('.world-anchor[data-panel="talk"] .fake-send') as HTMLButtonElement;
    button.focus();
    const down = new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true });
    await act(async () => button.dispatchEvent(down));
    await settle();
    expect(down.defaultPrevented).toBe(true);
    expect(posts.some((p) => p.url === "/api/live/sessions")).toBe(true);
  });

  it("leaves keys pressed in a panel to the panel: Space there doesn't start talking", async () => {
    await render();
    await act(async () => stage.onUse?.("new-room"));
    const button = container.querySelector(".world-new-room button") as HTMLButtonElement;
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true })));
    await settle();
    expect(posts.some((p) => p.url === "/api/live/sessions")).toBe(false);
  });

  it("starts a chat with the default agent to make an agent, and says what will happen before it does for a room", async () => {
    await render();
    await act(async () => stage.onUse?.("new-agent"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual(["default", expect.stringMatching(/new agent/)]);
    await act(async () => stage.onUse?.("new-room"));
    const panel = container.querySelector(".world-new-room") as HTMLElement;
    // Nothing is written to anyone until the person says so, and the panel says where a room is made.
    expect(drafts).toHaveLength(1);
    expect(panel.textContent).toMatch(/Nothing is sent until you send it/);
    expect(panel.textContent).toMatch(/on Discord, that's a new channel/);
    await press([...panel.querySelectorAll("button")] as HTMLButtonElement[], "Write the message");
    expect(drafts[1]).toEqual(["default", expect.stringMatching(/new room.*wait for my go-ahead/)]);
    expect(container.querySelector(".world-new-room")).toBeNull();
    expect(window.location.hash).not.toBe("#/tasks");
  });

  it("has no 3D view for an agent without a body, but can still talk", async () => {
    liveInfo = { enabled: true };
    await render();
    expect(container.querySelector(".talk-avatar")).toBeNull();
    expect(container.querySelector(".toggle-3d")).toBeNull();
    expect(container.querySelector(".chat-talk-btn")).not.toBeNull();
  });

  it("offers no talk button when live sessions are off", async () => {
    liveInfo = { enabled: false };
    await render();
    expect(container.querySelector(".chat-talk-btn")).toBeNull();
  });

  it("hands typed turns the body while it is on screen, and its cues back to it", async () => {
    await render();
    const last = extras.at(-1);
    expect((last?.body as { gestures: string[] }).gestures).toContain("wave");
    last?.onCue?.({ name: "go", target: "the couch" });
    expect(stage.cues).toEqual(["go:the couch"]);
    await act(async () => (container.querySelector(".toggle-3d") as HTMLButtonElement).click());
    expect(extras.at(-1)).toEqual({});
  });

  it("keeps the conversation going after a typed turn, so the avatar stays where it was sent", async () => {
    await render({ sending: false });
    expect(stage.calls[0].input().engaged).toBe(false);
    await render({ sending: true });
    await render({ sending: false });
    expect(stage.calls[0].input().engaged).toBe(true);
  });

  it("lets the agent choose what its body does with a quiet moment", async () => {
    await render();
    const cues = await stage.calls[0].chooseIdle?.("on the couch", 21);
    expect(cues).toEqual([{ name: "go", target: "the window" }]);
    const asked = posts.find((p) => p.url === "/api/live/idle")?.body as Record<string, unknown>;
    expect(asked).toMatchObject({ agent: "talker", here: "on the couch", hour: 21 });
    expect((asked.body as { gestures: string[] }).gestures).toContain("wave");
  });

  it("leaves the avatar to wander on its own when live sessions are off", async () => {
    liveInfo = { enabled: false, avatar: "/api/live/avatar?agent=talker" };
    await render();
    expect(stage.calls[0].chooseIdle).toBeUndefined();
  });

  const wall = (kind: string) => ({ id: kind, name: `the ${kind}`, kind, at: [0, -1.79], facing: 0, elevation: 1.2 });
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const booking = (id: string, agent: string, hours: number, note: string) => ({
    id,
    agent,
    note,
    kind: "once",
    every: null,
    next_run_at: inHours(hours),
    target_kind: "session",
    target: "s1",
  });

  it("hangs its owner's day on a home's calendar, and opens the whole week from it", async () => {
    homeExtra = [wall("calendar")];
    bookedRows = [booking("b2", "planner", 3, "plan the route"), booking("b1", "talker", 2, "check the deploy")];
    taskRows = taskRows.map((t) =>
      t.id === "t1" ? { ...t, status: "done", updated_at: new Date().toISOString() } : t,
    );
    await render();
    await settle(60);
    const shown = stage.calendars.at(-1);
    expect(shown).toMatchObject({ title: "talker's day", names: false });
    expect(shown?.wakes.map((w) => w.key)).toEqual(["booked:b1"]);
    expect(shown?.done.map((d) => d.key)).toEqual(["task:t1"]);
    // Nothing on the walls asks for the dashboard.
    expect(stage.screens).toEqual([]);

    await act(async () => stage.onUse?.("calendar"));
    await settle();
    const panel = container.querySelector(".world-calendar-panel") as HTMLElement;
    expect(panel.querySelector(".world-panel-title")?.textContent).toBe("talker's day");
    expect(panel.textContent).toMatch(/check the deploy/);
    expect(panel.textContent).toMatch(/wakes in its own conversation/);
    expect(panel.textContent).not.toMatch(/plan the route/);
    expect(panel.textContent).toMatch(/finished “Book flights”/);
    // Everyone's, and off to one of them where its body is.
    await fill(panel.querySelector("select") as HTMLSelectElement, "\u0000everyone");
    expect(container.querySelector(".world-calendar-panel .world-panel-title")?.textContent).toBe(
      "Everyone's next wakes",
    );
    expect(container.querySelector(".world-calendar-panel")?.textContent).toMatch(/plan the route/);
    await press(buttonsIn(".world-calendar-panel .world-calendar-wake"), "planner");
    await settle(60);
    expect(container.querySelector(".world-calendar-panel")).toBeNull();
    expect(stage.rooms.at(-1)?.name).toBe("planner's room");
    expect(stage.greeted).toContain("planner");
  });

  it("goes through the dashboard on a screen anywhere but a home, and opens it in the world", async () => {
    placeId = "shared:lounge";
    homeExtra = [wall("screen")];
    dashboardWidgets = [
      { id: "system-status", type: "status", title: "System status" },
      { id: "embed", type: "iframe", title: "Embed", options: { url: "https://example.com" } },
      {
        id: "needs-you",
        type: "tasks",
        title: "Needs you",
        options: { endpoint: "/api/project-tasks?status=backlog" },
      },
    ];
    await render();
    await settle(80);
    const pages = stage.screens.at(-1);
    expect(pages?.map((c) => c.id)).toEqual(["system-status", "needs-you"]);
    expect(pages?.[1].rows?.map((r) => r.text)).toEqual(["Book flights"]);

    await act(async () => stage.onUse?.("screen", { card: "needs-you" }));
    await settle(60);
    const panel = container.querySelector(".world-dashboard-panel") as HTMLElement;
    expect(panel.querySelector(".world-panel-title")?.textContent).toBe("On the big screen");
    // Every widget, the Board's own renderers drawing them, the embed too.
    expect([...panel.querySelectorAll("[data-widget-id]")].map((el) => (el as HTMLElement).dataset.widgetId)).toEqual([
      "system-status",
      "embed",
      "needs-you",
    ]);
    // A task in one opens its card here, not the Tasks page.
    const link = panel.querySelector('a[href="#/tasks/t1"]') as HTMLAnchorElement;
    await act(async () => link.click());
    await settle();
    expect(container.querySelector(".world-task .world-panel-title")?.textContent).toBe("Book flights");
    expect(window.location.hash).not.toMatch(/tasks/);
  });

  it("says why a screen shows no dashboard, on the screen and in the panel, rather than looking forever", async () => {
    placeId = "shared:lounge";
    homeExtra = [wall("screen")];
    await render();
    await settle(80);
    expect(stage.screens.at(-1)).toEqual([{ id: "board", title: "Dashboard", empty: "Nothing on the Board yet." }]);
    await act(async () => stage.onUse?.("screen", { card: "board" }));
    await settle();
    const panel = container.querySelector(".world-dashboard-panel") as HTMLElement;
    expect(panel.textContent).toMatch(/Nothing on the Board yet/);
    expect(panel.textContent).not.toMatch(/Looking/);
  });

  it("says the dashboard couldn't be had when it can't", async () => {
    placeId = "shared:lounge";
    homeExtra = [wall("screen")];
    dashboardDown = true;
    await render();
    await settle(80);
    expect(stage.screens.at(-1)?.[0]).toMatchObject({
      empty: expect.stringMatching(/^Couldn't load the dashboard: 500/),
    });
    await act(async () => stage.onUse?.("screen", { card: "board" }));
    await settle();
    expect(container.querySelector(".world-dashboard-panel")?.textContent).toMatch(/Couldn't load the dashboard: 500/);
  });

  it("shows everyone's open tasks and wakes on the square, where nobody stays", async () => {
    townExtra = [wall("board"), wall("calendar")];
    bookedRows = [booking("b1", "planner", 2, "plan the route"), booking("b2", "writer", 3, "send the draft")];
    await render({ following: true });
    await act(async () => stage.onDoor?.({ to: "town" }));
    await settle(60);
    expect(stage.rooms.at(-1)?.name).toBe("the town");
    // No agent is ever on the square, so what it shows is everyone's, as the lobby's does.
    expect(stage.tasks.at(-1)?.map((t) => t.id)).toEqual(["t1", "t2"]);
    const shown = stage.calendars.at(-1);
    expect(shown?.title).toBe("Everyone's next wakes");
    expect(shown?.wakes.map((w) => w.key)).toEqual(["booked:b1", "booked:b2"]);
    await act(async () => stage.onUse?.("calendar"));
    await settle();
    const panel = container.querySelector(".world-calendar-panel") as HTMLElement;
    expect(panel.querySelector(".world-panel-title")?.textContent).toBe("Everyone's next wakes");
    expect(panel.textContent).toMatch(/plan the route/);
    expect(panel.textContent).toMatch(/send the draft/);
    // The office's directory opens the map, as the Map button does.
    await act(async () => stage.onUse?.("map"));
    await settle();
    expect(container.querySelector(".world-map")).not.toBeNull();
    await act(async () => stage.onUse?.("calendar"));
    await settle();
    // And the map, opened out here, marks where you stand on the town's plan.
    await act(async () =>
      ([...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === "Map") as HTMLElement).click(),
    );
    await settle();
    expect(container.querySelector(".world-plan-you")?.getAttribute("aria-label")).toBe("You are here");
  });

  it("shows the wakes of whoever is in a shared place on its calendar, and opens the list on them", async () => {
    placeId = "shared:lounge";
    homeExtra = [wall("calendar")];
    company = [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] }];
    bookedRows = [booking("b1", "planner", 2, "plan the route"), booking("b2", "writer", 3, "send the draft")];
    await render();
    await settle(60);
    const shown = stage.calendars.at(-1);
    expect(shown?.title).toBe("Next wakes for who's here");
    expect(shown?.wakes.map((w) => w.key)).toEqual(["booked:b1"]);
    await act(async () => stage.onUse?.("calendar"));
    await settle();
    const panel = container.querySelector(".world-calendar-panel") as HTMLElement;
    // The list the wall showed: the same people, under the same name.
    expect(panel.querySelector(".world-panel-title")?.textContent).toBe("Next wakes for who's here");
    expect(panel.textContent).toMatch(/plan the route/);
    expect(panel.textContent).not.toMatch(/send the draft/);
    await fill(panel.querySelector("select") as HTMLSelectElement, "\u0000everyone");
    expect(container.querySelector(".world-calendar-panel")?.textContent).toMatch(/send the draft/);
    // And back to who's here.
    await fill(container.querySelector(".world-calendar-panel select") as HTMLSelectElement, "\u0000here");
    expect(container.querySelector(".world-calendar-panel .world-panel-title")?.textContent).toBe(
      "Next wakes for who's here",
    );
    expect(container.querySelector(".world-calendar-panel")?.textContent).not.toMatch(/send the draft/);
  });

  it("shows what a home's owner is up to on a screen there, each page opening its own thing", async () => {
    homeExtra = [wall("screen")];
    activityRecords = [{ id: "talker", data: { agent: "talker", doing: "working", what: "writing code" } }];
    bookedRows = [booking("b1", "talker", 2, "check the deploy")];
    await render();
    await settle(60);
    const pages = stage.screens.at(-1);
    expect(pages?.map((c) => [c.id, c.title])).toEqual([
      ["now", "talker, now"],
      ["tasks", "talker's tasks"],
      ["next", "Coming up"],
    ]);
    expect(pages?.[2].rows?.map((r) => r.text)).toEqual(["check the deploy"]);
    await act(async () => stage.onUse?.("screen", { card: "tasks" }));
    await settle();
    expect(container.querySelector(".world-list-panel .world-panel-title")?.textContent).toBe("talker's tasks");
    await act(async () => stage.onUse?.("screen", { card: "next" }));
    await settle();
    expect(container.querySelector(".world-calendar-panel .world-panel-title")?.textContent).toBe("talker's day");
    await act(async () => stage.onUse?.("screen", { card: "now" }));
    await settle();
    expect(container.querySelector(".world-panel-title")?.textContent).toMatch(/talker/);
    expect(container.querySelector(".world-calendar-panel")).toBeNull();
  });

  describe("panels in the world, each beside what it is about", () => {
    /** The panel of a kind kept beside something now: what it is beside, and how it goes. */
    const pinned = (kind: string) => [...stage.anchored].find(([el]) => el.dataset.panel === kind)?.[1];
    const anchorOf = (kind: string) => pinned(kind)?.anchor;
    const planner = { agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner", animations: [] };
    const tool = (label: string) =>
      [...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === label) as HTMLButtonElement;

    it("opens an agent's card by its body, in its colour, and the map held in front of you in its place", async () => {
      placeId = "shared:lounge";
      company = [planner];
      await render();
      await settle(60);
      await press(await pick("planner"), "About planner");
      expect(anchorOf("agent")).toEqual({ agent: "planner" });
      const card = container.querySelector('.world-anchor[data-panel="agent"]') as HTMLElement;
      expect(card.classList.contains("world-anchor-card")).toBe(true);
      // Edged in the colour its body is drawn in, as the dot by its name is.
      expect(card.style.getPropertyValue("--who-color")).toBe(agentColor("planner"));
      expect(card.querySelector(".world-panel-title")?.textContent).toMatch(/planner/);
      // A card has a strip kept for it beside the chat's column, which the stage takes when there is no room beside.
      expect(stage.panelRooms.at(-1)).toBe(PANEL_ROOM);
      await act(async () => tool("Map").click());
      await settle();
      expect(anchorOf("map")).toEqual({ held: "front" });
      expect(anchorOf("agent")).toBeUndefined();
      expect(container.querySelector('.world-anchor-held[data-panel="map"] .world-map')).not.toBeNull();
    });

    it("answers what an agent waits on beside its body, and holds it in front of you when it has none to go to", async () => {
      const waiting = (agent: string) => ({
        id: agent,
        data: { agent, doing: "waiting", what: "has a question for you", question: "Window or aisle?" },
      });
      activityRecords = [waiting("planner"), waiting("scheduler")];
      await render();
      await act(async () => tool("Needs you · 2").click());
      await settle();
      // The list of everything waiting on you is held in front of you.
      expect(anchorOf("needs")).toEqual({ held: "front" });
      const row = (who: string) =>
        [...container.querySelectorAll(".world-needs-row")].find((r) => r.textContent?.includes(who)) as HTMLElement;
      await act(async () => row("planner").click());
      await settle(60);
      // Into planner's home, in front of it, its question open by its shoulder.
      expect(stage.greeted).toEqual(["planner"]);
      expect(anchorOf("need")).toEqual({ agent: "planner" });
      expect(container.querySelector('.world-anchor-card[data-panel="need"] .world-need')?.textContent).toContain(
        "Window or aisle?",
      );
      // One with no body anywhere: its card in front of you, wherever you are.
      await act(async () => tool("Needs you · 2").click());
      await settle();
      await act(async () => row("scheduler").click());
      await settle(60);
      expect(anchorOf("need")).toEqual({ held: "front" });
    });

    it("pins a task's card beside the board it was opened from, and what it opens stays there too", async () => {
      // Two boards: the one clicked is the one beside it, not merely the first.
      homeExtra = [
        { ...wall("board"), action: "tasks" },
        { ...wall("board"), id: "board-2", at: [1.2, -1.79], action: "tasks" },
      ];
      await render();
      await settle(60);
      await act(async () => stage.onUse?.("tasks", {}, "board-2"));
      await settle();
      expect(anchorOf("tasks")).toEqual({ thing: "board-2" });
      expect(container.querySelector('.world-anchor-pinned[data-panel="tasks"] .world-anchor-mark')).not.toBeNull();
      await act(async () => (container.querySelector(".world-list-row") as HTMLButtonElement).click());
      await settle();
      expect(anchorOf("task")).toEqual({ thing: "board-2" });
      // A note on the other board opens its card beside that one.
      await act(async () => stage.onUse?.("tasks", { task: "t1" }, "board"));
      await settle();
      expect(anchorOf("task")).toEqual({ thing: "board" });
      // From the Tasks button, the list is pinned beside the first board here.
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
      await act(async () => tool("Tasks").click());
      await settle();
      expect(anchorOf("tasks")).toEqual({ thing: "board" });
    });

    it("hangs the room's plaque by its door, and opens the room's card on it", async () => {
      await render();
      await settle(60);
      // It says what the trail over the stage calls the place, not the name the home was built with.
      expect(stage.plaques.at(-1)).toBe("talker's home");
      await act(async () => stage.onUse?.("place"));
      await settle();
      expect(anchorOf("place")).toEqual({ plaque: true });
      expect(container.querySelector(".world-anchor-plaque .world-panel")).not.toBeNull();
      // The Room button opens the same card, on the same plaque.
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
      expect(anchorOf("place")).toBeUndefined();
      await act(async () => tool("Room").click());
      await settle();
      expect(anchorOf("place")).toEqual({ plaque: true });
    });

    it("puts a card away once you walk away from what it is about", async () => {
      placeId = "shared:lounge";
      company = [planner];
      await render();
      await settle(60);
      await press(await pick("planner"), "About planner");
      expect(container.querySelector('[data-panel="agent"] .world-panel')).not.toBeNull();
      await act(async () => pinned("agent")?.opts?.onAway?.());
      await settle();
      expect(container.querySelector('[data-panel="agent"]')).toBeNull();
    });

    it("keeps your conversation beside the agent you talk to, and on the phone once you are somewhere it isn't", async () => {
      await render({ dialogue: true, panelOpen: false });
      await settle(60);
      expect(anchorOf("talk")).toEqual({ agent: "talker" });
      expect(pinned("talk")?.opts).toMatchObject({ optional: true, fallback: "dock" });
      expect(container.querySelector(".talk-shown")?.textContent).toBe("beside talker");
      await act(async () => tool("Map").click());
      await settle();
      // The map has the room: your conversation steps aside while it is open.
      expect(anchorOf("talk")).toBeUndefined();
      const trip = [...container.querySelectorAll(".world-map-place")].find((b) =>
        b.querySelector(".world-map-name")?.textContent?.startsWith("#trip"),
      ) as HTMLButtonElement;
      await act(async () => trip.click());
      await settle(60);
      expect(anchorOf("talk")).toEqual({ you: true });
      expect(container.querySelector(".talk-shown")?.textContent).toBe("on the phone with talker");
      expect(container.querySelector('.world-anchor-phone[data-panel="talk"]')).not.toBeNull();
      // A card about someone here opens beside them: the call stays, down to its last few words, out of its way.
      await press(await pick("planner"), "About planner");
      expect(anchorOf("agent")).toEqual({ agent: "planner" });
      expect(anchorOf("talk")).toEqual({ you: true });
      expect(container.querySelector(".talk-shown")?.textContent).toBe("on the phone with talker, briefly");
    });

    it("leaves your conversation out while the whole chat is open, or the agent's own card has its place", async () => {
      await render({ dialogue: true, panelOpen: true });
      await settle(60);
      expect(anchorOf("talk")).toBeUndefined();
      expect(container.querySelector(".talk-shown")).toBeNull();
      act(() => root.unmount());
      root = createRoot(container);
      await render({ dialogue: true, panelOpen: false });
      await settle(60);
      await press(await pick("talker"), "About talker");
      expect(anchorOf("agent")).toEqual({ agent: "talker" });
      expect(anchorOf("talk")).toBeUndefined();
    });

    it("edges an agent's card in the colour it chose for its body", async () => {
      placeId = "shared:lounge";
      company = [planner];
      bodyRecords = [{ id: "planner", data: { color: "#ee7f6d" } }];
      await render();
      await settle(60);
      await press(await pick("planner"), "About planner");
      const card = container.querySelector('.world-anchor[data-panel="agent"]') as HTMLElement;
      expect(card.style.getPropertyValue("--who-color")).toBe("#ee7f6d");
    });

    it("edges your conversation in the colour of the body of whoever you talk to", async () => {
      await render({ dialogue: true, panelOpen: false });
      await settle(60);
      const talk = container.querySelector('.world-anchor[data-panel="talk"]') as HTMLElement;
      expect(talk.style.getPropertyValue("--who-color")).toBe(agentColor("talker"));
    });

    it("closes what was opened beside something as you go through a door, but what waits on you comes along", async () => {
      homeExtra = [{ ...wall("board"), action: "tasks" }];
      // Somebody with no body to go to: nothing of theirs opens anywhere in its place.
      activityRecords = [
        {
          id: "scheduler",
          data: { agent: "scheduler", doing: "waiting", what: "has a question", question: "Window?" },
        },
      ];
      await render();
      await settle(60);
      await act(async () => stage.onUse?.("tasks", { task: "t1" }, "board"));
      await settle();
      expect(anchorOf("task")).toEqual({ thing: "board" });
      await act(async () => stage.onDoor?.({ to: "town" }));
      await settle(60);
      // The board it was beside is behind you: out in the town it would be beside nothing, or another of that name.
      expect(anchorOf("task")).toBeUndefined();
      expect(container.querySelector(".world-anchor")).toBeNull();
      // The list of what waits on you, held in front of you, goes through the door with you.
      act(() => root.unmount());
      root = createRoot(container);
      await render();
      await settle(60);
      await act(async () => tool("Needs you · 1").click());
      await settle();
      expect(anchorOf("needs")).toEqual({ held: "front" });
      await act(async () => stage.onDoor?.({ to: "town" }));
      await settle(60);
      expect(anchorOf("needs")).toEqual({ held: "front" });
    });
  });

  it("turns the 3D view off, and remembers that next time", async () => {
    await render();
    await act(async () => (container.querySelector(".toggle-3d") as HTMLButtonElement).click());
    expect(container.querySelector(".talk-avatar")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector(".talk-avatar")).toBeNull();
  });
});

describe("talking on the chat page", () => {
  it("talks into the chat's own conversation, telling the agent what its body can do", async () => {
    await render();
    await talk();
    const start = posts.find((p) => p.url === "/api/live/sessions")?.body as Record<string, unknown>;
    expect(start).toMatchObject({ agent: "talker", sessionKey: "web:kitchen" });
    expect((start.body as { gestures: string[] }).gestures).toContain("wave");
    expect(posts.some((p) => p.url === "/api/live/sessions/live-1/turn")).toBe(true);
    // The turn is shown with the rest of the chat.
    expect(spoken).toEqual([["conv-1", "web:kitchen"]]);
  });

  it("plays the reply, and each cue as its sentence starts or once the speech ends", async () => {
    await render();
    await talk();
    expect(audios).toHaveLength(1);
    expect(stage.cues).toEqual(["wave"]);
    await act(async () => audios[0].onended?.());
    expect(stage.cues).toEqual(["wave", "go:the couch"]);
  });

  it("declares no body when the 3D view is off", async () => {
    localStorage.setItem("tai.chat.stage", "off");
    await render();
    await talk();
    const start = posts.find((p) => p.url === "/api/live/sessions")?.body as Record<string, unknown>;
    expect(start.body).toBeUndefined();
  });

  it("gives a new chat a conversation of its own on its first spoken turn", async () => {
    await render({ sessionKey: undefined });
    await talk();
    const start = posts.find((p) => p.url === "/api/live/sessions")?.body as { sessionKey: string };
    // Named for the agent it is with, so going to that agent finds it again.
    expect(start.sessionKey).toMatch(/^web:talker:\d+$/);
    expect(spoken[0]?.[1]).toBe(start.sessionKey);
  });

  it("keeps one session across turns, and starts over in another conversation", async () => {
    await render();
    await talk();
    await talk();
    expect(posts.filter((p) => p.url === "/api/live/sessions")).toHaveLength(1);
    await render({ sessionKey: "web:study" });
    expect(deleted).toEqual(["/api/live/sessions/live-1"]);
  });

  it("says a spoken reply is on its way until it has been heard, so going elsewhere waits for it", async () => {
    const speaking: boolean[] = [];
    await render({ setSpeaking: (on) => speaking.push(on) });
    await talk();
    // Heard and answered, the answer still playing.
    expect(speaking.at(-1)).toBe(true);
    await act(async () => audios[0].onended?.());
    await settle();
    expect(speaking.at(-1)).toBe(false);
  });

  it("leaves the page where it is when it went on to another conversation while a turn was on its way", async () => {
    let release = () => {};
    turnHeld = new Promise<void>((r) => {
      release = r;
    });
    await render();
    await talk();
    await render({ sessionKey: "web:study" });
    await act(async () => release());
    await settle();
    // Not the old conversation brought back under the new one's key.
    expect(spoken).toEqual([]);
  });

  it("says why when it can't start talking", async () => {
    sessionStatus = 409;
    await render();
    await talk();
    expect(container.querySelector(".voice-error")?.textContent).toBe("Live sessions are off.");
  });

  it("talks while Space is held, unless the person is typing", async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    });
    await settle();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    });
    await settle();
    expect(posts.some((p) => p.url.endsWith("/turn"))).toBe(true);
  });
});

describe("models agents made, in the room the page draws", () => {
  const def = {
    name: "bookcase",
    owner: "planner",
    mount: "floor" as const,
    size: [0.9, 1.8, 0.34] as [number, number, number],
    parts: [],
  };
  const item = (id: string, model?: string) => ({
    id,
    name: id,
    kind: "model" as const,
    at: [0, 0] as [number, number],
    facing: 0,
    ...(model ? { model } : {}),
  });
  const place = { width: 4, depth: 4, height: 2.5, props: [item("model", "planner:bookcase")], spots: [], start: "" };

  it("draws a place with the models it was sent, and none when it was sent none", () => {
    expect(roomOf({ place, models: { "planner:bookcase": def } }).models).toEqual({ "planner:bookcase": def });
    expect(roomOf({ place, models: {} })).not.toHaveProperty("models");
  });

  it("keeps the models it has as the place's record changes, and asks again for one it hasn't been sent", () => {
    const shown = roomOf({ place, models: { "planner:bookcase": def } });
    const moved = { ...place, props: [{ ...item("model", "planner:bookcase"), at: [1, 1] as [number, number] }] };
    expect(withModels(moved, shown)).toEqual({ room: { ...moved, models: shown.models }, missing: false });
    const more = { ...place, props: [...place.props, item("model-2", "writer:lamp_post")] };
    expect(withModels(more, shown).missing).toBe(true);
  });

  it("asks again for a model that changed only when the room draws it", () => {
    const shown = roomOf({ place, models: { "planner:bookcase": def } });
    expect(drawsModel(shown, { type: "model", id: "planner:bookcase" })).toBe(true);
    expect(drawsModel(shown, { type: "model", id: "writer:lamp_post" })).toBe(false);
    expect(drawsModel(shown, { type: "todo", id: "planner:bookcase" })).toBe(false);
  });

  it("asks again when a record a face here shows changes, so its picture says what is true now", () => {
    const spec = (more: Record<string, unknown>) => ({ id: "c-1", kind: "list", props: {}, fallback: "", ...more });
    const faced = (face: Record<string, unknown>) =>
      roomOf({
        place,
        models: {
          "planner:bookcase": {
            ...def,
            parts: [{ shape: "box" as const, size: [1, 1, 0.1], at: [0, 0.5, 0], color: "#ffffff", face }],
          },
        } as never,
      });
    const list = faced({ kind: "list", spec: spec({ query: { type: "todo" } }) });
    expect(facesShow(list, "todo")).toBe(true);
    expect(facesShow(list, "habit")).toBe(false);
    expect(
      facesShow(faced({ kind: "card", spec: spec({ kind: "card", bind: { type: "note", id: "n" } }) }), "note"),
    ).toBe(true);
    expect(facesShow(roomOf({ place, models: { "planner:bookcase": def } }), "todo")).toBe(false);
  });
});

describe("wakesFor", () => {
  const wake = (key: string, agent: string) => ({ key, agent, at: 0, kind: "booked" as const, what: key });
  const wakes = [wake("a", "planner"), wake("b", "writer"), wake("c", "default")];
  it("shows everyone's on the square and in the lobby, the owner's at home, and those of whoever is there elsewhere", () => {
    expect(wakesFor("lobby", [], wakes).map((w) => w.key)).toEqual(["a", "b", "c"]);
    expect(wakesFor("town", [], wakes).map((w) => w.key)).toEqual(["a", "b", "c"]);
    expect(wakesFor("home:writer", ["planner"], wakes).map((w) => w.key)).toEqual(["b"]);
    expect(wakesFor("shared:lounge", ["planner", "default"], wakes).map((w) => w.key)).toEqual(["a", "c"]);
    expect(wakesFor(undefined, ["planner"], wakes)).toEqual([]);
  });
});

describe("tasksFor", () => {
  const tasks = [
    { id: "a", title: "a", status: "backlog", assignee: "planner" },
    { id: "b", title: "b", status: "backlog", assignee: "writer" },
    { id: "c", title: "c", status: "backlog", assignee: null },
  ];
  it("shows everyone's on the square and in the lobby, the owner's at home, and those of whoever is there elsewhere", () => {
    expect(tasksFor("lobby", [], tasks).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(tasksFor("town", [], tasks).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(tasksFor("home:writer", ["planner"], tasks).map((t) => t.id)).toEqual(["b"]);
    expect(tasksFor("room:local:trip", ["planner", "writer"], tasks).map((t) => t.id)).toEqual(["a", "b"]);
    expect(tasksFor(undefined, ["planner"], tasks)).toEqual([]);
  });
});

describe("your last exchange", () => {
  it("is what you last said and the answer after it, and no answer from before it", () => {
    expect(
      lastExchange([
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello." },
        { role: "user", content: "Where are we?" },
      ]),
    ).toEqual({ said: "Where are we?" });
    expect(
      lastExchange([
        { role: "user", content: "Where are we?" },
        { role: "tool", content: "{}" },
        { role: "assistant", content: "Nearly there." },
      ]),
    ).toEqual({ said: "Where are we?", reply: "Nearly there." });
    expect(lastExchange([{ role: "assistant", content: "Hello." }])).toEqual({});
    expect(lastExchange([])).toEqual({});
  });

  it("keeps each speaker's latest line, from the server or the page", () => {
    const server = {
      writer: { text: "old", at: "2026-10-19T12:00:00Z" },
      planner: { text: "p", at: "2026-10-19T12:00:00Z" },
    };
    const page = {
      writer: { text: "new", at: "2026-10-19T12:00:05Z" },
      you: { text: "hi", at: "2026-10-19T12:00:01Z" },
    };
    expect(newest(server, page)).toEqual({ ...server, writer: page.writer, you: page.you });
    // An older line from the page doesn't cover a newer one from the server.
    expect(newest(page, { writer: { text: "old", at: "2026-10-19T12:00:00Z" } })).toBe(page);
  });
});
