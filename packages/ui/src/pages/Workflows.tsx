import { useEffect, useRef, useState } from "react";
import {
  deleteWorkflow,
  fetchWorkflow,
  fetchWorkflows,
  runWorkflow,
  saveWorkflow,
  type WorkflowDefinition,
  type WorkflowSummary,
} from "../api";
import { RunWorkflowDialog } from "../components/RunWorkflowDialog";
import { WorkflowGraph } from "../components/WorkflowGraph";
import { useWorkflowMetadata } from "../workflow-metadata";
import { getTemplate, resolveTemplateContext, WORKFLOW_TEMPLATES } from "../workflow-templates";

const NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [errors, setErrors] = useState<Array<{ path: string; error: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [_reloadTick, setReloadTick] = useState(0);

  // Inline "new workflow" input state.
  const [newName, setNewName] = useState<string | null>(null);
  const [newNameError, setNewNameError] = useState<string | null>(null);
  const [newTemplateId, setNewTemplateId] = useState<string>("blank");
  const newNameInputRef = useRef<HTMLInputElement | null>(null);

  // Names of in-memory drafts that haven't been saved yet.
  const [unsavedDrafts, setUnsavedDrafts] = useState<Set<string>>(new Set());

  // User's actually-configured agents — feeds the template builders so they
  // can pick agent names that resolve (vs. hardcoded "primary").
  const meta = useWorkflowMetadata();

  const [pendingDelete, setPendingDelete] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runDryRun, setRunDryRun] = useState(false);

  useEffect(() => {
    fetchWorkflows()
      .then((res) => {
        setWorkflows(res.workflows);
        setErrors(res.errors);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) {
      setEditing(null);
      return;
    }
    if (unsavedDrafts.has(selected)) return;
    fetchWorkflow(selected)
      .then(setEditing)
      .catch(() => setEditing(null));
  }, [selected, unsavedDrafts]);

  useEffect(() => {
    if (newName !== null) newNameInputRef.current?.focus();
  }, [newName]);

  function startNew() {
    setNewName("");
    setNewNameError(null);
    setNewTemplateId("blank");
  }

  function cancelNew() {
    setNewName(null);
    setNewNameError(null);
  }

  function confirmNew() {
    const name = (newName ?? "").trim();
    if (!name) {
      cancelNew();
      return;
    }
    if (!NAME_PATTERN.test(name)) {
      setNewNameError("Use letters, numbers, dot, dash, or underscore.");
      return;
    }
    if (workflows.find((w) => w.name === name) || unsavedDrafts.has(name)) {
      setNewNameError("A workflow with that name already exists.");
      return;
    }
    const template = getTemplate(newTemplateId) ?? getTemplate("blank")!;
    const ctx = resolveTemplateContext(meta.agents);
    setUnsavedDrafts((prev) => new Set(prev).add(name));
    setEditing(template.build(name, ctx));
    setSelected(name);
    setNewName(null);
    setNewNameError(null);
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
      setUnsavedDrafts((prev) => {
        if (!prev.has(editing.name)) return prev;
        const next = new Set(prev);
        next.delete(editing.name);
        return next;
      });
      setReloadTick((n) => n + 1);
      setTimeout(() => setStatus({ type: "idle" }), 2000);
    }
  }

  async function handleDelete() {
    if (!editing) return;
    if (!pendingDelete) {
      setPendingDelete(true);
      setTimeout(() => setPendingDelete(false), 4000);
      return;
    }
    setPendingDelete(false);

    if (unsavedDrafts.has(editing.name)) {
      setUnsavedDrafts((prev) => {
        const next = new Set(prev);
        next.delete(editing.name);
        return next;
      });
      setSelected(null);
      setEditing(null);
      return;
    }

    const result = await deleteWorkflow(editing.name);
    if (result.error) {
      setStatus({ type: "error", message: result.error });
    } else {
      setSelected(null);
      setEditing(null);
      setReloadTick((n) => n + 1);
    }
  }

  async function handleRun(dryRun = false) {
    if (!editing) return;
    setRunDryRun(dryRun);
    // If the workflow declares inputs, surface the dialog so the user can
    // populate them. Bare workflows fire immediately.
    if (editing.inputs && Object.keys(editing.inputs).length > 0) {
      setRunDialogOpen(true);
      return;
    }
    await launchRun({}, dryRun);
  }

  async function launchRun(input: Record<string, unknown>, dryRun = runDryRun) {
    if (!editing) return;
    setStatus({ type: "saving", message: dryRun ? "Dry-running..." : "Running..." });
    setRunDialogOpen(false);
    try {
      const run = await runWorkflow(editing.name, input, { dryRun });
      setStatus({ type: "saved", message: `Started ${run.id}` });
      window.location.hash = `/workflow-runs/${run.id}`;
    } catch (e) {
      setStatus({ type: "error", message: (e as Error).message });
    }
  }

  // All known workflows, including in-memory drafts.
  const allWorkflowNames = [
    ...workflows.map((w) => w.name),
    ...Array.from(unsavedDrafts).filter((n) => !workflows.find((w) => w.name === n)),
  ];

  return (
    <div className="wf-page">
      <header className="wf-page-header">
        <div className="wf-page-header-left">
          <label className="wf-page-picker-label">Workflow</label>
          <select
            className="wf-page-picker"
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value || null)}
          >
            <option value="">— none —</option>
            {allWorkflowNames.map((n) => (
              <option key={n} value={n}>
                {n}
                {unsavedDrafts.has(n) ? " (unsaved)" : ""}
              </option>
            ))}
          </select>
          {newName === null ? (
            <button type="button" className="btn-secondary" onClick={startNew}>
              + New
            </button>
          ) : (
            <div className="wf-page-new-input">
              <input
                ref={newNameInputRef}
                className={`field-input${newNameError ? " field-input-error" : ""}`}
                value={newName}
                placeholder="workflow-name"
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (newNameError) setNewNameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    confirmNew();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelNew();
                  }
                }}
              />
              <select
                className="wf-page-template-picker"
                value={newTemplateId}
                onChange={(e) => setNewTemplateId(e.target.value)}
                title={getTemplate(newTemplateId)?.description ?? ""}
              >
                {WORKFLOW_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-secondary" onClick={confirmNew}>
                Create
              </button>
              <button type="button" className="btn-ghost" onClick={cancelNew}>
                Cancel
              </button>
              {newNameError && <div className="wf-page-new-error">{newNameError}</div>}
              <div className="wf-page-template-hint">{getTemplate(newTemplateId)?.description}</div>
            </div>
          )}
        </div>
        <div className="wf-page-header-right">
          {status.type === "saved" && <span className="config-saved">{status.message}</span>}
          {status.type === "error" && (
            <span className="config-error" title={status.message}>
              {status.message}
            </span>
          )}
          <a href="#/workflow-analytics" className="btn-ghost wf-page-history-link">
            Analytics
          </a>
          <a href="#/workflow-runs" className="btn-ghost wf-page-history-link">
            Run history →
          </a>
          {editing && (
            <>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => handleRun(true)}
                disabled={status.type === "saving"}
                title="Skips side-effecting steps (no channel messages/email/POSTs/shell). Useful for testing."
              >
                Dry run
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleRun(false)}
                disabled={status.type === "saving"}
              >
                Run
              </button>
              <button type="button" className="btn-danger" onClick={handleDelete}>
                {pendingDelete ? "Click again to confirm" : "Delete"}
              </button>
              <button
                type="button"
                className="config-save-btn"
                onClick={handleSave}
                disabled={status.type === "saving"}
              >
                {status.type === "saving" ? "Saving..." : "Save"}
              </button>
            </>
          )}
        </div>
      </header>

      {!editing && (
        <div className="wf-page-empty">
          <p>
            Pick a workflow above, or click <strong>+ New</strong>.
          </p>
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
        </div>
      )}

      {editing && <WorkflowGraph workflow={editing} onChange={setEditing} />}
      {editing && runDialogOpen && (
        <RunWorkflowDialog workflow={editing} onCancel={() => setRunDialogOpen(false)} onSubmit={launchRun} />
      )}
    </div>
  );
}
