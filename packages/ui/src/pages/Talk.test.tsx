/**
 * The Talk page: start a session, talk (or type), and play the reply as it
 * streams in. The browser's microphone, recorder and audio are faked; the
 * stream is real enough to split an event across two network chunks.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StageInput } from "../avatar/stage";
import { Talk } from "./Talk";

// The 3D stage needs WebGL, which jsdom lacks; what the page hands it is the contract.
const stage = vi.hoisted(() => ({
  calls: [] as { url: string; input: StageInput }[],
  fail: null as string | null,
}));
vi.mock("../avatar/stage", () => ({
  createStage: async (_host: HTMLElement, url: string, input: StageInput) => {
    if (stage.fail) throw new Error(stage.fail);
    stage.calls.push({ url, input });
    return { dispose: () => {} };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const played: string[] = [];
const posted: { url: string; type: string | null; body: unknown }[] = [];
let turnChunks: string[] = [];
let turnStatus = 200;
let liveInfo: Record<string, unknown> = {};

/** A response whose body arrives in the given chunks. */
function streamed(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { status },
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
  played.length = 0;
  posted.length = 0;
  turnStatus = 200;
  liveInfo = {};
  stage.calls.length = 0;
  stage.fail = null;
  const audio = btoa("mp3-bytes");
  turnChunks = [
    'event: transcript\ndata: {"text":"water the plants"}\n\n',
    'event: text\ndata: {"delta":"Done. "}\n\nevent: text\ndata: {"delta":"Anything else?"}\n\n',
    // An event whose name and data arrive in different chunks.
    "event: audio\n",
    `data: {"seq":0,"text":"Done.","mimeType":"audio/mpeg","data":"${audio}"}\n\n`,
    'event: done\ndata: {"transcript":"water the plants","reply":"Done. Anything else?","timings":{"sttMs":120,"firstAudioMs":900,"totalMs":1500}}\n\n',
  ];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    // Resolves after the page has rendered, as a real microphone prompt does.
    value: {
      getUserMedia: vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve({ getTracks: () => [{ stop: () => {} }] }), 20)),
      ),
    },
  });
  vi.stubGlobal(
    "Audio",
    class {
      onended: (() => void) | null = null;
      constructor(readonly src: string) {}
      play() {
        played.push(this.src);
        return Promise.resolve();
      }
      pause() {}
    },
  );
  URL.createObjectURL = vi.fn(() => `blob:${played.length}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/agents") return new Response(JSON.stringify({ talker: {} }));
      if (url === "/api/live") return new Response(JSON.stringify(liveInfo));
      if (url === "/api/live/sessions") {
        return new Response(
          JSON.stringify({
            id: "live-1",
            agent: "talker",
            turns: 0,
            limits: { maxMinutes: 30, idleMinutes: 10, maxTurns: 200 },
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/turn")) {
        const type = new Headers(init?.headers).get("Content-Type");
        posted.push({ url, type, body: typeof init?.body === "string" ? JSON.parse(init.body) : "blob" });
        if (turnStatus !== 200)
          return new Response(JSON.stringify({ error: "This session has ended: it was ended." }), {
            status: turnStatus,
          });
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

async function render() {
  await act(async () => {
    root.render(<Talk />);
  });
  await act(async () => {});
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

/** The stage is imported on demand; give that import a moment to land. */
async function loadStage() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function startSession() {
  await act(async () => button("Start talking").click());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe("Talk page", () => {
  it("enables the talk button once the microphone is open", async () => {
    await render();
    await startSession();
    const talk = container.querySelector(".talk-button") as HTMLButtonElement;
    expect(talk.disabled).toBe(false);
    expect(talk.textContent).toContain("Hold to talk");
  });

  it("sends what was said and shows and plays the reply as it streams", async () => {
    await render();
    await startSession();
    const talk = container.querySelector(".talk-button") as HTMLButtonElement;
    talk.setPointerCapture = () => {};
    await act(async () => {
      talk.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(talk.textContent).toContain("Listening");
    await act(async () => {
      talk.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    for (let i = 0; i < 4; i++) await act(async () => {});

    expect(posted).toEqual([{ url: "/api/live/sessions/live-1/turn", type: "audio/webm", body: "blob" }]);
    const lines = [...container.querySelectorAll(".talk-line")].map((l) => l.textContent);
    expect(lines).toEqual(["Youwater the plants", "talkerDone. Anything else?"]);
    expect(played).toHaveLength(1);
    expect(container.querySelector(".talk-timing")?.textContent).toBe("heard in 120 ms, first word at 900 ms");
  });

  it("takes a typed turn", async () => {
    await render();
    await startSession();
    const input = container.querySelector(".talk-type input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "what's on today?");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send").click());
    for (let i = 0; i < 4; i++) await act(async () => {});
    expect(posted[0]).toMatchObject({ type: "application/json", body: { text: "what's on today?" } });
  });

  it("draws no avatar when none is configured", async () => {
    await render();
    expect(container.querySelector(".talk-avatar")).toBeNull();
    expect(stage.calls).toHaveLength(0);
  });

  it("draws the configured avatar, showing each moment of the turn and the voice's loudness", async () => {
    liveInfo = { avatar: "/api/live/avatar" };
    await render();
    await loadStage();
    expect(container.querySelector(".talk-avatar")).not.toBeNull();
    expect(stage.calls.map((c) => c.url)).toEqual(["/api/live/avatar"]);
    const now = () => stage.calls[0].input();
    expect(now().state).toBe("idle");
    expect(now().loudness()).toBe(0);

    await startSession();
    const talk = container.querySelector(".talk-button") as HTMLButtonElement;
    talk.setPointerCapture = () => {};
    await act(async () => {
      talk.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(now().state).toBe("listening");
    await act(async () => {
      talk.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    for (let i = 0; i < 4; i++) await act(async () => {});
    // The reply's audio is playing, and never ended: the body is speaking, mouth moving.
    expect(now().state).toBe("speaking");
    expect(now().loudness()).toBeGreaterThan(0);
  });

  it("says why when the avatar can't be drawn, and the page still works", async () => {
    liveInfo = { avatar: "/api/live/avatar" };
    stage.fail = "the file is not a VRM model";
    await render();
    await loadStage();
    expect(container.querySelector(".talk-avatar-problem")?.textContent).toBe(
      "Couldn't show the avatar: the file is not a VRM model",
    );
    await startSession();
    expect((container.querySelector(".talk-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says why when the session can no longer take a turn", async () => {
    turnStatus = 409;
    await render();
    await startSession();
    const input = container.querySelector(".talk-type input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "hello");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send").click());
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(container.querySelector(".config-error")?.textContent).toBe("This session has ended: it was ended.");
    expect(container.querySelector(".talk-ended")?.textContent).toContain("Ended");
  });
});
