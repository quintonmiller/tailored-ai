import { marked } from "marked";
import { useMemo, useState } from "react";
import type { MemoryRecall, Message, ToolLogEntry, ToolLogToolEntry } from "../api";
import { AskCard, extractAsks } from "./asks";
import { ChipBody } from "./chips";
import { extractProposals, ProposalCard } from "./proposals";

marked.setOptions({
  breaks: true,
  gfm: true,
});

const TRUNCATE_LENGTH = 500;
const COMPACT_TRUNCATE_LENGTH = 120;
const COMPACT_TRUNCATE_LINES = 2;

export function MessageBubble(props: { message: Message }) {
  const { role, content, toolCalls, toolLog, recalled } = props.message;

  // Assistant carrier with a collapsed tool log (preferred path post-grouping).
  // Work summary goes ABOVE the final response so the response stays the
  // most prominent thing on screen.
  if (role === "assistant" && toolLog?.length) {
    return (
      <>
        {recalled && <RecalledChip recalled={recalled} />}
        <ToolLogPanel entries={toolLog} />
        {content && <AssistantBubble content={content} />}
      </>
    );
  }

  // Legacy: assistant message that only triggered tool calls (no text content)
  // — rendered inline when grouping was bypassed.
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

  // Legacy: assistant with both content and tool calls (no toolLog)
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
    return (
      <>
        {recalled && <RecalledChip recalled={recalled} />}
        <AssistantBubble content={content} />
      </>
    );
  }

  // Tool result (legacy path)
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

export function ToolLogPanel(props: {
  entries: ToolLogEntry[];
  /** Live mode: shows a spinner + "Working…" framing instead of "Used N tools". */
  live?: boolean;
  /** Seconds elapsed (live mode only). */
  elapsed?: number;
  /** Force-expanded state (controlled). Otherwise defaults to collapsed. */
  defaultExpanded?: boolean;
}) {
  const { entries, live, elapsed, defaultExpanded } = props;
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const tools = entries.filter(isTool);
  const steps = entries.length;
  const toolCount = tools.length;
  const latestTool = [...tools].reverse().find((t) => t.output === undefined) ?? tools[tools.length - 1];

  const headline = live
    ? buildLiveHeadline(toolCount, latestTool, elapsed)
    : buildDoneHeadline(toolCount, steps, tools);

  return (
    <div className={`tool-log${live ? " tool-log-live" : ""}`}>
      <button
        type="button"
        className="tool-log-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        {live ? (
          <span className="tool-log-spinner" aria-hidden="true" />
        ) : (
          <span className="tool-log-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        )}
        <span>{headline}</span>
      </button>
      {expanded && (
        <div className="tool-log-body">
          {entries.map((e, i) => (
            <div
              key={entryKey(e, i)}
              className={`tool-log-entry${isTool(e) && e.name === "delegate" ? " tool-log-entry-delegate" : ""}`}
            >
              {isTool(e) ? (
                e.name === "delegate" ? (
                  <DelegateSubBubble entry={e} />
                ) : (
                  <>
                    <div className="tool-call-bubble">
                      <span className="tool-call-name">{e.name}</span>
                      <pre className="tool-call-args">{formatArgs(e.args)}</pre>
                    </div>
                    {e.output !== undefined && <ToolResultBubble content={e.output} compact />}
                  </>
                )
              ) : (
                <div className="tool-log-text">
                  <AssistantBubble content={e.content} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function isTool(e: ToolLogEntry): e is ToolLogToolEntry {
  return e.kind !== "text";
}

function entryKey(e: ToolLogEntry, i: number): string {
  if (isTool(e)) return e.id ?? `${e.name}-${i}`;
  return `text-${i}`;
}

function buildLiveHeadline(toolCount: number, latest: ToolLogToolEntry | undefined, elapsed?: number): string {
  const parts: string[] = ["Working"];
  if (elapsed !== undefined) parts.push(`for ${formatElapsed(elapsed)}`);
  if (toolCount > 0) parts.push(`· ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  if (latest) parts.push(`· ${latest.name}…`);
  return parts.join(" ");
}

function buildDoneHeadline(toolCount: number, steps: number, tools: ToolLogToolEntry[]): string {
  if (toolCount === 0) return `${steps} ${steps === 1 ? "step" : "steps"}`;
  const head = `Used ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
  return `${head}${summarizeNames(tools)}`;
}

function summarizeNames(tools: ToolLogToolEntry[]): string {
  const names = tools.map((e) => e.name);
  if (names.length === 0) return "";
  const unique: string[] = [];
  for (const n of names) {
    if (!unique.includes(n)) unique.push(n);
    if (unique.length >= 4) break;
  }
  const tail = unique.length < new Set(names).size ? ", …" : "";
  return ` · ${unique.join(", ")}${tail}`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function ToolResultBubble(props: { content: string; compact?: boolean }) {
  const { content, compact } = props;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const collapsed = compact
    ? truncateCompact(content)
    : content.length > TRUNCATE_LENGTH
      ? `${content.slice(0, TRUNCATE_LENGTH)}...`
      : content;

  const isTruncated = collapsed !== content;
  const displayContent = isTruncated && !expanded ? collapsed : content;

  function handleCopy() {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div className={`message-bubble tool${compact ? " tool-compact" : ""}`}>
      <pre className="tool-result-content">{displayContent}</pre>
      {(isTruncated || content.length > 100) && (
        <div className="tool-result-actions">
          {isTruncated && (
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

function truncateCompact(content: string): string {
  const lines = content.split("\n");
  if (lines.length > COMPACT_TRUNCATE_LINES) {
    const head = lines.slice(0, COMPACT_TRUNCATE_LINES).join("\n");
    if (head.length > COMPACT_TRUNCATE_LENGTH) {
      return `${head.slice(0, COMPACT_TRUNCATE_LENGTH)}…`;
    }
    return `${head}\n…`;
  }
  if (content.length > COMPACT_TRUNCATE_LENGTH) {
    return `${content.slice(0, COMPACT_TRUNCATE_LENGTH)}…`;
  }
  return content;
}

function AssistantBubble(props: { content: string }) {
  const { stripped, proposals, asks } = useMemo(() => {
    const a = extractAsks(props.content);
    const p = extractProposals(a.content);
    return { stripped: p.content, proposals: p.proposals, asks: a.asks };
  }, [props.content]);
  const html = useMemo(() => marked.parse(stripped) as string, [stripped]);

  return (
    <>
      <div className="message-bubble assistant markdown-body">
        <ChipBody html={html} />
      </div>
      {asks.map((a, i) => (
        <AskCard key={`ask-${i}`} ask={a} />
      ))}
      {proposals.map((p, i) => (
        <ProposalCard key={`prop-${i}`} proposal={p} />
      ))}
    </>
  );
}

function RecalledChip({ recalled }: { recalled: MemoryRecall }) {
  const [expanded, setExpanded] = useState(false);
  if (!recalled.count) return null;
  const pinned = recalled.pinned ?? [];
  const pinnedCount = pinned.length;
  const relevant = recalled.sources.filter((s) => !pinned.includes(s));
  const summary =
    pinnedCount > 0
      ? `${pinnedCount} pinned · ${relevant.length} relevant`
      : `Recalled ${recalled.count} ${recalled.count === 1 ? "note" : "notes"}`;
  return (
    <div className="recalled-chip">
      <button
        type="button"
        className="recalled-chip-button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title="Memory hits injected into the system prompt for this turn"
      >
        <span className="recalled-chip-icon">✺</span>
        <span>{summary}</span>
        <span className="recalled-chip-caret">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <ul className="recalled-chip-sources">
          {pinned.map((s) => (
            <li key={`p-${s}`}>
              <span className="recalled-chip-tag">pinned</span>
              <code>{s}</code>
            </li>
          ))}
          {relevant.map((s) => (
            <li key={`r-${s}`}>
              <code>{s}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DelegateSubBubble({ entry }: { entry: ToolLogToolEntry }) {
  const agent = (entry.args?.agent as string | undefined) ?? "(unknown)";
  const task = (entry.args?.task as string | undefined) ?? "";
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="delegate-sub">
      <button
        type="button"
        className="delegate-sub-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="delegate-sub-arrow">↳</span>
        <span className="delegate-sub-label">
          delegated to <strong>{agent}</strong>
        </span>
        <span className="delegate-sub-caret">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="delegate-sub-body">
          {task && (
            <div className="delegate-sub-task">
              <div className="delegate-sub-section-label">Task</div>
              <div className="delegate-sub-task-text">{task}</div>
            </div>
          )}
          {entry.output !== undefined && (
            <div className="delegate-sub-response">
              <div className="delegate-sub-section-label">Response</div>
              <AssistantBubble content={entry.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
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
