/**
 * A tool call's arguments, as a person deciding whether to approve it reads
 * them: each one as key and value, strings inline and anything else as JSON,
 * long values cut short with the whole call as raw JSON a click away. The
 * chat's approval panel and the world's approval card show the same thing.
 */

/** One arg value rendered compactly — strings inline, objects stringified. */
function formatArgValue(v: unknown): { display: string; truncated: boolean } {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  if (s.length > 140) return { display: `${s.slice(0, 140)}…`, truncated: true };
  return { display: s, truncated: false };
}

/** Compact key: value list for a tool-call's args, with raw JSON on demand. */
export function ApprovalArgs({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args);
  if (entries.length === 0) return null;
  let raw: string;
  try {
    raw = JSON.stringify(args, null, 2);
  } catch {
    raw = String(args);
  }
  const anyTruncated = entries.some(([, v]) => formatArgValue(v).truncated);
  return (
    <div className="chat-approval-args">
      <dl className="chat-approval-arg-list">
        {entries.map(([k, v]) => (
          <div key={k} className="chat-approval-arg">
            <dt>{k}</dt>
            <dd>{formatArgValue(v).display}</dd>
          </div>
        ))}
      </dl>
      {(anyTruncated || entries.length > 1) && (
        <details className="chat-approval-raw">
          <summary>Raw JSON</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </div>
  );
}
