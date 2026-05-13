import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentInfo,
  type ChatEvent,
  fetchAgents,
  fetchMessages,
  fetchSessions,
  type Message,
  sendChat,
  type SessionRow,
  type ToolLogEntry,
} from "../api";
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
  // Tool calls/results captured during the current streaming turn. Lives in
  // state (not a ref) so the live in-progress panel re-renders as entries
  // arrive. On final response, this becomes the carrier's collapsed toolLog.
  const [pendingTools, setPendingTools] = useState<ToolLogEntry[]>([]);
  // Track turn start so the live panel can show "Working for Xs".
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);

  // Agent selector
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [selectedAgent, setSelectedAgent] = useState<string>("");

  // Session sidebar
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  // Load messages for initial session
  useEffect(() => {
    if (props.sessionId) {
      fetchMessages(props.sessionId)
        .then(setMessages)
        .catch(() => {});
    }
  }, [props.sessionId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
    window.location.hash = "/chat";
  }

  function handleLoadSession(s: SessionRow) {
    setSessionId(s.id);
    setSessionKey(s.key ?? undefined);
    setSidebarOpen(false);
    setMessages([]);
    fetchMessages(s.id).then(setMessages).catch(() => {});
    const params = new URLSearchParams();
    if (s.key) params.set("key", s.key);
    params.set("session", s.id);
    window.location.hash = `/chat?${params}`;
  }

  function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    setSending(true);
    setPendingTools([]);
    setTurnStart(Date.now());
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    let finalTools: ToolLogEntry[] = [];

    sendChat(
      text,
      sessionKey,
      (event: ChatEvent) => {
        switch (event.type) {
          case "activity":
            setActivityDesc((event.data.description as string | null | undefined) ?? null);
            break;
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
            setSessionKey(event.data.sessionKey as string);
            setSessionId(event.data.sessionId as string);
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

  const displayMessages = useMemo(
    () => groupTurns(messages).filter((m) => m.role !== "system"),
    [messages],
  );

  const agentNames = Object.keys(agents);

  return (
    <div className="chat-layout">
      {/* Session sidebar */}
      {sidebarOpen && (
        <div className="chat-sidebar">
          <div className="chat-sidebar-header">
            <span>Sessions</span>
            <button type="button" className="chat-sidebar-close" onClick={() => setSidebarOpen(false)}>
              x
            </button>
          </div>
          <div className="chat-sidebar-list">
            {sessions.length === 0 && <div className="chat-sidebar-empty">No sessions yet</div>}
            {sessions.slice(0, 30).map((s) => (
              <button
                type="button"
                key={s.id}
                className={`chat-sidebar-item${s.id === sessionId ? " active" : ""}`}
                onClick={() => handleLoadSession(s)}
              >
                <div className="chat-sidebar-item-key">{s.key ?? s.id.slice(0, 8)}</div>
                <div className="chat-sidebar-item-meta">
                  {s.provider}/{s.model} · {formatTime(s.updated_at)}
                </div>
              </button>
            ))}
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
          <button type="button" onClick={handleSend} disabled={sending || !input.trim()}>
            {sending ? "..." : "Send"}
          </button>
        </div>
      </div>
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
