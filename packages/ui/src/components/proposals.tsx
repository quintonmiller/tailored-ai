import { useState } from "react";
import { createMemoryNote, createProjectTask } from "../api";
import { useChatStore } from "./ChatContext";
import { describeError, useToast } from "./Toast";

export interface Proposal {
  kind: "task" | "fix" | "note";
  priority: "low" | "normal" | "high" | "critical";
  tags: string[];
  title: string;
  body: string;
}

const PROPOSAL_RE = /<proposal\s+([^>]*?)>([\s\S]*?)<\/proposal>/g;
const TITLE_RE = /<title>([\s\S]*?)<\/title>/;
const BODY_RE = /<body>([\s\S]*?)<\/body>/;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/**
 * Extract `<proposal>...</proposal>` blocks from raw assistant content.
 * Returns the content with proposals stripped and the parsed proposals.
 */
export function extractProposals(content: string): { content: string; proposals: Proposal[] } {
  const proposals: Proposal[] = [];
  // Reset regex global state.
  PROPOSAL_RE.lastIndex = 0;
  const cleaned = content.replace(PROPOSAL_RE, (_match, attrStr: string, inner: string) => {
    const attrs = parseAttrs(attrStr);
    const titleMatch = inner.match(TITLE_RE);
    const bodyMatch = inner.match(BODY_RE);
    const kindRaw = attrs.kind ?? "task";
    const kind: Proposal["kind"] =
      kindRaw === "fix" || kindRaw === "note" ? kindRaw : "task";
    const priorityRaw = attrs.priority ?? "normal";
    const priority: Proposal["priority"] =
      priorityRaw === "low" ||
      priorityRaw === "high" ||
      priorityRaw === "critical" ||
      priorityRaw === "normal"
        ? priorityRaw
        : "normal";
    const tags = attrs.tags
      ? attrs.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    proposals.push({
      kind,
      priority,
      tags,
      title: titleMatch?.[1]?.trim() ?? "(untitled proposal)",
      body: bodyMatch?.[1]?.trim() ?? inner.trim(),
    });
    return "";
  });
  return { content: cleaned, proposals };
}

export function ProposalCard({ proposal }: { proposal: Proposal }) {
  const toast = useToast();
  const store = useChatStore();
  const [status, setStatus] = useState<"pending" | "accepted" | "dismissed" | "busy">("pending");

  async function handleAccept() {
    setStatus("busy");
    try {
      if (proposal.kind === "task") {
        const task = await createProjectTask({
          title: proposal.title,
          description: proposal.body,
          tags: ["proposal", ...proposal.tags],
        });
        toast.success(`Created task ${task.id}`);
        setStatus("accepted");
      } else if (proposal.kind === "fix") {
        toast.info("Asking the agent to apply the fix");
        store.send(
          `Please apply the fix you proposed: "${proposal.title}". ${proposal.body}`,
        );
        setStatus("accepted");
      } else {
        const note = await createMemoryNote({
          content: `${proposal.title}\n\n${proposal.body}`,
          tags: ["proposal", ...proposal.tags],
          importance: 0.6,
        });
        toast.success(`Saved note ${note.id}`);
        setStatus("accepted");
      }
    } catch (e) {
      toast.error(`Accept failed: ${describeError(e)}`);
      setStatus("pending");
    }
  }

  async function handleDismiss() {
    setStatus("busy");
    try {
      await createMemoryNote({
        content: `dismissed-proposal: ${proposal.title}\n\nReason: dismissed by user from chat`,
        tags: ["dismissed-proposal", ...proposal.tags],
        importance: 0.3,
      });
      toast.info("Dismissed and recorded");
      setStatus("dismissed");
    } catch (e) {
      // Even if note write fails, mark dismissed locally — user said no.
      toast.error(`Dismiss note failed: ${describeError(e)}`);
      setStatus("dismissed");
    }
  }

  function handleTellMore() {
    store.send(`Tell me more about your proposal "${proposal.title}".`);
  }

  return (
    <div
      className={`proposal proposal-${proposal.kind} proposal-${proposal.priority} proposal-status-${status}`}
    >
      <div className="proposal-header">
        <span className={`proposal-kind kind-${proposal.kind}`}>{proposal.kind}</span>
        {proposal.priority !== "normal" && (
          <span className={`proposal-priority pri-${proposal.priority}`}>{proposal.priority}</span>
        )}
        <span className="proposal-title">{proposal.title}</span>
      </div>
      {proposal.body && <div className="proposal-body">{proposal.body}</div>}
      {proposal.tags.length > 0 && (
        <div className="proposal-tags">
          {proposal.tags.map((t) => (
            <span key={t} className="proposal-tag">
              #{t}
            </span>
          ))}
        </div>
      )}
      <div className="proposal-actions">
        {status === "pending" && (
          <>
            <button type="button" className="proposal-accept" onClick={handleAccept}>
              {proposal.kind === "task"
                ? "Create task"
                : proposal.kind === "fix"
                  ? "Ask agent to fix"
                  : "Save note"}
            </button>
            <button type="button" className="proposal-tell-more" onClick={handleTellMore}>
              Tell me more
            </button>
            <button type="button" className="proposal-dismiss" onClick={handleDismiss}>
              Dismiss
            </button>
          </>
        )}
        {status === "busy" && <span className="proposal-busy">Working…</span>}
        {status === "accepted" && <span className="proposal-done">Accepted</span>}
        {status === "dismissed" && <span className="proposal-done">Dismissed</span>}
      </div>
    </div>
  );
}
