import { Fragment, type ReactNode, useEffect, useState } from "react";
import {
  type AgentInfo,
  fetchAgents,
  fetchMemoryNote,
  fetchProjectTask,
  type MemoryNote,
  type ProjectTaskWithComments,
} from "../api";

/**
 * Entity-tag rewriter for assistant output. The agent emits self-closing
 * XML-style references that we lift into interactive chips:
 *
 *   <task id="ptask_..."/>      → TaskChip
 *   <agent name="researcher"/>  → AgentChip
 *   <note id="note_..."/>       → NoteChip
 *   <file path="..." line="..">  → FileChip
 *
 * The renderer walks rendered HTML, slices out tag matches, and threads the
 * untouched HTML around them. Unknown tags or bad attributes fall back to
 * inert text so a malformed tag never breaks the bubble.
 */

const ENTITY_TAG_RE = /<(task|agent|note|file)\s+([^>]*?)\/>|<(task|agent|note|file)\s+([^>]*?)>\s*<\/\3>/g;

interface TagMatch {
  kind: "task" | "agent" | "note" | "file";
  attrs: Record<string, string>;
  raw: string;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match key="value" or key='value' or key=value (unquoted is ASCII-safe).
  const re = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/**
 * Split rendered HTML into a sequence of raw-HTML and entity-chip nodes.
 *
 * **Contract: `html` must already be sanitized** — in practice it comes from
 * `renderMarkdown`, which is the only thing that should produce HTML for this
 * app. The fragments between chips are injected verbatim, so this function
 * inherits its input's safety rather than establishing any of its own. It
 * deliberately does not sanitize here: the fragments are slices of a larger
 * document and can be unbalanced mid-tag, and running a sanitizer over a
 * fragment would rewrite it (closing tags it thinks are open) and corrupt the
 * reassembly.
 */
export function renderWithChips(html: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // ENTITY_TAG_RE has the /g flag; reset state on each call to be safe.
  ENTITY_TAG_RE.lastIndex = 0;
  while ((m = ENTITY_TAG_RE.exec(html)) !== null) {
    const before = html.slice(lastIndex, m.index);
    if (before) {
      parts.push(<span key={`raw-${lastIndex}`} dangerouslySetInnerHTML={{ __html: before }} />);
    }
    const kind = (m[1] ?? m[3]) as TagMatch["kind"];
    const attrs = parseAttrs(m[2] ?? m[4] ?? "");
    parts.push(<EntityChip key={`tag-${m.index}`} kind={kind} attrs={attrs} />);
    lastIndex = m.index + m[0].length;
  }
  const tail = html.slice(lastIndex);
  if (tail) {
    parts.push(<span key={`raw-${lastIndex}`} dangerouslySetInnerHTML={{ __html: tail }} />);
  }
  return parts;
}

function EntityChip({ kind, attrs }: { kind: TagMatch["kind"]; attrs: Record<string, string> }) {
  switch (kind) {
    case "task":
      return attrs.id ? <TaskChip id={attrs.id} /> : <InertChip>{`<task ?/>`}</InertChip>;
    case "agent":
      return attrs.name ? <AgentChip name={attrs.name} /> : <InertChip>{`<agent ?/>`}</InertChip>;
    case "note":
      return attrs.id ? <NoteChip id={attrs.id} /> : <InertChip>{`<note ?/>`}</InertChip>;
    case "file":
      return attrs.path ? <FileChip path={attrs.path} line={attrs.line} /> : <InertChip>{`<file ?/>`}</InertChip>;
    default:
      return null;
  }
}

function InertChip({ children }: { children: ReactNode }) {
  return <code className="chip chip-inert">{children}</code>;
}

function TaskChip({ id }: { id: string }) {
  const [task, setTask] = useState<ProjectTaskWithComments | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchProjectTask(id)
      .then((t) => !cancelled && setTask(t))
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (err) {
    return (
      <span className="chip chip-task chip-error" title={err}>
        task: <code>{id}</code> (not found)
      </span>
    );
  }
  if (!task) {
    return (
      <span className="chip chip-task chip-loading">
        task: <code>{id}</code>
      </span>
    );
  }
  return (
    <a
      className={`chip chip-task chip-task-${task.status}`}
      href={`#/tasks/${id}`}
      title={task.description?.slice(0, 200)}
    >
      <span className="chip-icon">▸</span>
      <span className="chip-label">{task.title}</span>
      <span className="chip-status">{task.status}</span>
    </a>
  );
}

function AgentChip({ name }: { name: string }) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchAgents()
      .then((all) => {
        if (cancelled) return;
        const a = all[name];
        if (a) setInfo(a);
        else setMissing(true);
      })
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [name]);
  if (missing) {
    return (
      <span className="chip chip-agent chip-error" title="Unknown agent">
        agent: <code>{name}</code>
      </span>
    );
  }
  return (
    <a className="chip chip-agent" href={`#/agents/${encodeURIComponent(name)}`} title={info?.description}>
      <span className="chip-icon">◉</span>
      <span className="chip-label">{name}</span>
    </a>
  );
}

function NoteChip({ id }: { id: string }) {
  const [note, setNote] = useState<MemoryNote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchMemoryNote(id)
      .then((n) => !cancelled && setNote(n))
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (err) {
    return (
      <span className="chip chip-note chip-error" title={err}>
        note: <code>{id}</code>
      </span>
    );
  }
  if (!note) {
    return (
      <span className="chip chip-note chip-loading">
        note: <code>{id}</code>
      </span>
    );
  }
  const preview = note.content?.split("\n")[0]?.slice(0, 80) ?? "";
  return (
    <a className="chip chip-note" href="#/memory" title={note.content}>
      <span className="chip-icon">✺</span>
      <span className="chip-label">{preview || id}</span>
      {typeof note.importance === "number" && note.importance >= 0.8 && <span className="chip-status">★</span>}
    </a>
  );
}

function FileChip({ path, line }: { path: string; line?: string }) {
  return (
    <span className="chip chip-file" title={line ? `${path}:${line}` : path}>
      <span className="chip-icon">📄</span>
      <span className="chip-label">{path}</span>
      {line && <span className="chip-status">:{line}</span>}
    </span>
  );
}

/** Convenience wrapper that hides the Fragment ceremony at call sites. */
export function ChipBody({ html }: { html: string }) {
  const nodes = renderWithChips(html);
  return (
    <>
      {nodes.map((n, i) => (
        <Fragment key={i}>{n}</Fragment>
      ))}
    </>
  );
}
