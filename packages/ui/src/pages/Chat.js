import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { fetchAgents, fetchMessages, fetchSessions, sendChat, } from "../api";
import { MessageBubble } from "../components/MessageBubble";
export function Chat(props) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [activeTool, setActiveTool] = useState(null);
    const [activityDesc, setActivityDesc] = useState(null);
    const [sessionKey, setSessionKey] = useState(props.sessionKey);
    const [sessionId, setSessionId] = useState(props.sessionId);
    const messagesEnd = useRef(null);
    // Agent selector
    const [agents, setAgents] = useState({});
    const [selectedAgent, setSelectedAgent] = useState("");
    // Session sidebar
    const [sessions, setSessions] = useState([]);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    // Load agents on mount
    useEffect(() => {
        fetchAgents().then(setAgents).catch(() => { });
    }, []);
    // Load sessions when sidebar opens
    useEffect(() => {
        if (sidebarOpen) {
            fetchSessions().then(setSessions).catch(() => { });
        }
    }, [sidebarOpen]);
    // Load messages for initial session
    useEffect(() => {
        if (props.sessionId) {
            fetchMessages(props.sessionId)
                .then(setMessages)
                .catch(() => { });
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
    function handleLoadSession(s) {
        setSessionId(s.id);
        setSessionKey(s.key ?? undefined);
        setSidebarOpen(false);
        setMessages([]);
        fetchMessages(s.id).then(setMessages).catch(() => { });
        const params = new URLSearchParams();
        if (s.key)
            params.set("key", s.key);
        params.set("session", s.id);
        window.location.hash = `/chat?${params}`;
    }
    function handleSend() {
        const text = input.trim();
        if (!text || sending)
            return;
        setInput("");
        setSending(true);
        setMessages((prev) => [...prev, { role: "user", content: text }]);
        sendChat(text, sessionKey, (event) => {
            switch (event.type) {
                case "activity":
                    setActivityDesc(event.data.description ?? null);
                    break;
                case "tool_call":
                    setActiveTool(event.data.name);
                    setMessages((prev) => [
                        ...prev,
                        {
                            role: "assistant",
                            content: null,
                            toolCalls: [
                                {
                                    id: `tc-${Date.now()}`,
                                    name: event.data.name,
                                    arguments: event.data.args,
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
                            content: event.data.output,
                            toolCallId: `tc-${event.data.name}`,
                        },
                    ]);
                    break;
                case "response":
                    setActiveTool(null);
                    setActivityDesc(null);
                    setSending(false);
                    setSessionKey(event.data.sessionKey);
                    setSessionId(event.data.sessionId);
                    setMessages((prev) => [...prev, { role: "assistant", content: event.data.content }]);
                    if (event.data.sessionKey) {
                        window.location.hash = `/chat?key=${encodeURIComponent(event.data.sessionKey)}&session=${encodeURIComponent(event.data.sessionId)}`;
                    }
                    break;
                case "error":
                    setActiveTool(null);
                    setActivityDesc(null);
                    setSending(false);
                    setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${event.data.message}` }]);
                    break;
            }
        }, selectedAgent || undefined);
    }
    const agentNames = Object.keys(agents);
    return (_jsxs("div", { className: "chat-layout", children: [sidebarOpen && (_jsxs("div", { className: "chat-sidebar", children: [_jsxs("div", { className: "chat-sidebar-header", children: [_jsx("span", { children: "Sessions" }), _jsx("button", { type: "button", className: "chat-sidebar-close", onClick: () => setSidebarOpen(false), children: "x" })] }), _jsxs("div", { className: "chat-sidebar-list", children: [sessions.length === 0 && _jsx("div", { className: "chat-sidebar-empty", children: "No sessions yet" }), sessions.slice(0, 30).map((s) => (_jsxs("button", { type: "button", className: `chat-sidebar-item${s.id === sessionId ? " active" : ""}`, onClick: () => handleLoadSession(s), children: [_jsx("div", { className: "chat-sidebar-item-key", children: s.key ?? s.id.slice(0, 8) }), _jsxs("div", { className: "chat-sidebar-item-meta", children: [s.provider, "/", s.model, " \u00B7 ", formatTime(s.updated_at)] })] }, s.id)))] })] })), _jsxs("div", { className: "chat", children: [_jsxs("div", { className: "chat-toolbar", children: [_jsx("button", { type: "button", className: "chat-toolbar-btn", onClick: () => setSidebarOpen(!sidebarOpen), title: "Toggle sessions", children: "Sessions" }), _jsx("button", { type: "button", className: "chat-toolbar-btn chat-new-btn", onClick: handleNewChat, children: "+ New Chat" }), agentNames.length > 0 && (_jsxs("select", { className: "chat-agent-select", value: selectedAgent, onChange: (e) => setSelectedAgent(e.target.value), children: [_jsx("option", { value: "", children: "Default agent" }), agentNames.map((name) => (_jsx("option", { value: name, children: name }, name)))] })), sessionKey && _jsxs("span", { className: "chat-session-label", children: ["Session: ", sessionKey] })] }), _jsxs("div", { className: "chat-messages", children: [messages.length === 0 && !sending && (_jsxs("div", { className: "chat-empty-state", children: ["Send a message to start a conversation", selectedAgent ? ` with the "${selectedAgent}" agent` : "", "."] })), messages
                                .filter((m) => m.role !== "system")
                                .map((m, i) => (_jsx(MessageBubble, { message: m }, i))), sending && (activityDesc || activeTool) && (_jsxs("div", { className: "tool-activity", children: [_jsx("div", { className: "spinner" }), activityDesc ?? (activeTool ? `Calling ${activeTool}…` : "Thinking…")] })), _jsx("div", { ref: messagesEnd })] }), _jsxs("div", { className: "chat-input-bar", children: [_jsx("input", { type: "text", placeholder: "Type a message...", value: input, onChange: (e) => setInput(e.target.value), onKeyDown: (e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSend();
                                    }
                                }, disabled: sending }), _jsx("button", { type: "button", onClick: handleSend, disabled: sending || !input.trim(), children: sending ? "..." : "Send" })] })] })] }));
}
function formatTime(iso) {
    try {
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1)
            return "just now";
        if (diffMin < 60)
            return `${diffMin}m ago`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24)
            return `${diffH}h ago`;
        const diffD = Math.floor(diffH / 24);
        if (diffD < 7)
            return `${diffD}d ago`;
        return d.toLocaleDateString();
    }
    catch {
        return iso;
    }
}
