import { useEffect, useMemo, useRef, useState } from "react";
import { groupTurns } from "../chat-grouping";
import { useChatStore } from "./ChatContext";
import { MessageBubble } from "./MessageBubble";

/**
 * Floating, app-shell-level chat surface. Lives on top of every page so a
 * conversation persists across navigation and approvals/agent activity are
 * never out of sight. Pairs with the full /chat page, which renders the
 * same underlying ChatStore.
 */
export function ChatDock() {
  const store = useChatStore();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl-K toggles the dock from anywhere. Esc collapses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open && !store.sending) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, store.sending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [store.messages, open]);

  // If we're on the /chat page we hide the dock — the full page already shows
  // the same conversation.
  const onChatPage = window.location.hash.startsWith("#/chat");

  const displayMessages = useMemo(
    () => groupTurns(store.messages).filter((m) => m.role !== "system").slice(-8),
    [store.messages],
  );

  const pendingApprovals = store.approvals.length;

  if (onChatPage) return null;

  function handleSend() {
    const text = input.trim();
    if (!text || store.sending) return;
    setInput("");
    store.send(text);
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          className="chat-dock-fab"
          onClick={() => setOpen(true)}
          title="Open chat (Cmd-K)"
          aria-label="Open chat"
        >
          <span>Chat</span>
          {store.sending && <span className="chat-dock-fab-pulse" />}
          {pendingApprovals > 0 && (
            <span className="chat-dock-fab-badge" aria-label={`${pendingApprovals} pending approvals`}>
              {pendingApprovals}
            </span>
          )}
        </button>
      )}
      {open && (
        <div className="chat-dock" role="dialog" aria-label="Chat dock">
          <div className="chat-dock-header">
            <span className="chat-dock-title">
              {store.selectedAgent ? store.selectedAgent : "Chat"}
              {store.sessionId && <span className="chat-dock-session"> · {store.sessionId.slice(0, 8)}</span>}
            </span>
            <div className="chat-dock-header-actions">
              <a href="#/chat" className="chat-dock-expand" title="Open full chat" aria-label="Open full chat">
                ⤢
              </a>
              <button
                type="button"
                className="chat-dock-close"
                onClick={() => setOpen(false)}
                aria-label="Close chat dock"
              >
                ×
              </button>
            </div>
          </div>
          {pendingApprovals > 0 && (
            <div className="chat-dock-approvals">
              <span>
                {pendingApprovals} tool call{pendingApprovals === 1 ? "" : "s"} need approval —{" "}
                <a href="#/chat">open full chat</a>
              </span>
            </div>
          )}
          <div className="chat-dock-messages">
            {displayMessages.length === 0 && !store.sending && (
              <div className="chat-dock-empty">
                Ask the agent something. Cmd-K to toggle this dock.
              </div>
            )}
            {displayMessages.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
            {store.sending && (
              <div className="tool-activity tool-activity-dock">
                <div className="spinner" />
                <span>
                  {store.activeTool
                    ? `Calling ${store.activeTool}…`
                    : (store.activityDesc ?? "Thinking…")}
                  {store.elapsed > 0 ? ` · ${store.elapsed}s` : ""}
                </span>
              </div>
            )}
            <div ref={messagesEnd} />
          </div>
          <div className="chat-dock-composer">
            <input
              ref={inputRef}
              type="text"
              placeholder="Message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={store.sending}
              aria-label="Compose message"
            />
            {store.sending ? (
              <button type="button" onClick={store.interrupt} className="chat-stop-btn">
                Stop
              </button>
            ) : (
              <button type="button" onClick={handleSend} disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
