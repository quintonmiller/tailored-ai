import { useState } from "react";
import { useChatStore } from "./ChatContext";

export interface Ask {
  kind: "text" | "choice";
  choices: string[];
  prompt: string;
}

const ASK_RE = /<ask\s+([^>]*?)>([\s\S]*?)<\/ask>/g;
const ASK_SELF_CLOSE_RE = /<ask\s+([^>]*?)\/>/g;

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
 * Pull `<ask kind="choice" choices="a,b,c">…question…</ask>` blocks out of
 * raw content. Self-closing form `<ask kind="text" question="…"/>` also
 * supported.
 */
export function extractAsks(content: string): { content: string; asks: Ask[] } {
  const asks: Ask[] = [];
  ASK_RE.lastIndex = 0;
  let cleaned = content.replace(ASK_RE, (_match, attrStr: string, inner: string) => {
    const attrs = parseAttrs(attrStr);
    asks.push({
      kind: attrs.kind === "choice" ? "choice" : "text",
      choices: attrs.choices
        ? attrs.choices
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      prompt: inner.trim(),
    });
    return "";
  });
  ASK_SELF_CLOSE_RE.lastIndex = 0;
  cleaned = cleaned.replace(ASK_SELF_CLOSE_RE, (_match, attrStr: string) => {
    const attrs = parseAttrs(attrStr);
    asks.push({
      kind: attrs.kind === "choice" ? "choice" : "text",
      choices: attrs.choices
        ? attrs.choices
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      prompt: attrs.question ?? "(no prompt)",
    });
    return "";
  });
  return { content: cleaned, asks };
}

export function AskCard({ ask }: { ask: Ask }) {
  const store = useChatStore();
  const [response, setResponse] = useState("");
  const [answered, setAnswered] = useState<string | null>(null);

  function pickChoice(c: string) {
    if (answered) return;
    setAnswered(c);
    store.send(c);
  }

  function sendText() {
    const text = response.trim();
    if (!text || answered) return;
    setAnswered(text);
    store.send(text);
  }

  return (
    <div className={`ask ask-${ask.kind} ${answered ? "ask-answered" : ""}`}>
      <div className="ask-header">
        <span className="ask-icon">?</span>
        <span className="ask-label">Agent question</span>
      </div>
      <div className="ask-prompt">{ask.prompt}</div>
      {answered ? (
        <div className="ask-replied">
          You replied: <strong>{answered}</strong>
        </div>
      ) : ask.kind === "choice" && ask.choices.length > 0 ? (
        <div className="ask-choices">
          {ask.choices.map((c) => (
            <button key={c} type="button" className="ask-choice" onClick={() => pickChoice(c)}>
              {c}
            </button>
          ))}
        </div>
      ) : (
        <div className="ask-text-input">
          <input
            type="text"
            value={response}
            placeholder="Type your reply…"
            onChange={(e) => setResponse(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendText();
              }
            }}
            aria-label="Reply to agent question"
          />
          <button type="button" className="ask-send" onClick={sendText} disabled={!response.trim()}>
            Reply
          </button>
        </div>
      )}
    </div>
  );
}
