import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
import { fetchMessages, sendChat } from '../api';
import { MessageBubble } from '../components/MessageBubble';
import { StatusBar } from '../components/StatusBar';
export function Chat(props) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [activeTool, setActiveTool] = useState(null);
    const [sessionKey, setSessionKey] = useState(props.sessionKey);
    const messagesEnd = useRef(null);
    useEffect(() => {
        if (props.sessionId) {
            fetchMessages(props.sessionId).then(setMessages).catch(() => { });
        }
    }, [props.sessionId]);
    useEffect(() => {
        messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, activeTool]);
    function handleSend() {
        const text = input.trim();
        if (!text || sending)
            return;
        setInput('');
        setSending(true);
        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        sendChat(text, sessionKey, (event) => {
            switch (event.type) {
                case 'tool_call':
                    setActiveTool(event.data.name);
                    setMessages((prev) => [
                        ...prev,
                        {
                            role: 'assistant',
                            content: null,
                            toolCalls: [{
                                    id: `tc-${Date.now()}`,
                                    name: event.data.name,
                                    arguments: event.data.args,
                                }],
                        },
                    ]);
                    break;
                case 'tool_result':
                    setActiveTool(null);
                    setMessages((prev) => [
                        ...prev,
                        {
                            role: 'tool',
                            content: event.data.output.slice(0, 500),
                            toolCallId: `tc-${event.data.name}`,
                        },
                    ]);
                    break;
                case 'response':
                    setActiveTool(null);
                    setSending(false);
                    setSessionKey(event.data.sessionKey);
                    setMessages((prev) => [
                        ...prev,
                        { role: 'assistant', content: event.data.content },
                    ]);
                    if (event.data.sessionKey) {
                        window.location.hash = `/chat?key=${encodeURIComponent(event.data.sessionKey)}&session=${encodeURIComponent(event.data.sessionId)}`;
                    }
                    break;
                case 'error':
                    setActiveTool(null);
                    setSending(false);
                    setMessages((prev) => [
                        ...prev,
                        { role: 'assistant', content: `Error: ${event.data.message}` },
                    ]);
                    break;
            }
        });
    }
    return (_jsxs("div", { className: "chat", children: [_jsxs("div", { className: "chat-messages", children: [messages
                        .filter((m) => m.role !== 'system')
                        .map((m, i) => (_jsx(MessageBubble, { message: m }, i))), activeTool && (_jsxs("div", { className: "tool-activity", children: [_jsx("div", { className: "spinner" }), "Calling ", activeTool, "..."] })), _jsx("div", { ref: messagesEnd })] }), _jsxs("div", { className: "chat-input-bar", children: [_jsx("input", { type: "text", placeholder: "Type a message...", value: input, onChange: (e) => setInput(e.target.value), onKeyDown: (e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }, disabled: sending }), _jsx("button", { onClick: handleSend, disabled: sending || !input.trim(), children: sending ? '...' : 'Send' })] }), _jsx(StatusBar, { connected: true })] }));
}
