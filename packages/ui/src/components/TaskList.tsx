import type { TaskInfo } from "../api";
import { useRelativeTime } from "../hooks/useRelativeTime";

export function TaskList(props: { tasks: TaskInfo[] }) {
  useRelativeTime();
  const { tasks } = props;

  if (tasks.length === 0) {
    return <div className="empty-state">No background tasks.</div>;
  }

  return (
    <div className="task-list">
      {tasks.map((t) => (
        <div key={t.id} className="task-item">
          <div className="task-item-header">
            <span className={`task-badge ${t.status}`}>{t.status}</span>
            <span className="task-id">{t.id}</span>
          </div>
          <div className="task-desc">{t.description}</div>
          <div className="task-meta">{formatDuration(t.startedAt, t.completedAt)}</div>
        </div>
      ))}
    </div>
  );
}

function formatDuration(start: number, end?: number): string {
  const ms = (end ?? Date.now()) - start;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
