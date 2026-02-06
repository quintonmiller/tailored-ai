import { useMemo } from 'react';
import { marked } from 'marked';
import type { Message } from '../api';

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function MessageBubble(props: { message: Message }) {
  const { role, content, toolCalls } = props.message;

  // Assistant message that only triggered tool calls (no text content)
  if (role === 'assistant' && !content && toolCalls?.length) {
    return (
      <div className="tool-calls">
        {toolCalls.map((tc) => (
          <div key={tc.id} className="tool-call-bubble">
            <span className="tool-call-name">{tc.name}</span>
            <pre className="tool-call-args">{formatArgs(tc.arguments)}</pre>
          </div>
        ))}
      </div>
    );
  }

  // Assistant message with both content and tool calls
  if (role === 'assistant' && content && toolCalls?.length) {
    return (
      <>
        <AssistantBubble content={content} />
        <div className="tool-calls">
          {toolCalls.map((tc) => (
            <div key={tc.id} className="tool-call-bubble">
              <span className="tool-call-name">{tc.name}</span>
              <pre className="tool-call-args">{formatArgs(tc.arguments)}</pre>
            </div>
          ))}
        </div>
      </>
    );
  }

  // Regular assistant message — render as markdown
  if (role === 'assistant' && content) {
    return <AssistantBubble content={content} />;
  }

  // Tool result
  if (role === 'tool') {
    return (
      <div className="message-bubble tool">
        <pre className="tool-result-content">{content ?? ''}</pre>
      </div>
    );
  }

  // User message
  if (role === 'user') {
    return (
      <div className="message-bubble user">
        {content ?? ''}
      </div>
    );
  }

  // System — hidden
  return null;
}

function AssistantBubble(props: { content: string }) {
  const html = useMemo(() => marked.parse(props.content) as string, [props.content]);

  return (
    <div
      className="message-bubble assistant markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '()';
  if (entries.length === 1) {
    const [k, v] = entries[0];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 120 ? `${k}: ${s.slice(0, 120)}...` : `${k}: ${s}`;
  }
  return JSON.stringify(args, null, 2);
}
