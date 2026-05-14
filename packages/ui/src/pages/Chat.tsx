import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentInfo,
  type ChatEvent,
  deleteSession,
  fetchAgents,
  fetchMessages,
  fetchSessions,
  getStoredChatSessionId,
  type Message,
  resolveApproval,
  sendChat,
  type SessionRow,
  setStoredChatSessionId,
  type ToolLogEntry,
  updateSession,
} from "../api";

interface PendingApproval {
  requestId: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  description?: string;
}
import { MessageBubble, ToolLogPanel } from "../components/MessageBubble";
import { VoiceInputButton } from "../components/VoiceInputButton";
import { useActiveProject } from "../hooks/useActiveProject";
import { groupTurns } from "../chat-grouping";

export function Chat(props: { sessionKey?: string; sessionId?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [activityDesc, setActivityDesc] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(props.sessionKey);
  const [sessionId, setSessionId] = useState(props.sessionId);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Tool calls/results captured during the current streaming turn. Lives in
  // state (not a ref) so the live in-progress panel re-renders as entries
  // arrive. On final response, this becomes the carrier's collapsed toolLog.
  const [pendingTools, setPendingTools] = useState<ToolLogEntry[]>([]);
  // Track turn start so the live panel can show "Working for Xs".
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);
  // Pending approval requests for the current in-flight turn. The chat SSE
  // stream emits approval_request events for tools gated by permissions —
  // without this UI the agent would silently wait the timeoutMs (default 5min).
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  // Agent selector
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [selectedAgent, setSelectedAgent] = useState<string>("");

  // Session sidebar
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");

  // Load agents on mount
  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  const activeProject = useActiveProject();

  // Load sessions when sidebar opens or project filter changes
  useEffect(() => {
    if (sidebarOpen) {
      fetchSessions().then(setSessions).catch(() => {});
    }
  }, [sidebarOpen, activeProject]);

  // Load messages for initial session — explicit prop wins, otherwise restore
  // last-active session from localStorage so revisiting /chat resumes where we
  // left off instead of starting a brand-new conversation.
  useEffect(() => {
    if (props.sessionId) {
      setSessionId(props.sessionId);
      setStoredChatSessionId(props.sessionId);
      fetchMessages(props.sessionId)
        .then(setMessages)
        .catch(() => {});
      return;
    }
    const stored = getStoredChatSessionId();
    if (stored) {
      fetchMessages(stored)
        .then((msgs) => {
          setSessionId(stored);
          setMessages(msgs);
        })
        .catch(() => {
          // Stored id is stale (db reset, etc.) — drop it.
          setStoredChatSessionId(null);
        });
    }
  }, [props.sessionId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Escape interrupts an in-flight turn.
  useEffect(() => {
    if (!sending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleInterrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending]);

  // Tick elapsed seconds while a turn is in flight.
  useEffect(() => {
    if (turnStart === null) return;
    setElapsed(Math.floor((Date.now() - turnStart) / 1000));
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - turnStart) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [turnStart]);

  function handleNewChat() {
    setMessages([]);
    setSessionKey(undefined);
    setSessionId(undefined);
    setStoredChatSessionId(null);
    window.location.hash = "/chat";
  }

  function handleLoadSession(s: SessionRow) {
    setSessionId(s.id);
    setSessionKey(s.key ?? undefined);
    setStoredChatSessionId(s.id);
    setSidebarOpen(false);
    setMessages([]);
    fetchMessages(s.id).then(setMessages).catch(() => {});
    const params = new URLSearchParams();
    if (s.key) params.set("key", s.key);
    params.set("session", s.id);
    window.location.hash = `/chat?${params}`;
  }

  function handleRename(s: SessionRow) {
    const current = s.title ?? "";
    const next = window.prompt("Rename session", current);
    if (next === null) return;
    const title = next.trim() || null;
    updateSession(s.id, { title })
      .then((updated) =>
        setSessions((prev) => prev.map((row) => (row.id === updated.id ? updated : row))),
      )
      .catch((err) => alert(`Rename failed: ${(err as Error).message}`));
  }

  function handleTogglePin(s: SessionRow) {
    const pinned = !s.pinned;
    updateSession(s.id, { pinned })
      .then((updated) =>
        setSessions((prev) =>
          [...prev.map((row) => (row.id === updated.id ? updated : row))].sort(
            (a, b) =>
              (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
              b.updated_at.localeCompare(a.updated_at),
          ),
        ),
      )
      .catch((err) => alert(`Pin failed: ${(err as Error).message}`));
  }

  function handleDeleteSession(s: SessionRow) {
    if (!window.confirm(`Delete session "${s.title ?? s.key ?? s.id.slice(0, 8)}"?`)) return;
    deleteSession(s.id)
      .then(() => {
        setSessions((prev) => prev.filter((row) => row.id !== s.id));
        if (sessionId === s.id) {
          setMessages([]);
          setSessionId(undefined);
          setSessionKey(undefined);
          setStoredChatSessionId(null);
        }
      })
      .catch((err) => alert(`Delete failed: ${(err as Error).message}`));
  }

  function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    setSending(true);
    setPendingTools([]);
    setApprovals([]);
    setTurnStart(Date.now());
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    let finalTools: ToolLogEntry[] = [];

    abortRef.current = sendChat(
      text,
      sessionKey,
      (event: ChatEvent) => {
        switch (event.type) {
          case "activity":
            setActivityDesc((event.data.description as string | null | undefined) ?? null);
            break;
          case "approval_request": {
            const req: PendingApproval = {
              requestId: event.data.requestId as string,
              toolName: event.data.toolName as string,
              toolArgs: event.data.toolArgs as Record<string, unknown> | undefined,
              description: event.data.description as string | undefined,
            };
            setApprovals((prev) =>
              prev.some((a) => a.requestId === req.requestId) ? prev : [...prev, req],
            );
            break;
          }
          case "tool_call":
            setActiveTool(event.data.name as string);
            setPendingTools((prev) => [
              ...prev,
              {
                kind: "tool",
                id: `tc-${Date.now()}-${prev.length}`,
                name: event.data.name as string,
                args: event.data.args as Record<string, unknown>,
              },
            ]);
            break;
          case "tool_result": {
            setActiveTool(null);
            const output = event.data.output as string;
            setPendingTools((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                const e = next[i];
                if (e.kind !== "text" && e.output === undefined) {
                  next[i] = { ...e, output };
                  break;
                }
              }
              finalTools = next;
              return next;
            });
            break;
          }
          case "response": {
            setActiveTool(null);
            setActivityDesc(null);
            setSending(false);
            setTurnStart(null);
            setApprovals([]);
            abortRef.current = null;
            setSessionKey(event.data.sessionKey as string);
            setSessionId(event.data.sessionId as string);
            setStoredChatSessionId(event.data.sessionId as string);
            // Use finalTools (captured by tool_result handlers) since pending
            // state may not have flushed by the time this fires.
            setPendingTools((prev) => {
              finalTools = prev;
              return [];
            });
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: event.data.content as string,
                toolLog: finalTools.length > 0 ? finalTools : undefined,
              },
            ]);
            if (event.data.sessionKey) {
              window.location.hash = `/chat?key=${encodeURIComponent(event.data.sessionKey as string)}&session=${encodeURIComponent(event.data.sessionId as string)}`;
            }
            break;
          }
          case "error": {
            setActiveTool(null);
            setActivityDesc(null);
            setSending(false);
            setTurnStart(null);
            setApprovals([]);
            abortRef.current = null;
            setPendingTools((prev) => {
              finalTools = prev;
              return [];
            });
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: `Error: ${event.data.message}`,
                toolLog: finalTools.length > 0 ? finalTools : undefined,
              },
            ]);
            break;
          }
        }
      },
      selectedAgent || undefined,
    );
  }

  function handleInterrupt() {
    if (!sending) return;
    // Reject any pending approvals so the server unblocks before we abort the
    // request — otherwise rejectAll on stream close races with the abort.
    for (const a of approvals) {
      resolveApproval(a.requestId, false, "interrupted by user").catch(() => {});
    }
    setApprovals([]);
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveTool(null);
    setActivityDesc(null);
    setSending(false);
    setTurnStart(null);
    const tools = pendingTools;
    setPendingTools([]);
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: "[Interrupted]",
        toolLog: tools.length > 0 ? tools : undefined,
      },
    ]);
  }

  function handleApprove(requestId: string) {
    setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    resolveApproval(requestId, true).catch(() => {});
  }

  function handleReject(requestId: string) {
    setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    resolveApproval(requestId, false, "rejected by user").catch(() => {});
  }

  function handleApproveAll() {
    const ids = approvals.map((a) => a.requestId);
    setApprovals([]);
    for (const id of ids) {
      resolveApproval(id, true).catch(() => {});
    }
  }

  function handleRejectAll() {
    const ids = approvals.map((a) => a.requestId);
    setApprovals([]);
    for (const id of ids) {
      resolveApproval(id, false, "rejected by user").catch(() => {});
    }
  }

  const displayMessages = useMemo(
    () => groupTurns(messages).filter((m) => m.role !== "system"),
    [messages],
  );

  const agentNames = Object.keys(agents);

  return (
    <div className="chat-layout">
      {/* Session sidebar */}
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
            {sessions.length === 0 && <div className="chat-sidebar-empty">No sessions yet</div>}
            {(() => {
              const q = sidebarSearch.trim().toLowerCase();
              const filtered = q
                ? sessions.filter((s) =>
                    `${s.title ?? ""} ${s.key ?? ""} ${s.id}`.toLowerCase().includes(q),
                  )
                : sessions;
              const pinned = filtered.filter((s) => s.pinned);
              const recent = filtered.filter((s) => !s.pinned);
              return (
                <>
                  {pinned.length > 0 && (
                    <div className="chat-sidebar-section-label">Pinned</div>
                  )}
                  {pinned.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      active={s.id === sessionId}
                      onLoad={handleLoadSession}
                      onRename={handleRename}
                      onTogglePin={handleTogglePin}
                      onDelete={handleDeleteSession}
                    />
                  ))}
                  {pinned.length > 0 && recent.length > 0 && (
                    <div className="chat-sidebar-section-label">Recent</div>
                  )}
                  {recent.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      active={s.id === sessionId}
                      onLoad={handleLoadSession}
                      onRename={handleRename}
                      onTogglePin={handleTogglePin}
                      onDelete={handleDeleteSession}
                    />
                  ))}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className="chat">
        {/* Chat toolbar */}
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
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
            >
              <option value="">Default agent</option>
              {agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {sessionKey && <span className="chat-session-label">Session: {sessionKey}</span>}
        </div>

        <div className="chat-messages">
          {messages.length === 0 && !sending && (
            <div className="chat-empty-state">
              Send a message to start a conversation
              {selectedAgent ? ` with the "${selectedAgent}" agent` : ""}.
            </div>
          )}
          {displayMessages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
          {sending && (
            pendingTools.length > 0 ? (
              <ToolLogPanel entries={pendingTools} live elapsed={elapsed} />
            ) : (
              <div className="tool-activity">
                <div className="spinner" />
                <span>
                  {activeTool ? `Calling ${activeTool}…` : (activityDesc ?? "Thinking…")}
                  {elapsed > 0 ? ` · ${elapsed}s` : ""}
                </span>
              </div>
            )
          )}
          {approvals.length > 0 && (
            <ApprovalPanel
              approvals={approvals}
              onApprove={handleApprove}
              onReject={handleReject}
              onApproveAll={handleApproveAll}
              onRejectAll={handleRejectAll}
            />
          )}
          <div ref={messagesEnd} />
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
            disabled={sending}
          />
          <VoiceInputButton
            disabled={sending}
            onTranscript={(text) =>
              setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
            }
          />
          {sending ? (
            <button
              type="button"
              onClick={handleInterrupt}
              className="chat-stop-btn"
              title="Stop generating"
            >
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

function ApprovalPanel(props: {
  approvals: PendingApproval[];
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
              {a.toolArgs && (
                <pre className="chat-approval-args">{formatArgs(a.toolArgs)}</pre>
              )}
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

function formatArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args, null, 2);
    return json.length > 600 ? `${json.slice(0, 600)}…` : json;
  } catch {
    return String(args);
  }
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
