import { useEffect, useState } from "react";
import {
  deleteWorkflow,
  fetchWorkflow,
  fetchWorkflows,
  runWorkflow,
  saveWorkflow,
  type WorkflowDefinition,
  type WorkflowSummary,
} from "../api";
import { blankStep, WorkflowStepEditor } from "../components/WorkflowStepEditor";

export function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [errors, setErrors] = useState<Array<{ path: string; error: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    fetchWorkflows()
      .then((res) => {
        setWorkflows(res.workflows);
        setErrors(res.errors);
      })
      .catch(() => {});
  }, [reloadTick]);

  useEffect(() => {
    if (!selected) {
      setEditing(null);
      return;
    }
    fetchWorkflow(selected)
      .then(setEditing)
      .catch(() => setEditing(null));
  }, [selected, reloadTick]);

  function handleNew() {
    const name = prompt("New workflow name (alphanumerics, .-_):");
    if (!name) return;
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      alert("Invalid name");
      return;
    }
    if (workflows.find((w) => w.name === name)) {
      alert("A workflow with that name already exists");
      return;
    }
    setEditing({
      name,
      description: "",
      steps: [blankStep("agent_run")],
    });
    setSelected(name);
  }

  async function handleSave() {
    if (!editing) return;
    setStatus({ type: "saving" });
    const result = await saveWorkflow(editing.name, { definition: editing });
    if (result.error) {
      setStatus({
        type: "error",
        message: result.details ? `${result.error}: ${result.details.join("; ")}` : result.error,
      });
    } else {
      setStatus({ type: "saved", message: "Saved" });
      setReloadTick((n) => n + 1);
      setTimeout(() => setStatus({ type: "idle" }), 2000);
    }
  }

  async function handleDelete() {
    if (!editing) return;
    if (!confirm(`Delete workflow "${editing.name}"?`)) return;
    const result = await deleteWorkflow(editing.name);
    if (result.error) {
      setStatus({ type: "error", message: result.error });
    } else {
      setSelected(null);
      setEditing(null);
      setReloadTick((n) => n + 1);
    }
  }

  async function handleRun() {
    if (!editing) return;
    setStatus({ type: "saving", message: "Running..." });
    try {
      const run = await runWorkflow(editing.name);
      setStatus({ type: "saved", message: `Started ${run.id}` });
      window.location.hash = `/workflow-runs/${run.id}`;
    } catch (e) {
      setStatus({ type: "error", message: (e as Error).message });
    }
  }

  return (
    <div className="config-layout">
      <nav className="config-sidebar">
        <div className="config-sidebar-header">
          <span>Workflows ({workflows.length})</span>
          <button type="button" className="btn-secondary" onClick={handleNew}>+ New</button>
        </div>
        {workflows.map((w) => (
          <button
            type="button"
            key={w.name}
            className={`config-sidebar-item${selected === w.name ? " active" : ""}`}
            onClick={() => setSelected(w.name)}
          >
            <div className="workflow-list-name">{w.name}</div>
            <div className="workflow-list-meta">{w.stepCount} steps · {w.source}</div>
          </button>
        ))}
        {errors.length > 0 && (
          <div className="workflow-errors">
            <div className="workflow-errors-header">Load errors</div>
            {errors.map((e, i) => (
              <div key={i} className="workflow-error-row" title={e.path}>
                {e.path.split("/").pop()}: {e.error}
              </div>
            ))}
          </div>
        )}
      </nav>
      <div className="config-content">
        {!editing && (
          <div className="empty-state">Select a workflow to edit, or create a new one.</div>
        )}
        {editing && (
          <>
            <div className="config-header">
              <div>
                <h2>{editing.name}</h2>
                <span className="config-path">{editing.steps.length} steps</span>
              </div>
              <div className="config-actions">
                {status.type === "saved" && <span className="config-saved">{status.message}</span>}
                {status.type === "error" && <span className="config-error">{status.message}</span>}
                <button type="button" className="btn-secondary" onClick={handleRun} disabled={status.type === "saving"}>
                  Run
                </button>
                <button type="button" className="btn-danger" onClick={handleDelete}>
                  Delete
                </button>
                <button
                  type="button"
                  className="config-save-btn"
                  onClick={handleSave}
                  disabled={status.type === "saving"}
                >
                  {status.type === "saving" ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            <div className="section-card">
              <div className="field-group">
                <label className="field-label">Description</label>
                <input
                  className="field-input"
                  value={editing.description ?? ""}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>
              <div className="field-group">
                <label className="field-label">deadlineMs (optional)</label>
                <input
                  className="field-input"
                  type="number"
                  value={editing.deadlineMs ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      deadlineMs: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </div>
            </div>

            <div className="section-card">
              <div className="section-header">
                <h3>Steps</h3>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    setEditing({ ...editing, steps: [...editing.steps, blankStep("agent_run")] })
                  }
                >
                  + Add step
                </button>
              </div>
              <div className="workflow-steps">
                {editing.steps.map((s, idx) => (
                  <WorkflowStepEditor
                    key={idx}
                    step={s}
                    onChange={(next) =>
                      setEditing({
                        ...editing,
                        steps: editing.steps.map((cur, i) => (i === idx ? next : cur)),
                      })
                    }
                    onRemove={() =>
                      setEditing({
                        ...editing,
                        steps: editing.steps.filter((_, i) => i !== idx),
                      })
                    }
                    onMoveUp={
                      idx > 0
                        ? () => {
                            const copy = [...editing.steps];
                            [copy[idx], copy[idx - 1]] = [copy[idx - 1], copy[idx]];
                            setEditing({ ...editing, steps: copy });
                          }
                        : undefined
                    }
                    onMoveDown={
                      idx < editing.steps.length - 1
                        ? () => {
                            const copy = [...editing.steps];
                            [copy[idx], copy[idx + 1]] = [copy[idx + 1], copy[idx]];
                            setEditing({ ...editing, steps: copy });
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
