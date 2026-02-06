import { useState, useEffect, useRef } from 'react';
import { fetchMessages, sendChat, type Message, type ChatEvent } from '../api';
import { MessageBubble } from '../components/MessageBubble';
import { StatusBar } from '../components/StatusBar';

export function Chat(props: { sessionKey?: string; sessionId?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(props.sessionKey);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (props.sessionId) {
      fetchMessages(props.sessionId).then(setMessages).catch(() => {});
    }
  }, [props.sessionId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeTool]);

  function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    setInput('');
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', content: text }]);

    sendChat(text, sessionKey, (event: ChatEvent) => {
      switch (event.type) {
        case 'tool_call':
          setActiveTool(event.data.name as string);
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: null,
              toolCalls: [{
                id: `tc-${Date.now()}`,
                name: event.data.name as string,
                arguments: event.data.args as Record<string, unknown>,
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
              content: (event.data.output as string).slice(0, 500),
              toolCallId: `tc-${event.data.name}`,
            },
          ]);
          break;
        case 'response':
          setActiveTool(null);
          setSending(false);
          setSessionKey(event.data.sessionKey as string);
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: event.data.content as string },
          ]);
          if (event.data.sessionKey) {
            window.location.hash = `/chat?key=${encodeURIComponent(event.data.sessionKey as string)}&session=${encodeURIComponent(event.data.sessionId as string)}`;
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

  return (
    <div className="chat">
      <div className="chat-messages">
        {messages
          .filter((m) => m.role !== 'system')
          .map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
        {activeTool && (
          <div className="tool-activity">
            <div className="spinner" />
            Calling {activeTool}...
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
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={sending}
        />
        <button onClick={handleSend} disabled={sending || !input.trim()}>
          {sending ? '...' : 'Send'}
        </button>
      </div>
      <StatusBar connected={true} />
    </div>
  );
}
