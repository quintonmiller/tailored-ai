/**
 * The chat page's scene and voice: the 3D view only for an agent with a
 * body, and talking out loud into the conversation on the page, with the
 * reply played as it streams and the agent's cues reaching its body. The
 * browser's microphone, recorder and audio are faked; the stream is real
 * enough to split an event across two network chunks.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StageInput } from "../avatar/stage";
import { type ChatStageOptions, TalkButton, tasksFor, useChatStage } from "./ChatStage";

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
  /** The last visitor stage's way to say a line started near you. */
  onLine: undefined as ((agent: string, text: string, nearness: number) => void) | undefined,
  /** The last stage's way to say a kiosk or a board was clicked. */
  onUse: undefined as ((action: string, on?: Record<string, string>) => void) | undefined,
  /** What the boards were told to show, each time. */
  tasks: [] as { id: string }[][],
  /** The last visitor stage's report of who you are standing next to. */
  onNear: undefined as ((agent: string | undefined) => void) | undefined,
  /** What the stage was told each agent last said, each time. */
  speech: [] as Record<string, { text: string; at: string }>[],
  cues: [] as string[],
  insets: [] as number[],
  /** Every room the stage was shown, first to last. */
  rooms: [] as { name?: string; props: { name: string }[]; doors?: { to: string; along: number }[] }[],
  /** Who else the stage was told is in the room, each time. */
  company: [] as string[][],
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
      onUse?: (action: string, on?: Record<string, string>) => void;
      onLine?: (agent: string, text: string, nearness: number) => void;
      company?: { agent: string }[];
      onDoor?: (door: { to: string }) => void;
      arriveFrom?: string;
    },
  ) => {
    stage.onLine = opts.onLine;
    stage.onDoor = opts.onDoor;
    stage.arrivals.push(opts.arriveFrom);
    stage.visitors.push(!!opts.visitor);
    stage.onNear = opts.onNear;
    stage.onUse = opts.onUse;
    stage.calls.push({ url, input, animations: opts.animations, chooseIdle: opts.chooseIdle, onPick: opts.onPick });
    stage.agents.push(opts.agent);
    stage.mounted++;
    return {
      dispose: () => {
        stage.mounted--;
      },
      setView: () => {},
      setInsets: ({ right }: { right: number }) => stage.insets.push(right),
      setRoom: (room: { name?: string; props: { name: string }[] }, moved?: boolean) => {
        stage.rooms.push(room);
        stage.moves.push(!!moved);
      },
      enter: (room: { name?: string; props: { name: string }[] }, from: string | undefined) => {
        stage.rooms.push(room);
        stage.entered.push(from);
      },
      setCompany: (company: { agent: string }[]) => stage.company.push(company.map((c) => c.agent)),
      setActivities: (a: Record<string, { doing: string }>) => stage.activities.push(a),
      setSpeech: (sp: Record<string, { text: string; at: string }>) => stage.speech.push(sp),
      setTasks: (t: { id: string }[]) => stage.tasks.push(t),
      cue: (c: { name: string; target?: string }) => stage.cues.push(c.target ? `${c.name}:${c.target}` : c.name),
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
let company: { agent: string; name: string; avatar: string; animations: string[] }[] = [];
/** Where the door of the agent's own place is, as the server says. */
let homeDoorAlong = 1;
/** The agents as configured: which run on their own. */
let agentsInfo: Record<string, { online?: { enabled?: boolean } }> = {};
/** The last thing each agent said, as the server's speech records say. */
let speechRecords: { id: string; data: { agent: string; text: string; at: string } }[] = [];
/** Agents the page was asked to switch to. */
const chattedWith: string[] = [];
/** New chats the page was asked to start, with what to say. */
const drafts: [string, string][] = [];
/** What every agent is doing, as the server's activity records say. */
let activityRecords: { id: string; data: { agent: string; doing: string; what: string } }[] = [];
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
  audios.length = 0;
  spoken.length = 0;
  extras.length = 0;
  stage.calls.length = 0;
  stage.cues.length = 0;
  stage.insets.length = 0;
  stage.rooms.length = 0;
  stage.arrivals.length = 0;
  stage.entered.length = 0;
  stage.moves.length = 0;
  stage.company.length = 0;
  stage.activities.length = 0;
  stage.speech.length = 0;
  stage.visitors.length = 0;
  stage.tasks.length = 0;
  drafts.length = 0;
  chattedWith.length = 0;
  agentsInfo = {};
  speechRecords = [];
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
      if (url === "/api/agents") return new Response(JSON.stringify(agentsInfo));
      if (url === "/api/ext/builtin:places/map")
        return new Response(
          JSON.stringify({
            places: [
              { id: "home:talker", name: "talker's room", kind: "home", owner: "talker", agents: ["talker"] },
              { id: "home:planner", name: "planner's room", kind: "home", owner: "planner", agents: ["planner"] },
              { id: "room:local:trip", name: "trip", kind: "room", agents: ["planner", "writer"] },
            ],
          }),
        );
      if (url === `/api/ext/builtin:places/scene/${encodeURIComponent("home:planner")}`)
        return new Response(
          JSON.stringify({
            id: "home:planner",
            place: { ...home, name: "planner's room" },
            company: [{ agent: "planner", name: "planner", avatar: "/api/live/avatar?agent=planner" }],
            doors: [{ wall: "back", along: 1, to: "hall:main:homes-1", label: "Residences", kind: "hall" }],
          }),
        );
      if (url === `/api/ext/builtin:places/scene/${encodeURIComponent("hall:main:homes-1")}`)
        return new Response(
          JSON.stringify({
            id: "hall:main:homes-1",
            place: { ...home, name: "Residences", props: [] },
            company: [],
            doors: [
              { wall: "left", along: 0, to: "lobby", label: "Lobby", kind: "lobby" },
              { wall: "back", along: -2, to: "home:planner", label: "planner", kind: "home", occupant: "planner" },
              { wall: "front", along: -2, to: "home:talker", label: "talker", kind: "home", occupant: "talker" },
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
            place: home,
            company,
            doors: [{ wall: "back", along: homeDoorAlong, to: "hall:main:homes-1", label: "Residences", kind: "hall" }],
          }),
        );
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
    </div>
  );
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function render(props: Partial<ChatStageOptions> & { following?: boolean } = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
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
    await render();
    const buttons = await pick("planner");
    expect(container.querySelector(".agent-menu-head")?.textContent).toMatch(/planner.*taking a photo/);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Chat with planner",
      "Send home",
      "Pause for 4 hours",
      "About planner",
    ]);
    // Home from a meeting room it is visiting and from the shared place it went to, whichever it is in: nothing to
    // end in one of them is no trouble.
    missing = ["/api/state/visit/planner"];
    await press(buttons, "Send home");
    expect(deleted).toEqual(["/api/state/visit/planner", "/api/state/whereabouts/planner"]);
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
    expect(rooms.map((r) => r.querySelector(".world-map-name")?.textContent)).toEqual([
      "#trip",
      "talker's roomyou are here",
      "planner's room",
    ]);
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

  it("goes through doors in your own body: out of the agent's room into the hall, and on into another home", async () => {
    await render({ following: true });
    expect(stage.rooms.at(-1)?.doors?.map((d) => d.to)).toEqual(["hall:main:homes-1"]);
    // From the agent's own view, a door starts a visit: your body, come out of the door on the other side.
    await act(async () => stage.onDoor?.({ to: "hall:main:homes-1" }));
    await settle(60);
    expect(stage.visitors.at(-1)).toBe(true);
    expect(stage.arrivals.at(-1)).toBe("home:talker");
    expect(stage.rooms.at(-1)?.name).toBe("Residences");
    // A hall is nobody's home: the conversation goes on.
    expect(chattedWith).toEqual([]);
    const made = stage.calls.length;
    // On through the next door: the same stage, the same body, into planner's home from the hall, talking to planner.
    await act(async () => stage.onDoor?.({ to: "home:planner" }));
    await settle(60);
    expect(stage.calls.length).toBe(made);
    expect(stage.entered.at(-1)).toBe("hall:main:homes-1");
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
    const go = async (name: string) => {
      await act(async () => tool("Map").click());
      await settle();
      const place = [...container.querySelectorAll(".world-map-place")].find((b) =>
        b.querySelector(".world-map-name")?.textContent?.startsWith(name),
      ) as HTMLButtonElement;
      await act(async () => place.click());
      await settle(60);
    };
    await go("planner's room");
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
    await go("planner's room");
    await go("talker's room");
    expect(chattedWith).toEqual(["planner", "talker", "planner", "talker"]);
    expect(stage.visitors.at(-1)).toBe(false);
  });

  it("says who you came back to even when the switch away never happened, so a waiting one is called off", async () => {
    // Not following: as when the switch to planner is still waiting for a reply.
    await render();
    await act(async () =>
      ([...container.querySelectorAll(".talk-tool")].find((b) => b.textContent === "Map") as HTMLElement).click(),
    );
    await settle();
    const planner = [...container.querySelectorAll(".world-map-place")].find((b) =>
      b.querySelector(".world-map-name")?.textContent?.startsWith("planner's room"),
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

  it("opens and closes the map with M, unless you are typing", async () => {
    await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM" })));
    await settle();
    expect(container.querySelector(".world-map")).not.toBeNull();
    const field = document.createElement("textarea");
    container.appendChild(field);
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", bubbles: true })));
    expect(container.querySelector(".world-map")).not.toBeNull();
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

describe("tasksFor", () => {
  const tasks = [
    { id: "a", title: "a", status: "backlog", assignee: "planner" },
    { id: "b", title: "b", status: "backlog", assignee: "writer" },
    { id: "c", title: "c", status: "backlog", assignee: null },
  ];
  it("shows everyone's in the lobby, the owner's at home, and those of whoever is there elsewhere", () => {
    expect(tasksFor("lobby", [], tasks).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(tasksFor("home:writer", ["planner"], tasks).map((t) => t.id)).toEqual(["b"]);
    expect(tasksFor("room:local:trip", ["planner", "writer"], tasks).map((t) => t.id)).toEqual(["a", "b"]);
    expect(tasksFor(undefined, ["planner"], tasks)).toEqual([]);
  });
});
