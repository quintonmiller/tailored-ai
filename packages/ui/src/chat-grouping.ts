import type { Message, ToolLogEntry, ToolLogToolEntry } from "./api";

/**
 * Collapse a flat message stream into "turns". A turn is the span from a
 * user message to the next user message (or end of stream). The LAST
 * assistant-with-content message in a turn becomes the carrier; everything
 * before it (intermediate text + tool calls + tool results) is folded into
 * that carrier's `toolLog` as an expandable work history.
 *
 * This produces the "[Worked through N steps] · final response" pattern
 * instead of N alternating "Response / Used X tools" bubbles.
 */
export function groupTurns(messages: Message[]): Message[] {
  const out: Message[] = [];
  let span: Message[] = [];

  function flushSpan() {
    if (span.length === 0) return;

    // Locate the last assistant text — that becomes the visible final response.
    let lastTextIdx = -1;
    for (let i = 0; i < span.length; i++) {
      const m = span[i];
      if (m.role === "assistant" && m.content) lastTextIdx = i;
    }

    // Build the work log from everything except the final-text carrier itself.
    const log: ToolLogEntry[] = [];
    for (let i = 0; i < span.length; i++) {
      const m = span[i];
      if (m.role === "assistant") {
        if (m.content && i !== lastTextIdx) {
          log.push({ kind: "text", content: m.content });
        }
        if (m.toolCalls?.length) {
          for (const tc of m.toolCalls) {
            log.push({ kind: "tool", id: tc.id, name: tc.name, args: tc.arguments });
          }
        }
      } else if (m.role === "tool") {
        attachToolResult(log, m.toolCallId, m.content ?? "");
      }
    }

    const finalMsg = lastTextIdx >= 0 ? span[lastTextIdx] : null;
    if (finalMsg) {
      out.push({ ...finalMsg, toolLog: log.length > 0 ? log : finalMsg.toolLog });
    } else if (log.length > 0) {
      // Span had no closing text — emit a content-less carrier so the work
      // log is still visible (e.g. an interrupted turn).
      out.push({ role: "assistant", content: null, toolLog: log });
    }
    span = [];
  }

  for (const m of messages) {
    if (m.role === "user" || m.role === "system") {
      flushSpan();
      out.push(m);
    } else {
      span.push(m);
    }
  }
  flushSpan();
  return out;
}

function attachToolResult(log: ToolLogEntry[], toolCallId: string | undefined, output: string): void {
  // Prefer matching by toolCallId; otherwise fill the latest open tool entry.
  if (toolCallId) {
    for (const e of log) {
      if (isTool(e) && e.id === toolCallId && e.output === undefined) {
        e.output = output;
        return;
      }
    }
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (isTool(e) && e.output === undefined) {
      e.output = output;
      return;
    }
  }
  log.push({ kind: "tool", name: "(orphan)", args: {}, output });
}

function isTool(e: ToolLogEntry): e is ToolLogToolEntry {
  return e.kind !== "text";
}
