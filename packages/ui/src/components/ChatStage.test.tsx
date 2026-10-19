/**
 * The chat page's scene and voice: the 3D view only for an agent with a
 * body, and talking out loud into the conversation on the page, with the
 * reply played as it streams and the agent's cues reaching its body. The
 * browser's microphone, recorder and audio are faked; the stream is real
 * enough to split an event across two network chunks.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StageInput } from "../avatar/stage";
import { type ChatStageOptions, TalkButton, useChatStage } from "./ChatStage";

const stage = vi.hoisted(() => ({
  calls: [] as { url: string; input: StageInput; animations?: string[] }[],
  cues: [] as string[],
  insets: [] as number[],
  /** Stages on screen now: what render() waits for, instead of a fixed sleep a slow runner outlasts. */
  mounted: 0,
}));
vi.mock("../avatar/stage", () => ({
  createStage: async (_host: HTMLElement, url: string, input: StageInput, opts: { animations?: string[] }) => {
    stage.calls.push({ url, input, animations: opts.animations });
    stage.mounted++;
    return {
      dispose: () => {
        stage.mounted--;
      },
      setView: () => {},
      setInsets: ({ right }: { right: number }) => stage.insets.push(right),
      cue: (c: { name: string; target?: string }) => stage.cues.push(c.target ? `${c.name}:${c.target}` : c.name),
    };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let liveInfo: Record<string, unknown>;
let sessionStatus: number;
let turnChunks: string[];
const posts: { url: string; body: unknown }[] = [];
const deleted: string[] = [];
const audios: { src: string; onended: (() => void) | null }[] = [];
const spoken: [string | undefined, string][] = [];

function streamed(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
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
  posts.length = 0;
  deleted.length = 0;
  audios.length = 0;
  spoken.length = 0;
  extras.length = 0;
  stage.calls.length = 0;
  stage.cues.length = 0;
  stage.insets.length = 0;
  stage.mounted = 0;
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
      if (init?.method === "DELETE") {
        deleted.push(url);
        return new Response("{}");
      }
      if (url === "/api/live/sessions") {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        if (sessionStatus !== 201)
          return new Response(JSON.stringify({ error: "Live sessions are off." }), { status: sessionStatus });
        return new Response(JSON.stringify({ id: `live-${posts.length}`, conversation: "conv-1" }), { status: 201 });
      }
      if (url.endsWith("/turn")) {
        posts.push({ url, body: "audio" });
        return streamed(turnChunks);
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

function Harness(props: Partial<ChatStageOptions>) {
  const scene = useChatStage({
    agent: "talker",
    sessionKey: "web:kitchen",
    sending: false,
    panelOpen: true,
    onSpoken: (conversation, key) => spoken.push([conversation, key]),
    setTurnExtras: (e) => extras.push(e),
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

async function render(props: Partial<ChatStageOptions> = {}) {
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
    expect(start.sessionKey).toMatch(/^web:\d+$/);
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
