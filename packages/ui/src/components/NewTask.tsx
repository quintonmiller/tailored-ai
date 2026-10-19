import { useEffect, useRef, useState } from "react";
import { createProjectTask } from "../api";

/**
 * Make a task from the 3D room: a title, what it is, and who should do it.
 * Assigned to an agent, it starts on it when the task watcher is on, and the
 * form says which before you make it.
 */
export function NewTask({
  agents,
  wakes,
  onMade,
  onClose,
}: {
  agents: string[];
  /** Whether a new task wakes the agent it is given to; undefined until the server has said. */
  wakes?: boolean;
  /** A task was made: the boards show it at once. */
  onMade?: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const box = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    box.current?.querySelector("input")?.focus();
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <form
      ref={box}
      className="new-task"
      role="dialog"
      aria-label="New task"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        setProblem(null);
        try {
          await createProjectTask({
            title: title.trim(),
            ...(details.trim() ? { description: details.trim() } : {}),
            ...(assignee ? { assignee } : {}),
          });
          setMade(assignee ? `Made "${title.trim()}" for ${assignee}.` : `Made "${title.trim()}".`);
          setTitle("");
          setDetails("");
          onMade?.();
        } catch (err) {
          setProblem(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="new-task-head">
        <strong>New task</strong>
        <button type="button" className="world-map-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" required />
      </label>
      <label>
        Details
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3} placeholder="Optional" />
      </label>
      <label>
        Who does it
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Nobody yet</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      {assignee && wakes !== undefined && (
        <p className="new-task-note">
          {wakes
            ? `${assignee} starts on it as soon as it's made.`
            : `The task watcher is off, so ${assignee} isn't woken. The task waits on its list.`}
        </p>
      )}
      <button type="submit" className="talk-tool" disabled={busy || !title.trim()}>
        {busy ? "Making…" : "Make task"}
      </button>
      {made && <p className="new-task-made">{made}</p>}
      {problem && <p className="agent-menu-problem">{problem}</p>}
    </form>
  );
}
