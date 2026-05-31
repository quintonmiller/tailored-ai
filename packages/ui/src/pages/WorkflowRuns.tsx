import { useEffect, useRef, useState } from "react";
import {
  cancelWorkflowRun,
  fetchWorkflowRun,
  fetchWorkflowRuns,
  fetchWorkflowStepLog,
  type WorkflowRunRow,
  type WorkflowStepRow,
} from "../api";
import { PendingFormPanel } from "../components/PendingFormPanel";

interface Props {
  runId?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function WorkflowRuns({ runId }: Props) {
  const [runs, setRuns] = useState<WorkflowRunRow[]>([]);
  const [run, setRun] = useState<WorkflowRunRow | null>(null);
  const [steps, setSteps] = useState<WorkflowStepRow[]>([]);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [stepLog, setStepLog] = useState<string>("");
  const [formsRefresh, setFormsRefresh] = useState(0);
  const eventsRef = useRef<EventSource | null>(null);

  // Load list of runs
  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchWorkflowRuns({ limit: 50 })
        .then((rows) => {
          if (!cancelled) setRuns(rows);
        })
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Load run detail + open SSE
  useEffect(() => {
    eventsRef.current?.close();
    eventsRef.current = null;
    setRun(null);
    setSteps([]);
    setSelectedStep(null);
    setStepLog("");
    if (!runId) return;

    fetchWorkflowRun(runId)
      .then((data) => {
        setRun(data.run);
        setSteps(data.steps);
        if (TERMINAL.has(data.run.status)) return;
        const es = new EventSource(`/api/workflow-runs/${encodeURIComponent(runId)}/events`);
        eventsRef.current = es;

        es.addEventListener("snapshot", (ev) => {
          try {
            const d = JSON.parse((ev as MessageEvent).data);
            if (d.run) setRun(d.run);
            if (d.steps) setSteps(d.steps);
          } catch {}
        });
        const refresh = () => {
          fetchWorkflowRun(runId)
            .then((data) => {
              setRun(data.run);
              setSteps(data.steps);
            })
            .catch(() => {});
        };
        for (const t of [
          "step.started",
          "step.completed",
          "step.failed",
          "step.skipped",
          "run.started",
          "run.completed",
          "run.failed",
          "run.cancelled",
        ]) {
          es.addEventListener(t, refresh);
        }
        const bumpForms = () => setFormsRefresh((n) => n + 1);
        for (const t of ["form.pending", "form.submitted"]) {
          es.addEventListener(t, () => {
            bumpForms();
            refresh();
          });
        }
        es.onerror = () => {
          es.close();
        };
      })
      .catch(() => {});
    return () => {
      eventsRef.current?.close();
    };
  }, [runId]);

  // Load step log when a step is selected
  useEffect(() => {
    if (!runId || !selectedStep) {
      setStepLog("");
      return;
    }
    let cancelled = false;
    function load() {
      if (!runId || !selectedStep) return;
      fetchWorkflowStepLog(runId, selectedStep)
        .then((data) => {
          if (!cancelled) setStepLog(data.content);
        })
        .catch((e) => {
          if (!cancelled) setStepLog(`(no log: ${(e as Error).message})`);
        });
    }
    load();
    // Poll while step is still running
    const stepRow = steps.find((s) => s.step_name === selectedStep);
    if (stepRow && !TERMINAL.has(stepRow.status) && stepRow.status !== "skipped") {
      const id = setInterval(load, 1500);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [runId, selectedStep, steps]);

  function handleSelectRun(id: string) {
    window.location.hash = `/workflow-runs/${id}`;
  }

  async function handleCancel() {
    if (!runId) return;
    await cancelWorkflowRun(runId);
  }

  return (
    <div className="config-layout">
      <nav className="config-sidebar">
        <div className="config-sidebar-header">
          <span>Recent runs</span>
          <a href="#/workflows" className="wf-runs-back-link" title="Back to workflow editor">
            ← Editor
          </a>
        </div>
        {runs.map((r) => (
          <button
            type="button"
            key={r.id}
            className={`config-sidebar-item${runId === r.id ? " active" : ""}`}
            onClick={() => handleSelectRun(r.id)}
          >
            <div className="run-list-name">
              <StatusBadge status={r.status} /> {r.workflow_name}
            </div>
            <div className="run-list-meta">{new Date(r.started_at).toLocaleString()}</div>
          </button>
        ))}
        {runs.length === 0 && <div className="empty-state">No runs yet.</div>}
      </nav>
      <div className="config-content">
        {!run && <div className="empty-state">Select a run to view details.</div>}
        {run && (
          <>
            <div className="config-header">
              <div>
                <h2>{run.workflow_name}</h2>
                <span className="config-path">
                  <StatusBadge status={run.status} /> {run.id}
                </span>
              </div>
              <div className="config-actions">
                {!TERMINAL.has(run.status) && (
                  <button type="button" className="btn-danger" onClick={handleCancel}>
                    Cancel run
                  </button>
                )}
              </div>
            </div>

            {run.error && <div className="config-error">{run.error}</div>}

            <PendingFormPanel
              runId={run.id}
              refreshKey={formsRefresh}
              onSubmitted={() => {
                setFormsRefresh((n) => n + 1);
                fetchWorkflowRun(run.id)
                  .then((data) => {
                    setRun(data.run);
                    setSteps(data.steps);
                  })
                  .catch(() => {});
              }}
            />

            <div className="run-detail-layout">
              <div className="run-steps-list">
                <h3>Steps ({steps.length})</h3>
                {steps.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    className={`run-step-row${selectedStep === s.step_name ? " active" : ""}`}
                    onClick={() => setSelectedStep(s.step_name)}
                  >
                    <StatusBadge status={s.status} />
                    <span className="run-step-name">{s.step_name}</span>
                    <span className="run-step-type">{s.step_type}</span>
                    {s.attempt > 1 && <span className="run-step-attempt">×{s.attempt}</span>}
                  </button>
                ))}
              </div>
              <div className="run-step-log">
                {selectedStep ? (
                  <>
                    <h3>{selectedStep} log</h3>
                    <pre className="run-step-log-body">{stepLog || "(empty)"}</pre>
                  </>
                ) : (
                  <div className="empty-state">Select a step to view its log.</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "running"
      ? "status-running"
      : status === "completed"
        ? "status-completed"
        : status === "failed"
          ? "status-failed"
          : status === "cancelled"
            ? "status-cancelled"
            : status === "skipped"
              ? "status-skipped"
              : "status-pending";
  return <span className={`run-status-badge ${cls}`}>{status}</span>;
}
