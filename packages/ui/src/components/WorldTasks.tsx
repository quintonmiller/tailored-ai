import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  fetchProject,
  fetchProjectTask,
  fetchProjectTasks,
  type ProjectTask,
  type ProjectTaskWithComments,
  updateProjectTask,
} from "../api";
import { nameOf } from "../lib/conversations";
import {
  ago,
  countTasks,
  FILTERS,
  type Filter,
  GROUPS,
  listTasks,
  STATUSES,
  statusLabel,
  type Who,
} from "../lib/tasks";
import { WorldPanel } from "./WorldPanel";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Comments a card shows: the latest few, enough to see where a task stands. */
const COMMENTS = 3;

/**
 * What assigning says before you do it: that the agent is woken to start on
 * the task when the task watcher is on, and that nobody is when it is off.
 */
export function wakeNote(agent: string, wakes: boolean | undefined): string | undefined {
  if (wakes === undefined) return undefined;
  return wakes
    ? `Assigning wakes ${agent}: the task watcher starts it on this task.`
    : `The task watcher is off, so ${agent} isn't woken. The task waits on its list.`;
}

/**
 * One task, opened from its note on a board or its row in the list: what it
 * is, where it stands, who has it, and when it was made and last changed.
 * Its status is one click, it can be given to an agent, its words edited,
 * and it can be archived. Every change goes to the board at once.
 */
export function TaskCard({
  id,
  agents,
  wakes,
  onSaved,
  onBack,
  onClose,
}: {
  id: string;
  /** The agents it can be given to. */
  agents: string[];
  /** Whether assigning wakes the agent; undefined until the server has said. */
  wakes: boolean | undefined;
  /** A change was saved: the boards and the list take it at once. */
  onSaved: (task: ProjectTask) => void;
  /** Back to the list it was opened from. */
  onBack?: () => void;
  onClose: () => void;
}) {
  const [task, setTask] = useState<ProjectTaskWithComments | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ title: string; description: string } | null>(null);
  const [who, setWho] = useState("");
  useEffect(() => {
    let gone = false;
    setTask(null);
    setProblem(null);
    setDone(null);
    setEditing(null);
    fetchProjectTask(id)
      .then((t) => {
        if (gone) return;
        setTask(t);
        setWho(t.assignee ?? "");
        if (t.project_id)
          fetchProject(t.project_id)
            .then((p) => {
              if (!gone) setProject(p.title);
            })
            .catch(() => {});
      })
      .catch((err: unknown) => {
        if (!gone) setProblem(message(err));
      });
    return () => {
      gone = true;
    };
  }, [id]);

  const save = async (change: Parameters<typeof updateProjectTask>[1], said: string): Promise<boolean> => {
    if (!task) return false;
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const updated = await updateProjectTask(task.id, change);
      setTask((t) => (t ? { ...t, ...updated } : t));
      onSaved(updated);
      setDone(said);
      return true;
    } catch (err) {
      setProblem(message(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  // Escape in a box being edited lets go of the edit, not the whole card.
  const keepEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setEditing(null);
  };
  const assigned = task?.assignee ?? "";
  const note = who && who !== assigned ? wakeNote(who, wakes) : undefined;
  const pickable = [...new Set([...agents, ...(assigned ? [assigned] : [])])].sort();

  return (
    <WorldPanel
      kicker="Task"
      title={task?.title ?? (problem ? "Task" : "Opening…")}
      className="world-task"
      onClose={onClose}
      {...(onBack ? { onBack, backLabel: "All tasks" } : {})}
      footer={
        <a className="world-panel-link" href={`#/tasks/${encodeURIComponent(id)}`}>
          Open on the Tasks page
        </a>
      }
    >
      {task && (
        <>
          <fieldset className="world-task-status" aria-label="Status" disabled={busy}>
            {STATUSES.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={task.status === s.id}
                onClick={() => {
                  if (task.status === s.id) return;
                  // Out of blocked, the reason it was blocked goes with it.
                  void save(
                    { status: s.id, ...(task.status === "blocked" ? { blocked_reason: null } : {}) },
                    `Moved to ${s.label}.`,
                  );
                }}
              >
                {s.label}
              </button>
            ))}
          </fieldset>
          {/* What just happened, where the eye is: under the status it most often is about. */}
          {done && (
            <p className="new-task-made world-panel-said" aria-live="polite">
              {done}
            </p>
          )}
          {problem && <p className="agent-menu-problem">{problem}</p>}
          {!STATUSES.some((s) => s.id === task.status) && (
            <p className="world-panel-quiet">
              {statusLabel(task.status)}
              {task.status === "archived" ? ": off the boards. Pick a status to bring it back." : "."}
            </p>
          )}
          <dl className="world-facts">
            <dt>Who</dt>
            <dd>{task.assignee ? nameOf(task.assignee) : "Nobody yet"}</dd>
            {project && (
              <>
                <dt>Project</dt>
                <dd>{project}</dd>
              </>
            )}
            {task.tags.length > 0 && (
              <>
                <dt>Tags</dt>
                <dd>{task.tags.join(", ")}</dd>
              </>
            )}
            <dt>Made</dt>
            <dd>
              {ago(task.created_at) ?? "—"}
              {task.author ? ` by ${task.author}` : ""}
            </dd>
            <dt>Changed</dt>
            <dd>{ago(task.updated_at) ?? "—"}</dd>
          </dl>
          {editing ? (
            <form
              className="world-task-edit"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!editing.title.trim()) return;
                if (await save({ title: editing.title.trim(), description: editing.description.trim() }, "Saved."))
                  setEditing(null);
              }}
            >
              <label>
                Title
                <input
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  onKeyDown={keepEscape}
                  required
                />
              </label>
              <label>
                Details
                <textarea
                  value={editing.description}
                  rows={5}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  onKeyDown={keepEscape}
                />
              </label>
              <div className="world-panel-row">
                <button type="submit" className="talk-tool" disabled={busy || !editing.title.trim()}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button type="button" className="talk-tool" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="world-task-words">
              {task.description ? (
                <p className="world-task-text">{task.description}</p>
              ) : (
                <p className="world-panel-quiet">No details yet.</p>
              )}
              <button
                type="button"
                className="talk-tool"
                onClick={() => setEditing({ title: task.title, description: task.description })}
              >
                Edit
              </button>
            </div>
          )}
          <div className="world-task-assign">
            <label>
              Who does it
              <select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Nobody</option>
                {pickable.map((a) => (
                  <option key={a} value={a}>
                    {nameOf(a)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="talk-tool"
              disabled={busy || who === assigned}
              onClick={() =>
                void save({ assignee: who || null }, who ? `Given to ${nameOf(who)}.` : "Nobody has it now.")
              }
            >
              {who || !assigned ? "Assign" : "Unassign"}
            </button>
            {note && <p className="new-task-note">{note}</p>}
          </div>
          {task.comments.length > 0 && (
            <section className="world-task-comments" aria-label="Latest comments">
              <h3>Latest</h3>
              <ol>
                {task.comments.slice(-COMMENTS).map((c) => (
                  <li key={c.id}>
                    <span className="world-task-comment-head">
                      <strong>{c.author}</strong> {ago(c.created_at)}
                    </span>
                    <p>{c.content.length > 280 ? `${c.content.slice(0, 279)}…` : c.content}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {task.status !== "archived" && (
            <div className="world-panel-row">
              <button
                type="button"
                className="talk-tool world-panel-quiet-btn"
                disabled={busy}
                onClick={() => void save({ status: "archived" }, "Archived. It's off the boards.")}
              >
                Archive
              </button>
            </div>
          )}
        </>
      )}
      {!task && problem && <p className="agent-menu-problem">{problem}</p>}
    </WorldPanel>
  );
}

/** How the list is filtered: by status group, and whose. */
export interface ListView {
  filter: Filter;
  who: Who;
}

const ANYONE = ":anyone";
const NOBODY = ":nobody";

/**
 * Every task, in the world: filtered by status and by who has it, newest
 * first. A row opens its card; "New task" opens the form. The full Tasks page
 * is a link at the bottom, for what this doesn't do.
 */
export function TaskList({
  tasks,
  total,
  agents,
  view,
  onView,
  onOpen,
  onNew,
  onClose,
}: {
  /** Every task that isn't archived, as the boards have them: the most recently changed, when there are a lot. */
  tasks: ProjectTask[];
  /** How many there are in all, kept or not. */
  total: number;
  agents: string[];
  view: ListView;
  onView: (view: ListView) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  // Archived tasks are asked for only when someone wants to see them: they pile up.
  const [archived, setArchived] = useState<ProjectTask[] | null>(null);
  const wantsArchived = view.filter === "archived" || view.filter === "all";
  useEffect(() => {
    if (!wantsArchived || archived) return;
    let gone = false;
    fetchProjectTasks({ status: "archived", limit: 100 })
      .then((res) => {
        if (!gone) setArchived(res.tasks);
      })
      .catch(() => {
        if (!gone) setArchived([]);
      });
    return () => {
      gone = true;
    };
  }, [wantsArchived, archived]);
  const all = useMemo(
    () => [...tasks, ...(archived ?? []).filter((a) => !tasks.some((t) => t.id === a.id))],
    [tasks, archived],
  );
  const counts = useMemo(() => countTasks(all, view.who), [all, view.who]);
  const shown = useMemo(() => listTasks(all, view.filter, view.who), [all, view.filter, view.who]);
  // Anyone a task is given to can be picked, an agent since removed included.
  const people = useMemo(
    () => [...new Set([...agents, ...all.flatMap((t) => (t.assignee ? [t.assignee] : []))])].sort(),
    [agents, all],
  );
  const title =
    view.who === undefined ? "Every task" : view.who === null ? "Nobody's yet" : `${nameOf(view.who)}'s tasks`;
  return (
    <WorldPanel
      kicker="Tasks"
      title={title}
      className="world-list-panel"
      onClose={onClose}
      footer={
        <a className="world-panel-link" href="#/tasks">
          Open the Tasks page
        </a>
      }
    >
      <div className="world-panel-row world-list-tools">
        <button type="button" className="talk-tool" onClick={onNew}>
          + New task
        </button>
        <label className="world-list-who">
          Whose
          <select
            value={view.who === undefined ? ANYONE : view.who === null ? NOBODY : view.who}
            onChange={(e) => {
              const v = e.target.value;
              onView({ ...view, who: v === ANYONE ? undefined : v === NOBODY ? null : v });
            }}
          >
            <option value={ANYONE}>Anyone's</option>
            <option value={NOBODY}>Nobody's yet</option>
            {people.map((a) => (
              <option key={a} value={a}>
                {nameOf(a)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="world-list-filters" aria-label="Show">
        {FILTERS.map((f) => {
          // Until the archived ones are in, a count that leaves them out would be wrong.
          const counted = archived || (f.id !== "archived" && f.id !== "all");
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={view.filter === f.id}
              onClick={() => onView({ ...view, filter: f.id })}
            >
              {f.label}
              {counted && <span className="world-list-count">{counts[f.id]}</span>}
            </button>
          );
        })}
      </fieldset>
      {shown.length > 0 ? (
        <ul className="world-list">
          {shown.map((t) => {
            const color = GROUPS.find((g) => g.statuses.includes(t.status))?.color;
            return (
              <li key={t.id}>
                <button type="button" className="world-list-row" onClick={() => onOpen(t.id)}>
                  <span
                    className="world-list-dot"
                    style={color ? { background: color } : undefined}
                    aria-hidden="true"
                  />
                  <span className="world-list-title">{t.title}</span>
                  <span className="world-list-meta">
                    {statusLabel(t.status)} · {t.assignee ? nameOf(t.assignee) : "nobody yet"}
                    {ago(t.created_at) ? ` · made ${ago(t.created_at)}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="world-panel-quiet">
          {wantsArchived && !archived ? "Looking…" : "Nothing here. Try another filter, or make a task."}
        </p>
      )}
      {total > tasks.length && (
        <p className="world-panel-quiet">
          These are the {tasks.length} most recently changed of {total}. The Tasks page has the rest.
        </p>
      )}
    </WorldPanel>
  );
}
