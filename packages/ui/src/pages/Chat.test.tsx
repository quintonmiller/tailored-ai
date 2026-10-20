/**
 * Coming back to the chat page: the last conversation is restored, a new
 * message continues it, and the page never bounces between conversations.
 *
 * The bug this guards: restoring kept the conversation's id but not its key,
 * so the next message started a new conversation on the server. The page's
 * "follow the URL" effect then fought its "keep the URL in step" effect, and
 * the view flickered between the two before settling on the wrong one.
 */
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider } from "../components/ChatContext";
import { type ChatStageOptions, TalkSlot } from "../components/ChatStage";
import { ToastProvider } from "../components/Toast";
import { ROOM_ASK } from "../components/WorldPlace";
import { Chat } from "./Chat";

/** When set, the page's scene is this instead of the real one: a meeting room, say, without a GPU. */
let fakeScene: ((opts: ChatStageOptions) => unknown) | null = null;
vi.mock("../components/ChatStage", async (importOriginal) => {
  const real = await importOriginal<typeof import("../components/ChatStage")>();
  return {
    ...real,
    // One or the other for a whole test, so the hooks a render calls never change order.
    // biome-ignore lint/correctness/useHookAtTopLevel: fixed per test, never switched between renders.
    useChatStage: (opts: ChatStageOptions) => (fakeScene ? fakeScene(opts) : real.useChatStage(opts)),
  };
});

/** A scene with the chat panel over it, somewhere in the world, as `useChatStage` hands the page one. */
function sceneAt(visiting: string | null, showStage = true) {
  return {
    showStage,
    has3d: true,
    stageOn: true,
    setStageOn: () => {},
    stage: null,
    visiting,
    placeName: "trip",
    activities: {},
    spoken: null,
    voice: { phase: "idle", error: null },
    voiceEnabled: false,
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const chatPosts: { sessionKey?: string; sessionId?: string; agent?: string }[] = [];
/** Whether the fake server continues a conversation named by id, as the real one does. */
let continuesById = true;
const messageFetches: string[] = [];
let sessionRows: unknown[] = [];
/** Pictures the fake turn's tools made, as the server sends them on the response event. */
let turnMedia: unknown[] = [];
/** The agents there are, as the server lists them. */
let agentList: Record<string, unknown> = {};
/** When set, a reply waits for this before it finishes: a turn still on its way. */
let held: Promise<void> | null = null;
/** A conversation's messages wait for this before they arrive, when set for it. */
const slowMessages: Record<string, Promise<void>> = {};

const history: Record<string, unknown[]> = {
  "sess-1": [
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
  ],
};

/** The chat route's reply: it continues the conversation its key or id names, or starts a new one. */
function reply(sessionKey: string | undefined, sessionId: string | undefined): Response {
  const named = Object.entries(keys).find(([, k]) => k === sessionKey)?.[0];
  const continued = sessionKey === "web:kitchen" || (continuesById && sessionId === "sess-1");
  const id = named ?? (continued ? "sess-1" : "sess-new");
  // A key the page made up is the new conversation's key, as the server keeps it.
  const key = named || continued ? (keys[id] ?? "web:kitchen") : (sessionKey ?? "web:fresh");
  history[id] = [...(history[id] ?? []), { role: "user", content: "Hey!" }, { role: "assistant", content: "Hello!" }];
  const frames = [
    `event: delta\ndata: ${JSON.stringify({ text: "Hello!" })}\n\n`,
    `event: response\ndata: ${JSON.stringify({ content: "Hello!", sessionId: id, sessionKey: key, ...(turnMedia.length ? { media: turnMedia } : {}) })}\n\n`,
  ];
  const wait = held;
  if (!wait) return new Response(frames.join(""));
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(frames[0]));
        await wait;
        controller.enqueue(encoder.encode(frames[1]));
        controller.close();
      },
    }),
  );
}

/** Each stored conversation's key. */
const keys: Record<string, string> = {
  "sess-1": "web:kitchen",
  "sess-p": "web:planner:100",
  "sess-d": "web:default:300",
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chatPosts.length = 0;
  messageFetches.length = 0;
  sessionRows = [];
  continuesById = true;
  turnMedia = [];
  agentList = {};
  held = null;
  fakeScene = null;
  for (const id of Object.keys(slowMessages)) delete slowMessages[id];
  history["sess-d"] = [
    { role: "user", content: "Another day" },
    { role: "assistant", content: "Another answer" },
  ];
  history["sess-p"] = [
    { role: "user", content: "Where should we stay?" },
    { role: "assistant", content: "Alfama, near the river." },
  ];
  localStorage.clear();
  window.location.hash = "/chat";
  delete history["sess-new"];
  history["sess-1"] = history["sess-1"].slice(0, 2);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat") {
        const body = JSON.parse(String(init?.body));
        chatPosts.push(body);
        return reply(body.sessionKey, body.sessionId);
      }
      const m = /^\/api\/sessions\/([^/]+)\/messages/.exec(url);
      if (m) {
        messageFetches.push(m[1]);
        await slowMessages[m[1]];
        return new Response(JSON.stringify(history[m[1]] ?? []));
      }
      if (url.startsWith("/api/ext/builtin:places/transcript/"))
        return new Response(JSON.stringify({ name: "trip", members: ["planner", "writer"], lines: [] }));
      if (url.startsWith("/api/sessions")) return new Response(JSON.stringify(sessionRows));
      if (url.startsWith("/api/agents")) return new Response(JSON.stringify(agentList));
      if (url.startsWith("/api/live")) return new Response(JSON.stringify({ enabled: false }));
      return new Response("{}");
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** The app hands Chat its route from the URL hash; this does the same. */
function routeProps() {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return { sessionId: q.get("session") ?? undefined, sessionKey: q.get("key") ?? undefined };
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
}

async function render() {
  await act(async () => {
    root.render(
      <ToastProvider>
        <ChatProvider>
          <Chat {...routeProps()} />
        </ChatProvider>
      </ToastProvider>,
    );
  });
  await settle();
}

/** Re-render with whatever the URL now says, as the app does on a hash change. */
async function followUrl() {
  await act(async () => {
    root.render(
      <ToastProvider>
        <ChatProvider>
          <Chat {...routeProps()} />
        </ChatProvider>
      </ToastProvider>,
    );
  });
  await settle();
}

async function send(text: string) {
  const input = container.querySelector(".chat-input-bar input[type=text]") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

const shown = () => container.querySelector(".chat-messages")?.textContent ?? "";

describe("coming back to the chat", () => {
  it("restores the last conversation and continues it with the next message", async () => {
    localStorage.setItem("tai.chat.activeSessionId", "sess-1");
    localStorage.setItem("tai.chat.activeSessionKey", "web:kitchen");
    await render();
    expect(shown()).toContain("Earlier answer");
    await send("Hey!");
    expect(chatPosts.map((p) => p.sessionKey)).toEqual(["web:kitchen"]);
    await followUrl();
    expect(shown()).toContain("Earlier answer");
    expect(shown()).toContain("Hello!");
  });

  it("continues a conversation it has no key for, from storage or a link, by naming it", async () => {
    localStorage.setItem("tai.chat.activeSessionId", "sess-1");
    window.location.hash = "/chat?session=sess-1";
    await render();
    await send("Hey!");
    expect(chatPosts[0]).toMatchObject({ sessionId: "sess-1" });
    expect(chatPosts[0]?.sessionKey).toBeUndefined();
    await followUrl();
    expect(routeProps().sessionId).toBe("sess-1");
    expect(shown()).toContain("Earlier answer");
    expect(shown()).toContain("Hello!");
    // The reply's key is kept, so the next message names the conversation by it.
    expect(localStorage.getItem("tai.chat.activeSessionKey")).toBe("web:kitchen");
  });

  it("settles on the conversation a reply moved to, without bouncing back to the old one", async () => {
    // A server that starts a new conversation anyway: the page must follow it, not bounce.
    continuesById = false;
    localStorage.setItem("tai.chat.activeSessionId", "sess-1");
    await render();
    window.location.hash = "/chat?session=sess-1";
    await followUrl();
    messageFetches.length = 0;
    await send("Hey!");
    for (let i = 0; i < 4; i++) await followUrl();
    expect(routeProps().sessionId).toBe("sess-new");
    // The old conversation is never loaded back over the new one.
    expect(messageFetches.filter((id) => id === "sess-1")).toEqual([]);
    expect(shown()).toContain("Hello!");
  });

  it("shows a picture the turn's tools made with the reply, as Discord sends it", async () => {
    turnMedia = [{ id: "img-1", mimeType: "image/png", bytes: 100, name: "selfie.png" }];
    await render();
    await send("Send me a selfie");
    const img = container.querySelector(".chat-messages .message-bubble.assistant img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("/api/media/img-1");
  });
});

describe("talking to another agent", () => {
  const plannerRow = {
    id: "sess-p",
    key: "web:planner:100",
    model: "m",
    provider: "p",
    project_id: null,
    title: null,
    pinned: 0,
    created_at: "2026-10-01 09:00:00",
    updated_at: "2026-10-01 09:00:00",
  };

  beforeEach(() => {
    agentList = { planner: {}, writer: {} };
    sessionRows = [plannerRow];
    localStorage.setItem("tai.chat.activeSessionId", "sess-1");
    localStorage.setItem("tai.chat.activeSessionKey", "web:kitchen");
  });

  async function choose(agent: string, picker = ".chat-agent-select") {
    const select = container.querySelector(picker) as HTMLSelectElement;
    await act(async () => {
      select.value = agent;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  }

  it("leaves the last agent's conversation, and picks up your latest with the new one", async () => {
    await render();
    expect(shown()).toContain("Earlier answer");
    await choose("planner");
    expect(shown()).toContain("Alfama, near the river.");
    expect(shown()).not.toContain("Earlier answer");
    await send("Hey!");
    expect(chatPosts.at(-1)).toMatchObject({ sessionKey: "web:planner:100", agent: "planner" });
  });

  it("starts a new conversation, named for the agent, with one you haven't talked to", async () => {
    await render();
    await choose("writer");
    expect(shown()).not.toContain("Earlier answer");
    // Nor does a reload bring it back: the URL has let go of it.
    expect(routeProps().sessionId).toBeUndefined();
    await send("Hey!");
    // Never the default agent's conversation, which is where it used to go.
    expect(chatPosts.at(-1)?.sessionKey).toMatch(/^web:writer:\d+$/);
    expect(chatPosts.at(-1)?.agent).toBe("writer");
  });

  it("lets a reply on its way finish before switching", async () => {
    let release = () => {};
    held = new Promise<void>((r) => {
      release = r;
    });
    await render();
    await send("Hey!");
    await choose("planner");
    // The reply is still coming into the conversation it was asked in; the picker shows where you go next.
    expect(shown()).toContain("Earlier answer");
    expect((container.querySelector(".chat-agent-select") as HTMLSelectElement).value).toBe("planner");
    await act(async () => release());
    await settle();
    expect(chatPosts.map((p) => p.sessionKey)).toEqual(["web:kitchen"]);
    expect(shown()).toContain("Alfama, near the river.");
    expect((container.querySelector(".chat-agent-select") as HTMLSelectElement).value).toBe("planner");
  });

  it("calls a waiting switch off when you pick the agent the reply is from", async () => {
    let release = () => {};
    held = new Promise<void>((r) => {
      release = r;
    });
    fakeScene = () => sceneAt(null);
    await render();
    const header = () => container.querySelector(".chat-with-who")?.textContent ?? "";
    await send("Hey!");
    await choose("planner", ".chat-with-switch select");
    expect(header()).toContain("Then planner, once this reply is done");
    await choose("", ".chat-with-switch select");
    // Nothing waiting any more: not even a switch to the agent you are with.
    expect(header()).toBe("Default agent");
    expect((container.querySelector(".chat-with-switch select") as HTMLSelectElement).value).toBe("");
    await act(async () => release());
    await settle();
    expect(shown()).toContain("Earlier answer");
    expect(shown()).not.toContain("Alfama");
  });

  it("waits for a spoken reply as for a typed one", async () => {
    let speaking: ((on: boolean) => void) | undefined;
    fakeScene = (opts) => {
      speaking = opts.setSpeaking;
      return sceneAt(null, false);
    };
    await render();
    await act(async () => speaking?.(true));
    await choose("planner");
    expect(shown()).toContain("Earlier answer");
    await act(async () => speaking?.(false));
    await settle();
    expect(shown()).toContain("Alfama, near the river.");
  });

  it("comes back to the conversation you left an agent in, not its latest", async () => {
    // A later conversation with the default agent than the one on screen.
    sessionRows = [
      plannerRow,
      { ...plannerRow, id: "sess-d", key: "web:default:300", updated_at: "2026-10-09 09:00:00" },
    ];
    await render();
    await choose("planner");
    await choose("");
    expect(shown()).toContain("Earlier answer");
    expect(shown()).not.toContain("Another answer");
    await send("Hey!");
    expect(chatPosts.at(-1)?.sessionKey).toBe("web:kitchen");
  });

  it("comes back to a new conversation you hadn't written in yet, rather than an old one", async () => {
    sessionRows = [
      plannerRow,
      { ...plannerRow, id: "sess-d", key: "web:default:300", updated_at: "2026-10-09 09:00:00" },
    ];
    await render();
    await act(async () => (container.querySelector(".chat-new-btn") as HTMLButtonElement).click());
    await settle();
    await choose("planner");
    await choose("");
    expect(shown()).not.toContain("Earlier answer");
    expect(shown()).not.toContain("Another answer");
    expect(shown()).toContain("Send a message to start a conversation");
  });

  it("never shows one agent's messages in another's conversation, however quickly you move on", async () => {
    let arrive = () => {};
    slowMessages["sess-p"] = new Promise<void>((r) => {
      arrive = r;
    });
    await render();
    await choose("planner");
    await choose("writer");
    await act(async () => arrive());
    await settle();
    expect(shown()).not.toContain("Alfama");
    await send("Hey!");
    expect(chatPosts.at(-1)?.sessionKey).toMatch(/^web:writer:\d+$/);
  });

  it("starts a conversation with the agent a link names, as the Agents page's Open in chat does", async () => {
    window.location.hash = "/chat?key=web:planner:1";
    await render();
    expect((container.querySelector(".chat-agent-select") as HTMLSelectElement).value).toBe("planner");
    // Not the conversation the page would otherwise have picked up again.
    expect(shown()).not.toContain("Earlier answer");
    await send("Hey!");
    expect(chatPosts.at(-1)?.agent).toBe("planner");
    expect(chatPosts.at(-1)?.sessionKey).toMatch(/^web:planner:\d+$/);
  });

  it("talks to whoever you pick in a meeting room, from the room or its tabs, instead of reading the room", async () => {
    let chatWith: ((name: string) => void) | undefined;
    fakeScene = (opts) => {
      chatWith = opts.onChatWith;
      return sceneAt("room:local:trip");
    };
    await render();
    const bar = () => container.querySelector(".chat-input-bar") as HTMLElement;
    const tab = (name: string) =>
      [...container.querySelectorAll(".chat-with-tabs button")].find((b) => b.textContent === name) as HTMLElement;
    expect(bar().hidden).toBe(true);
    expect(tab("Room").getAttribute("aria-selected")).toBe("true");
    // Talk to, beside someone in the room, or Chat with on their menu.
    await act(async () => chatWith?.("planner"));
    await settle();
    expect(bar().hidden).toBe(false);
    expect(tab("Room").getAttribute("aria-selected")).toBe("false");
    expect(tab("planner").getAttribute("aria-selected")).toBe("true");
    expect(shown()).toContain("Alfama, near the river.");
    await act(async () => tab("Room").click());
    expect(bar().hidden).toBe(true);
  });

  it("leaves reading the room for a message written for someone, as Redo its room writes one", async () => {
    let draft: ((name: string, text: string) => void) | undefined;
    fakeScene = (opts) => {
      draft = opts.onDraft;
      return sceneAt("room:local:trip");
    };
    await render();
    const bar = () => container.querySelector(".chat-input-bar") as HTMLElement;
    expect(bar().hidden).toBe(true);
    await act(async () => draft?.("planner", ROOM_ASK));
    await settle();
    expect(bar().hidden).toBe(false);
    expect((container.querySelector(".chat-input-bar input[type=text]") as HTMLInputElement).value).toBe(ROOM_ASK);
  });

  it("goes on with the agent a reopened conversation was with", async () => {
    localStorage.setItem("tai.chat.activeSessionId", "sess-p");
    localStorage.setItem("tai.chat.activeSessionKey", "web:planner:100");
    await render();
    expect((container.querySelector(".chat-agent-select") as HTMLSelectElement).value).toBe("planner");
    await send("Hey!");
    expect(chatPosts.at(-1)).toMatchObject({ sessionKey: "web:planner:100", agent: "planner" });
  });
});

describe("the chat beside a panel in the world", () => {
  /** A scene with a task, list or agent panel open in the chat's column, closed through `closePanel`. */
  function sceneWithPanel(closed: string[]) {
    return {
      ...sceneAt(null),
      worldPanel: true,
      sidePanel: true,
      chatCovered: true,
      closePanel: () => closed.push("closed"),
    };
  }

  it("leaves a reply on its way alone when Escape closes a panel", async () => {
    let release = () => {};
    held = new Promise<void>((r) => {
      release = r;
    });
    fakeScene = () => sceneWithPanel([]);
    await render();
    await send("Hey!");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    await settle();
    expect(shown()).not.toContain("[Interrupted]");
    await act(async () => release());
    await settle();
    expect(shown()).toContain("Hello!");
  });

  it("leaves it alone too when the panel heard Escape first and has already closed", async () => {
    let release = () => {};
    held = new Promise<void>((r) => {
      release = r;
    });
    // A panel opened before the message was sent hears the key first, and may be gone by the time the page does.
    const claim = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", claim);
    try {
      fakeScene = () => sceneAt(null);
      await render();
      await send("Hey!");
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
      await settle();
      expect(shown()).not.toContain("[Interrupted]");
    } finally {
      window.removeEventListener("keydown", claim);
      await act(async () => release());
      await settle();
    }
  });

  it("still stops a reply on Escape with nothing open over the scene", async () => {
    let release = () => {};
    held = new Promise<void>((r) => {
      release = r;
    });
    fakeScene = () => sceneAt(null);
    await render();
    await send("Hey!");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(shown()).toContain("[Interrupted]");
    await act(async () => release());
    await settle();
  });

  it("brings the chat back from the toolbar's Chat button, closing the panel that had its place", async () => {
    const closed: string[] = [];
    fakeScene = () => sceneWithPanel(closed);
    await render();
    const button = [...container.querySelectorAll(".chat-toolbar-btn")].find(
      (b) => b.textContent === "Chat",
    ) as HTMLButtonElement;
    // The chat is out of sight, so the button doesn't say it is showing.
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await act(async () => button.click());
    expect(closed).toEqual(["closed"]);
    // And the chat is to be shown once it closes, not hidden as a press of a showing chat would.
    expect(container.querySelector(".chat")?.classList.contains("chat-panel-hidden")).toBe(false);
  });
});

describe("your conversation in the world", () => {
  /** Where the stage would be: what the page draws into the conversation in the world shows there. */
  function TalkInWorld() {
    return <div className="fake-stage">{useContext(TalkSlot)}</div>;
  }
  /** A scene with your conversation shown in the world beside whoever you talk to: on the phone, or face to face. */
  function sceneTalking(phone = false) {
    return {
      ...sceneAt(null),
      stage: <TalkInWorld />,
      talk: { phone, name: "talker" },
      worldPanel: false,
      chatCovered: false,
      closePanel: () => {},
    };
  }
  const world = () => container.querySelector(".fake-stage .world-talk") as HTMLElement;
  const lines = () => [...world().querySelectorAll(".world-talk-line")].map((l) => l.textContent);

  async function sayInWorld(text: string) {
    const input = world().querySelector(".world-talk-input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
  }

  it("hides the whole chat at first, shows the last turns beside the agent, and sends from there", async () => {
    localStorage.setItem("tai.chat.activeSessionId", "sess-1");
    localStorage.setItem("tai.chat.activeSessionKey", "web:kitchen");
    fakeScene = () => sceneTalking();
    await render();
    expect(container.querySelector(".chat")?.classList.contains("chat-panel-hidden")).toBe(true);
    expect(lines()).toEqual(["Earlier question", "Earlier answer"]);
    let release = () => {};
    held = new Promise<void>((r) => {
      release = r;
    });
    await sayInWorld("Hey!");
    expect(chatPosts.map((p) => p.sessionKey)).toEqual(["web:kitchen"]);
    // The reply comes in beside the agent as it arrives, and the box is the chat's own: empty again for both.
    expect(world().querySelector(".world-talk-live")?.textContent).toBe("Hello!");
    expect((container.querySelector(".chat-input-bar input[type=text]") as HTMLInputElement).value).toBe("");
    await act(async () => release());
    await settle();
    expect(lines()).toEqual(["Earlier question", "Earlier answer", "Hey!", "Hello!"]);
    expect(world().querySelector(".world-talk-live")).toBeNull();
    // The whole conversation is a click away, beside the world.
    await act(async () => (world().querySelector(".world-talk-full") as HTMLButtonElement).click());
    expect(container.querySelector(".chat")?.classList.contains("chat-panel-hidden")).toBe(false);
  });

  it("is a call when the agent is somewhere else, and a message written for someone is ready in it to send", async () => {
    let draft: ((name: string, text: string) => void) | undefined;
    fakeScene = (opts) => {
      draft = opts.onDraft;
      return sceneTalking(true);
    };
    await render();
    expect(world().classList.contains("world-talk-phone")).toBe(true);
    expect(world().querySelector(".world-talk-head")?.textContent).toMatch(/On the phone with talker/);
    await act(async () => draft?.("planner", ROOM_ASK));
    await settle();
    expect((world().querySelector(".world-talk-input") as HTMLInputElement).value).toBe(ROOM_ASK);
    // Ready to send where you are: the whole chat stays hidden.
    expect(container.querySelector(".chat")?.classList.contains("chat-panel-hidden")).toBe(true);
  });
});
