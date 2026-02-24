import { useEffect, useRef, useState } from "react";
import {
  type AgentInfo,
  type ChatEvent,
  fetchAgents,
  fetchMessages,
  fetchSessions,
  type Message,
  sendChat,
  type SessionRow,
} from "../api";
import { MessageBubble } from "../components/MessageBubble";

export function Chat(props: { sessionKey?: string; sessionId?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [activityDesc, setActivityDesc] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(props.sessionKey);
  const [sessionId, setSessionId] = useState(props.sessionId);
  const messagesEnd = useRef<HTMLDivElement>(null);

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

  // Load sessions when sidebar opens
  useEffect(() => {
    if (sidebarOpen) {
      fetchSessions().then(setSessions).catch(() => {});
    }
  }, [sidebarOpen]);

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
    setMessages((prev) => [...prev, { role: "user", content: text }]);

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
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: null,
                toolCalls: [
                  {
                    id: `tc-${Date.now()}`,
                    name: event.data.name as string,
                    arguments: event.data.args as Record<string, unknown>,
                  },
                ],
              },
            ]);
            break;
          case "tool_result":
            setActiveTool(null);
            setMessages((prev) => [
              ...prev,
              {
                role: "tool",
                content: event.data.output as string,
                toolCallId: `tc-${event.data.name}`,
              },
            ]);
            break;
          case "response":
            setActiveTool(null);
            setActivityDesc(null);
            setSending(false);
            setSessionKey(event.data.sessionKey as string);
            setSessionId(event.data.sessionId as string);
            setMessages((prev) => [...prev, { role: "assistant", content: event.data.content as string }]);
            if (event.data.sessionKey) {
              window.location.hash = `/chat?key=${encodeURIComponent(event.data.sessionKey as string)}&session=${encodeURIComponent(event.data.sessionId as string)}`;
            }
            break;
          case "error":
            setActiveTool(null);
            setActivityDesc(null);
            setSending(false);
            setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${event.data.message}` }]);
            break;
        }
      },
      selectedAgent || undefined,
    );
  }

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
          {messages
            .filter((m) => m.role !== "system")
            .map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
          {sending && (activityDesc || activeTool) && (
            <div className="tool-activity">
              <div className="spinner" />
              {activityDesc ?? (activeTool ? `Calling ${activeTool}…` : "Thinking…")}
            </div>
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
