import { useEffect, useMemo, useState } from "react";
import { fetchMessages, type SessionRow, setStoredChatSessionId } from "../api";
import { groupTurns } from "../chat-grouping";
import { useChatStore } from "../components/ChatContext";
import { MessageBubble, ToolLogPanel } from "../components/MessageBubble";
import { VoiceInputButton } from "../components/VoiceInputButton";
import { useActiveProject } from "../hooks/useActiveProject";

export function Chat(props: { sessionKey?: string; sessionId?: string }) {
  const store = useChatStore();
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const _activeProject = useActiveProject();

  // Honor an explicit ?session=… route param by loading that session into
  // the shared store. Without this, deep links would no-op on a cold load
  // because the provider already restored its own last-active session.
  useEffect(() => {
    if (!props.sessionId) return;
    if (props.sessionId === store.sessionId) return;
    setStoredChatSessionId(props.sessionId);
    fetchMessages(props.sessionId)
      .then((msgs) => {
        // Touch the store via loadSession analogue: cheapest path is to
        // mimic by calling the store's own loadSession with a minimal row.
        store.loadSession({
          id: props.sessionId!,
          key: props.sessionKey ?? null,
          model: "",
          provider: "",
          project_id: null,
          title: null,
          pinned: 0,
          created_at: "",
          updated_at: "",
        });
        // loadSession will re-fetch the messages itself; the msgs above are
        // discarded but the fetch warmed the cache.
        void msgs;
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.sessionId,
    props.sessionKey, // Touch the store via loadSession analogue: cheapest path is to
    // mimic by calling the store's own loadSession with a minimal row.
    store,
  ]);

  // Load sessions list when sidebar opens or project filter changes.
  useEffect(() => {
    if (sidebarOpen) store.refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen, store]);

  // Escape interrupts an in-flight turn (page-only — dock has its own Esc behavior).
  useEffect(() => {
    if (!store.sending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        store.interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store.sending, store]);

  const displayMessages = useMemo(
    () => groupTurns(store.messages).filter((m) => m.role !== "system"),
    [store.messages],
  );

  const agentNames = Object.keys(store.agents);

  function handleSend() {
    const text = input.trim();
    if (!text || store.sending) return;
    setInput("");
    store.send(text);
  }

  function handleNewChat() {
    store.newChat();
    window.location.hash = "/chat";
  }

  function handleLoadSession(s: SessionRow) {
    store.loadSession(s);
    setSidebarOpen(false);
    const params = new URLSearchParams();
    if (s.key) params.set("key", s.key);
    params.set("session", s.id);
    window.location.hash = `/chat?${params}`;
  }

  function handleRename(s: SessionRow) {
    const current = s.title ?? "";
    const next = window.prompt("Rename session", current);
    if (next === null) return;
    store.renameSession(s, next.trim() || null);
  }

  function handleDeleteSession(s: SessionRow) {
    if (!window.confirm(`Delete session "${s.title ?? s.key ?? s.id.slice(0, 8)}"?`)) return;
    store.removeSession(s);
  }

  // Reflect store session changes in the URL hash so reload preserves the
  // location and so route prop drives the canonical state.
  useEffect(() => {
    if (!store.sessionId) return;
    const params = new URLSearchParams();
    if (store.sessionKey) params.set("key", store.sessionKey);
    params.set("session", store.sessionId);
    const next = `/chat?${params}`;
    if (window.location.hash.slice(1) !== next) {
      window.location.hash = next;
    }
  }, [store.sessionId, store.sessionKey]);

  return (
    <div className="chat-layout">
      {sidebarOpen && (
        <div className="chat-sidebar" aria-label="Session list">
          <div className="chat-sidebar-header">
            <span>Sessions</span>
            <button
              type="button"
              className="chat-sidebar-close"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close session sidebar"
            >
              x
            </button>
          </div>
          <div className="chat-sidebar-search">
            <input
              type="search"
              placeholder="Search sessions"
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              aria-label="Search sessions"
            />
          </div>
          <div className="chat-sidebar-list">
            {store.sessions.length === 0 && <div className="chat-sidebar-empty">No sessions yet</div>}
            {(() => {
              const q = sidebarSearch.trim().toLowerCase();
              const filtered = q
                ? store.sessions.filter((s) => `${s.title ?? ""} ${s.key ?? ""} ${s.id}`.toLowerCase().includes(q))
                : store.sessions;
              const pinned = filtered.filter((s) => s.pinned);
              const recent = filtered.filter((s) => !s.pinned);
              return (
                <>
                  {pinned.length > 0 && <div className="chat-sidebar-section-label">Pinned</div>}
                  {pinned.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      active={s.id === store.sessionId}
                      onLoad={handleLoadSession}
                      onRename={handleRename}
                      onTogglePin={(s2) => store.togglePin(s2)}
                      onDelete={handleDeleteSession}
                    />
                  ))}
                  {pinned.length > 0 && recent.length > 0 && <div className="chat-sidebar-section-label">Recent</div>}
                  {recent.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      active={s.id === store.sessionId}
                      onLoad={handleLoadSession}
                      onRename={handleRename}
                      onTogglePin={(s2) => store.togglePin(s2)}
                      onDelete={handleDeleteSession}
                    />
                  ))}
                </>
              );
            })()}
          </div>
        </div>
      )}

      <div className="chat">
        <div className="chat-toolbar">
          <button
            type="button"
            className="chat-toolbar-btn"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="Toggle sessions"
          >
            Sessions
          </button>
          <button type="button" className="chat-toolbar-btn chat-new-btn" onClick={handleNewChat}>
            + New Chat
          </button>
          {agentNames.length > 0 && (
            <select
              className="chat-agent-select"
              value={store.selectedAgent}
              onChange={(e) => store.setSelectedAgent(e.target.value)}
              aria-label="Choose agent"
            >
              <option value="">Default agent</option>
              {agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {store.sessionKey && <span className="chat-session-label">Session: {store.sessionKey}</span>}
        </div>

        <div className="chat-messages">
          {store.messages.length === 0 && !store.sending && (
            <div className="chat-empty-state">
              Send a message to start a conversation
              {store.selectedAgent ? ` with the "${store.selectedAgent}" agent` : ""}.
            </div>
          )}
          {displayMessages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
          {store.sending &&
            (store.pendingTools.length > 0 ? (
              <ToolLogPanel entries={store.pendingTools} live elapsed={store.elapsed} />
            ) : (
              <div className="tool-activity">
                <div className="spinner" />
                <span>
                  {store.activeTool ? `Calling ${store.activeTool}…` : (store.activityDesc ?? "Thinking…")}
                  {store.elapsed > 0 ? ` · ${store.elapsed}s` : ""}
                </span>
              </div>
            ))}
          {store.approvals.length > 0 && (
            <ApprovalPanel
              approvals={store.approvals}
              onApprove={store.approve}
              onReject={store.reject}
              onApproveAll={store.approveAll}
              onRejectAll={store.rejectAll}
            />
          )}
        </div>
        <div className="chat-input-bar">
          <input
            type="text"
            placeholder="Type a message..."
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
          <VoiceInputButton
            disabled={store.sending}
            onTranscript={(text) => setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))}
          />
          {store.sending ? (
            <button type="button" onClick={store.interrupt} className="chat-stop-btn" title="Stop generating">
              Stop
            </button>
          ) : (
            <button type="button" onClick={handleSend} disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionItem(props: {
  session: SessionRow;
  active: boolean;
  onLoad: (s: SessionRow) => void;
  onRename: (s: SessionRow) => void;
  onTogglePin: (s: SessionRow) => void;
  onDelete: (s: SessionRow) => void;
}) {
  const { session: s, active, onLoad, onRename, onTogglePin, onDelete } = props;
  const label = s.title ?? s.key ?? s.id.slice(0, 8);
  return (
    <div className={`chat-sidebar-item${active ? " active" : ""}`}>
      <button
        type="button"
        className="chat-sidebar-item-main"
        onClick={() => onLoad(s)}
        aria-label={`Load session ${label}`}
      >
        <div className="chat-sidebar-item-key">{label}</div>
        <div className="chat-sidebar-item-meta">
          {s.provider}/{s.model} · {formatTime(s.updated_at)}
        </div>
      </button>
      <div className="chat-sidebar-item-actions">
        <button
          type="button"
          className="chat-sidebar-item-action"
          onClick={() => onTogglePin(s)}
          title={s.pinned ? "Unpin" : "Pin"}
          aria-label={s.pinned ? "Unpin session" : "Pin session"}
        >
          {s.pinned ? "★" : "☆"}
        </button>
        <button
          type="button"
          className="chat-sidebar-item-action"
          onClick={() => onRename(s)}
          title="Rename"
          aria-label="Rename session"
        >
          ✎
        </button>
        <button
          type="button"
          className="chat-sidebar-item-action"
          onClick={() => onDelete(s)}
          title="Delete"
          aria-label="Delete session"
        >
          ×
        </button>
      </div>
    </div>
  );
}

interface PendingApprovalShape {
  requestId: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  description?: string;
}

function ApprovalPanel(props: {
  approvals: PendingApprovalShape[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
}) {
  const { approvals, onApprove, onReject, onApproveAll, onRejectAll } = props;
  return (
    <div className="chat-approvals">
      <div className="chat-approvals-header">
        <span>
          {approvals.length} tool call{approvals.length === 1 ? "" : "s"} need approval
        </span>
        {approvals.length > 1 && (
          <div className="chat-approvals-bulk">
            <button type="button" className="chat-approve-btn" onClick={onApproveAll}>
              Approve all
            </button>
            <button type="button" className="chat-reject-btn" onClick={onRejectAll}>
              Reject all
            </button>
          </div>
        )}
      </div>
      <div className="chat-approvals-list">
        {approvals.map((a) => (
          <div key={a.requestId} className="chat-approval-item">
            <div className="chat-approval-info">
              <div className="chat-approval-tool">{a.toolName}</div>
              {a.description && <div className="chat-approval-desc">{a.description}</div>}
              {a.toolArgs && <ApprovalArgs args={a.toolArgs} />}
            </div>
            <div className="chat-approval-actions">
              <button type="button" className="chat-approve-btn" onClick={() => onApprove(a.requestId)}>
                Approve
              </button>
              <button type="button" className="chat-reject-btn" onClick={() => onReject(a.requestId)}>
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One arg value rendered compactly — strings inline, objects stringified. */
function formatArgValue(v: unknown): { display: string; truncated: boolean } {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  if (s.length > 140) return { display: `${s.slice(0, 140)}…`, truncated: true };
  return { display: s, truncated: false };
}

/** Compact key: value list for a tool-call's args, with raw JSON on demand. */
function ApprovalArgs({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args);
  if (entries.length === 0) return null;
  let raw: string;
  try {
    raw = JSON.stringify(args, null, 2);
  } catch {
    raw = String(args);
  }
  const anyTruncated = entries.some(([, v]) => formatArgValue(v).truncated);
  return (
    <div className="chat-approval-args">
      <dl className="chat-approval-arg-list">
        {entries.map(([k, v]) => (
          <div key={k} className="chat-approval-arg">
            <dt>{k}</dt>
            <dd>{formatArgValue(v).display}</dd>
          </div>
        ))}
      </dl>
      {(anyTruncated || entries.length > 1) && (
        <details className="chat-approval-raw">
          <summary>Raw JSON</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
