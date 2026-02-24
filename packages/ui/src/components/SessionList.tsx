import type { SessionRow } from "../api";
import { useRelativeTime } from "../hooks/useRelativeTime";

export function SessionList(props: { sessions: SessionRow[] }) {
  useRelativeTime();
  if (props.sessions.length === 0) {
    return <div className="empty-state">No sessions yet. Start a new chat.</div>;
  }

  return (
    <div className="session-list">
      {props.sessions.map((s) => (
        <a
          key={s.id}
          className="session-item"
          href={`#/chat?key=${encodeURIComponent(s.key ?? "")}&session=${encodeURIComponent(s.id)}`}
        >
          <span className="session-key">{s.key ?? s.id.slice(0, 8)}</span>
          <span className="session-meta">
            {s.model} &middot; {formatTime(s.updated_at)}
          </span>
        </a>
      ))}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(`${iso}Z`);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}
