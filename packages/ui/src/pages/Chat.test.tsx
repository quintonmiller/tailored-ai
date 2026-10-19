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
const chatPosts: { sessionKey?: string; sessionId?: string }[] = [];
/** Whether the fake server continues a conversation named by id, as the real one does. */
let continuesById = true;
const messageFetches: string[] = [];
let sessionRows: unknown[] = [];
/** Pictures the fake turn's tools made, as the server sends them on the response event. */
let turnMedia: unknown[] = [];

const history: Record<string, unknown[]> = {
  "sess-1": [
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
  ],
};

/** The chat route's reply: it continues the conversation its key or id names, or starts a new one. */
function reply(sessionKey: string | undefined, sessionId: string | undefined): Response {
  const continued = sessionKey === "web:kitchen" || (continuesById && sessionId === "sess-1");
  const id = continued ? "sess-1" : "sess-new";
  const key = continued ? "web:kitchen" : "web:fresh";
  history[id] = [...(history[id] ?? []), { role: "user", content: "Hey!" }, { role: "assistant", content: "Hello!" }];
  const frames = [
    `event: delta\ndata: ${JSON.stringify({ text: "Hello!" })}\n\n`,
    `event: response\ndata: ${JSON.stringify({ content: "Hello!", sessionId: id, sessionKey: key, ...(turnMedia.length ? { media: turnMedia } : {}) })}\n\n`,
  ];
  return new Response(frames.join(""));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chatPosts.length = 0;
  messageFetches.length = 0;
  sessionRows = [];
  continuesById = true;
  turnMedia = [];
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
      if (url.startsWith("/api/agents")) return new Response("{}");
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
