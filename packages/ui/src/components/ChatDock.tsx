import { useEffect, useMemo, useRef, useState } from "react";
import { groupTurns } from "../chat-grouping";
import { useChatStore } from "./ChatContext";
import { MessageBubble } from "./MessageBubble";
import { SuggestionChips } from "./SuggestionChips";

type DockMode = "floating" | "docked-left" | "docked-right";

interface FloatingState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DockedState {
  /** Width as a percentage of the viewport (8 – 60). */
  widthPct: number;
}

const MODE_KEY = "tai.chat.dock.mode";
const FLOATING_KEY = "tai.chat.dock.floating";
const DOCKED_KEY = "tai.chat.dock.docked";

const DEFAULT_FLOATING: FloatingState = { x: 24, y: 24, width: 380, height: 520 };
const DEFAULT_DOCKED: DockedState = { widthPct: 30 };

const FLOATING_MIN = { width: 300, height: 320 };
const FLOATING_MAX = { width: 800, height: 800 };
const DOCKED_MIN_PCT = 18;
const DOCKED_MAX_PCT = 60;

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

function saveJSON<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage unavailable — ignore.
  }
}

function loadMode(): DockMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "floating" || v === "docked-left" || v === "docked-right") return v;
  } catch {
    // ignore
  }
  return "floating";
}

/**
 * Floating, app-shell-level chat surface. Lives on top of every page so a
 * conversation persists across navigation and approvals/agent activity are
 * never out of sight.
 *
 * Three modes:
 *  - "floating"     — draggable + resizable card, FAB when collapsed.
 *  - "docked-left"  — full-height panel on the left; pushes content right.
 *  - "docked-right" — full-height panel on the right; pushes content left.
 *
 * For fullscreen, the user is sent to `#/chat`, which renders the same
 * shared ChatStore. The dock auto-hides while on that route.
 */
export function ChatDock() {
  const store = useChatStore();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DockMode>(loadMode);
  const [floating, setFloating] = useState<FloatingState>(() => loadJSON(FLOATING_KEY, DEFAULT_FLOATING));
  const [docked, setDocked] = useState<DockedState>(() => loadJSON(DOCKED_KEY, DEFAULT_DOCKED));
  const [input, setInput] = useState("");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Hidden only on the full Chat page, which already hosts the shared
  // conversation. Everywhere else (including Home) the dock is available.
  const onChatPage = hash.startsWith("#/chat");

  // Persist mode + sizes whenever they change.
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode]);
  useEffect(() => {
    saveJSON(FLOATING_KEY, floating);
  }, [floating]);
  useEffect(() => {
    saveJSON(DOCKED_KEY, docked);
  }, [docked]);

  // Apply body class + CSS var for docked layout so the rest of the app
  // reflows. Cleared when closed, on /chat, or in floating mode.
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    body.classList.remove("chat-dock-docked-left", "chat-dock-docked-right");
    if (!open || onChatPage || mode === "floating") {
      root.style.removeProperty("--chat-dock-width");
      return;
    }
    body.classList.add(`chat-dock-${mode}`);
    root.style.setProperty("--chat-dock-width", `${docked.widthPct}vw`);
    return () => {
      body.classList.remove("chat-dock-docked-left", "chat-dock-docked-right");
      root.style.removeProperty("--chat-dock-width");
    };
  }, [open, onChatPage, mode, docked.widthPct]);

  // Esc collapses the dock (unless sending — interrupt is the meaningful action
  // there). Cmd-K is owned by the global command palette now, not the dock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open && !store.sending) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, store.sending]);

  // Respond to requestDock(): open the floating dock and prefill (not send) the
  // composer. Switches out of any docked mode so the prompt is always visible.
  const lastDockNonce = useRef(0);
  useEffect(() => {
    const sig = store.dockSignal;
    if (!sig || sig.nonce === lastDockNonce.current) return;
    lastDockNonce.current = sig.nonce;
    if (onChatPage) return; // the full Chat page owns the conversation
    setMode((m) => (m === "floating" ? m : "floating"));
    setOpen(true);
    if (sig.text) setInput(sig.text);
    // Focus after the panel mounts.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [store.dockSignal, onChatPage]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const displayMessages = useMemo(
    () =>
      groupTurns(store.messages)
        .filter((m) => m.role !== "system")
        .slice(-12),
    [store.messages],
  );

  const pendingApprovals = store.approvals.length;

  // Drag (floating mode only) ------------------------------------------------
  const dragRef = useRef<{ originX: number; originY: number; startX: number; startY: number } | null>(null);
  function onHeaderMouseDown(e: React.MouseEvent) {
    if (mode !== "floating") return;
    if ((e.target as HTMLElement).closest("button,select,a,input")) return;
    dragRef.current = {
      originX: e.clientX,
      originY: e.clientY,
      startX: floating.x,
      startY: floating.y,
    };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.originX;
      const dy = ev.clientY - dragRef.current.originY;
      setFloating((prev) => ({
        ...prev,
        x: clamp(dragRef.current!.startX + dx, 0, window.innerWidth - prev.width),
        y: clamp(dragRef.current!.startY + dy, 0, window.innerHeight - 40),
      }));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Resize ------------------------------------------------------------------
  function onResizeStart(direction: "se" | "edge") {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = mode === "floating" ? floating.width : (docked.widthPct / 100) * window.innerWidth;
      const startY = e.clientY;
      const startH = floating.height;
      const onMove = (ev: MouseEvent) => {
        if (mode === "floating") {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          setFloating((prev) => ({
            ...prev,
            width: clamp(startW + dx, FLOATING_MIN.width, FLOATING_MAX.width),
            height: clamp(startH + dy, FLOATING_MIN.height, FLOATING_MAX.height),
          }));
        } else {
          // Docked: dragging "inward" on left dock increases width, dragging
          // "inward" on right dock also increases width — invert dx for right.
          const raw = mode === "docked-left" ? ev.clientX - startX : startX - ev.clientX;
          const nextPx = clamp(
            startW + raw,
            (DOCKED_MIN_PCT / 100) * window.innerWidth,
            (DOCKED_MAX_PCT / 100) * window.innerWidth,
          );
          setDocked({ widthPct: clamp((nextPx / window.innerWidth) * 100, DOCKED_MIN_PCT, DOCKED_MAX_PCT) });
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      void direction;
    };
  }

  function handleSend() {
    const text = input.trim();
    if (!text || store.sending) return;
    setInput("");
    store.send(text);
  }

  function handleNewChat() {
    store.newChat();
    setInput("");
    inputRef.current?.focus();
  }

  if (onChatPage) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="chat-dock-fab"
        onClick={() => setOpen(true)}
        title="Open chat"
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
    );
  }

  const agentNames = Object.keys(store.agents);

  const containerStyle: React.CSSProperties =
    mode === "floating"
      ? {
          left: floating.x,
          top: floating.y,
          width: floating.width,
          height: floating.height,
        }
      : mode === "docked-left"
        ? { left: 0, top: 0, bottom: 0, width: `${docked.widthPct}vw` }
        : { right: 0, top: 0, bottom: 0, width: `${docked.widthPct}vw` };

  return (
    <div className={`chat-dock chat-dock-mode-${mode}`} style={containerStyle} role="dialog" aria-label="Chat dock">
      <div
        className={`chat-dock-header${mode === "floating" ? " chat-dock-header-draggable" : ""}`}
        onMouseDown={onHeaderMouseDown}
      >
        <div className="chat-dock-header-left">
          <span className="chat-dock-title">Chat</span>
          {agentNames.length > 0 && (
            <select
              className="chat-dock-agent-select"
              value={store.selectedAgent}
              onChange={(e) => store.setSelectedAgent(e.target.value)}
              aria-label="Agent"
              title="Choose agent"
            >
              <option value="">Default</option>
              {agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {store.sessionId && (
            <span className="chat-dock-session" title={store.sessionId}>
              {store.sessionId.slice(0, 8)}
            </span>
          )}
        </div>
        <div className="chat-dock-header-actions">
          <button
            type="button"
            className="chat-dock-header-btn"
            onClick={handleNewChat}
            title="New chat"
            aria-label="New chat"
          >
            +
          </button>
          <div className="chat-dock-mode-switcher" role="group" aria-label="Dock mode">
            <button
              type="button"
              className={`chat-dock-mode-btn${mode === "docked-left" ? " active" : ""}`}
              onClick={() => setMode("docked-left")}
              title="Dock to left"
              aria-label="Dock to left"
            >
              ◧
            </button>
            <button
              type="button"
              className={`chat-dock-mode-btn${mode === "floating" ? " active" : ""}`}
              onClick={() => setMode("floating")}
              title="Float"
              aria-label="Floating mode"
            >
              ◇
            </button>
            <button
              type="button"
              className={`chat-dock-mode-btn${mode === "docked-right" ? " active" : ""}`}
              onClick={() => setMode("docked-right")}
              title="Dock to right"
              aria-label="Dock to right"
            >
              ◨
            </button>
            <a
              href="#/chat"
              className="chat-dock-mode-btn chat-dock-mode-link"
              title="Open full chat"
              aria-label="Open full chat"
            >
              ⤢
            </a>
          </div>
          <button
            type="button"
            className="chat-dock-close"
            onClick={() => setOpen(false)}
            aria-label="Close chat dock"
            title="Close"
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
            <SuggestionChips onPick={(text) => store.send(text)} />
            <div className="chat-empty-text">Ask the agent something.</div>
          </div>
        )}
        {displayMessages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        {store.sending && (
          <div className="tool-activity tool-activity-dock">
            <div className="spinner" />
            <span>
              {store.activeTool ? `Calling ${store.activeTool}…` : (store.activityDesc ?? "Thinking…")}
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
      {mode === "floating" && (
        <div className="chat-dock-resize chat-dock-resize-se" onMouseDown={onResizeStart("se")} aria-hidden="true" />
      )}
      {(mode === "docked-left" || mode === "docked-right") && (
        <div
          className={`chat-dock-resize chat-dock-resize-edge chat-dock-resize-edge-${
            mode === "docked-left" ? "right" : "left"
          }`}
          onMouseDown={onResizeStart("edge")}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
