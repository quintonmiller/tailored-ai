import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { cancelWorkflowRun, fetchWorkflowRun, fetchWorkflowRuns, fetchWorkflowStepLog, } from "../api";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export function WorkflowRuns({ runId }) {
    const [runs, setRuns] = useState([]);
    const [run, setRun] = useState(null);
    const [steps, setSteps] = useState([]);
    const [selectedStep, setSelectedStep] = useState(null);
    const [stepLog, setStepLog] = useState("");
    const eventsRef = useRef(null);
    // Load list of runs
    useEffect(() => {
        let cancelled = false;
        function load() {
            fetchWorkflowRuns({ limit: 50 })
                .then((rows) => {
                if (!cancelled)
                    setRuns(rows);
            })
                .catch(() => { });
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
        if (!runId)
            return;
        fetchWorkflowRun(runId)
            .then((data) => {
            setRun(data.run);
            setSteps(data.steps);
            if (TERMINAL.has(data.run.status))
                return;
            const es = new EventSource(`/api/workflow-runs/${encodeURIComponent(runId)}/events`);
            eventsRef.current = es;
            es.addEventListener("snapshot", (ev) => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.run)
                        setRun(d.run);
                    if (d.steps)
                        setSteps(d.steps);
                }
                catch { }
            });
            const refresh = () => {
                fetchWorkflowRun(runId)
                    .then((data) => {
                    setRun(data.run);
                    setSteps(data.steps);
                })
                    .catch(() => { });
            };
            for (const t of ["step.started", "step.completed", "step.failed", "step.skipped", "run.started", "run.completed", "run.failed", "run.cancelled"]) {
                es.addEventListener(t, refresh);
            }
            es.onerror = () => {
                es.close();
            };
        })
            .catch(() => { });
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
            if (!runId || !selectedStep)
                return;
            fetchWorkflowStepLog(runId, selectedStep)
                .then((data) => {
                if (!cancelled)
                    setStepLog(data.content);
            })
                .catch((e) => {
                if (!cancelled)
                    setStepLog(`(no log: ${e.message})`);
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
    function handleSelectRun(id) {
        window.location.hash = `/workflow-runs/${id}`;
    }
    async function handleCancel() {
        if (!runId)
            return;
        await cancelWorkflowRun(runId);
    }
    return (_jsxs("div", { className: "config-layout", children: [_jsxs("nav", { className: "config-sidebar", children: [_jsx("div", { className: "config-sidebar-header", children: _jsx("span", { children: "Recent runs" }) }), runs.map((r) => (_jsxs("button", { type: "button", className: `config-sidebar-item${runId === r.id ? " active" : ""}`, onClick: () => handleSelectRun(r.id), children: [_jsxs("div", { className: "run-list-name", children: [_jsx(StatusBadge, { status: r.status }), " ", r.workflow_name] }), _jsx("div", { className: "run-list-meta", children: new Date(r.started_at).toLocaleString() })] }, r.id))), runs.length === 0 && _jsx("div", { className: "empty-state", children: "No runs yet." })] }), _jsxs("div", { className: "config-content", children: [!run && _jsx("div", { className: "empty-state", children: "Select a run to view details." }), run && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "config-header", children: [_jsxs("div", { children: [_jsx("h2", { children: run.workflow_name }), _jsxs("span", { className: "config-path", children: [_jsx(StatusBadge, { status: run.status }), " ", run.id] })] }), _jsx("div", { className: "config-actions", children: !TERMINAL.has(run.status) && (_jsx("button", { type: "button", className: "btn-danger", onClick: handleCancel, children: "Cancel run" })) })] }), run.error && _jsx("div", { className: "config-error", children: run.error }), _jsxs("div", { className: "run-detail-layout", children: [_jsxs("div", { className: "run-steps-list", children: [_jsxs("h3", { children: ["Steps (", steps.length, ")"] }), steps.map((s) => (_jsxs("button", { type: "button", className: `run-step-row${selectedStep === s.step_name ? " active" : ""}`, onClick: () => setSelectedStep(s.step_name), children: [_jsx(StatusBadge, { status: s.status }), _jsx("span", { className: "run-step-name", children: s.step_name }), _jsx("span", { className: "run-step-type", children: s.step_type }), s.attempt > 1 && _jsxs("span", { className: "run-step-attempt", children: ["\u00D7", s.attempt] })] }, s.id)))] }), _jsx("div", { className: "run-step-log", children: selectedStep ? (_jsxs(_Fragment, { children: [_jsxs("h3", { children: [selectedStep, " log"] }), _jsx("pre", { className: "run-step-log-body", children: stepLog || "(empty)" })] })) : (_jsx("div", { className: "empty-state", children: "Select a step to view its log." })) })] })] }))] })] }));
}
function StatusBadge({ status }) {
    const cls = status === "running"
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
    return _jsx("span", { className: `run-status-badge ${cls}`, children: status });
}
