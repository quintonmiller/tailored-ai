import { marked } from "marked";
import { useMemo, useState } from "react";
import type { Message } from "../api";

marked.setOptions({
  breaks: true,
  gfm: true,
});

const TRUNCATE_LENGTH = 500;

export function MessageBubble(props: { message: Message }) {
  const { role, content, toolCalls } = props.message;

  // Assistant message that only triggered tool calls (no text content)
  if (role === "assistant" && !content && toolCalls?.length) {
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
  if (role === "assistant" && content && toolCalls?.length) {
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
  if (role === "assistant" && content) {
    return <AssistantBubble content={content} />;
  }

  // Tool result
  if (role === "tool") {
    return <ToolResultBubble content={content ?? ""} />;
  }

  // User message
  if (role === "user") {
    return <div className="message-bubble user">{content ?? ""}</div>;
  }

  // System — hidden
  return null;
}

function ToolResultBubble(props: { content: string }) {
  const { content } = props;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isTruncatable = content.length > TRUNCATE_LENGTH;
  const displayContent = isTruncatable && !expanded ? `${content.slice(0, TRUNCATE_LENGTH)}...` : content;

  function handleCopy() {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div className="message-bubble tool">
      <pre className="tool-result-content">{displayContent}</pre>
      {(isTruncatable || content.length > 100) && (
        <div className="tool-result-actions">
          {isTruncatable && (
            <button type="button" className="tool-result-btn" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Collapse" : `Expand (${content.length} chars)`}
            </button>
          )}
          <button type="button" className="tool-result-btn" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}

function AssistantBubble(props: { content: string }) {
  const html = useMemo(() => marked.parse(props.content) as string, [props.content]);

  return <div className="message-bubble assistant markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "()";
  if (entries.length === 1) {
    const [k, v] = entries[0];
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 120 ? `${k}: ${s.slice(0, 120)}...` : `${k}: ${s}`;
  }
  return JSON.stringify(args, null, 2);
}
