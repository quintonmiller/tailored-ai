/**
 * Coming back to the chat page: the last conversation is restored, a new
 * message continues it, and the page never bounces between conversations.
 *
 * The bug this guards: restoring kept the conversation's id but not its key,
 * so the next message started a new conversation on the server. The page's
 * "follow the URL" effect then fought its "keep the URL in step" effect, and
 * the view flickered between the two before settling on the wrong one.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider } from "../components/ChatContext";
import { ToastProvider } from "../components/Toast";
import { Chat } from "./Chat";

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
const keys: Record<string, string> = { "sess-1": "web:kitchen", "sess-p": "web:planner:100" };

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
        return new Response(JSON.stringify(history[m[1]] ?? []));
      }
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

  async function choose(agent: string) {
    const select = container.querySelector(".chat-agent-select") as HTMLSelectElement;
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
    // The reply is still coming into the conversation it was asked in.
    expect(shown()).toContain("Earlier answer");
    expect((container.querySelector(".chat-agent-select") as HTMLSelectElement).value).toBe("");
    await act(async () => release());
    await settle();
    expect(chatPosts.map((p) => p.sessionKey)).toEqual(["web:kitchen"]);
    expect(shown()).toContain("Alfama, near the river.");
    expect((container.querySelector(".chat-agent-select") as HTMLSelectElement).value).toBe("planner");
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
