import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { deleteWorkflow, fetchWorkflow, fetchWorkflows, runWorkflow, saveWorkflow, } from "../api";
import { blankStep, WorkflowStepEditor } from "../components/WorkflowStepEditor";
export function Workflows() {
    const [workflows, setWorkflows] = useState([]);
    const [errors, setErrors] = useState([]);
    const [selected, setSelected] = useState(null);
    const [editing, setEditing] = useState(null);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [reloadTick, setReloadTick] = useState(0);
    useEffect(() => {
        fetchWorkflows()
            .then((res) => {
            setWorkflows(res.workflows);
            setErrors(res.errors);
        })
            .catch(() => { });
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
        if (!name)
            return;
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
        if (!editing)
            return;
        setStatus({ type: "saving" });
        const result = await saveWorkflow(editing.name, { definition: editing });
        if (result.error) {
            setStatus({
                type: "error",
                message: result.details ? `${result.error}: ${result.details.join("; ")}` : result.error,
            });
        }
        else {
            setStatus({ type: "saved", message: "Saved" });
            setReloadTick((n) => n + 1);
            setTimeout(() => setStatus({ type: "idle" }), 2000);
        }
    }
    async function handleDelete() {
        if (!editing)
            return;
        if (!confirm(`Delete workflow "${editing.name}"?`))
            return;
        const result = await deleteWorkflow(editing.name);
        if (result.error) {
            setStatus({ type: "error", message: result.error });
        }
        else {
            setSelected(null);
            setEditing(null);
            setReloadTick((n) => n + 1);
        }
    }
    async function handleRun() {
        if (!editing)
            return;
        setStatus({ type: "saving", message: "Running..." });
        try {
            const run = await runWorkflow(editing.name);
            setStatus({ type: "saved", message: `Started ${run.id}` });
            window.location.hash = `/workflow-runs/${run.id}`;
        }
        catch (e) {
            setStatus({ type: "error", message: e.message });
        }
    }
    return (_jsxs("div", { className: "config-layout", children: [_jsxs("nav", { className: "config-sidebar", children: [_jsxs("div", { className: "config-sidebar-header", children: [_jsxs("span", { children: ["Workflows (", workflows.length, ")"] }), _jsx("button", { type: "button", className: "btn-secondary", onClick: handleNew, children: "+ New" })] }), workflows.map((w) => (_jsxs("button", { type: "button", className: `config-sidebar-item${selected === w.name ? " active" : ""}`, onClick: () => setSelected(w.name), children: [_jsx("div", { className: "workflow-list-name", children: w.name }), _jsxs("div", { className: "workflow-list-meta", children: [w.stepCount, " steps \u00B7 ", w.source] })] }, w.name))), errors.length > 0 && (_jsxs("div", { className: "workflow-errors", children: [_jsx("div", { className: "workflow-errors-header", children: "Load errors" }), errors.map((e, i) => (_jsxs("div", { className: "workflow-error-row", title: e.path, children: [e.path.split("/").pop(), ": ", e.error] }, i)))] }))] }), _jsxs("div", { className: "config-content", children: [!editing && (_jsx("div", { className: "empty-state", children: "Select a workflow to edit, or create a new one." })), editing && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "config-header", children: [_jsxs("div", { children: [_jsx("h2", { children: editing.name }), _jsxs("span", { className: "config-path", children: [editing.steps.length, " steps"] })] }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "btn-secondary", onClick: handleRun, disabled: status.type === "saving", children: "Run" }), _jsx("button", { type: "button", className: "btn-danger", onClick: handleDelete, children: "Delete" }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Description" }), _jsx("input", { className: "field-input", value: editing.description ?? "", onChange: (e) => setEditing({ ...editing, description: e.target.value }) })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "deadlineMs (optional)" }), _jsx("input", { className: "field-input", type: "number", value: editing.deadlineMs ?? "", onChange: (e) => setEditing({
                                                    ...editing,
                                                    deadlineMs: e.target.value ? Number(e.target.value) : undefined,
                                                }) })] })] }), _jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Steps" }), _jsx("button", { type: "button", className: "btn-secondary", onClick: () => setEditing({ ...editing, steps: [...editing.steps, blankStep("agent_run")] }), children: "+ Add step" })] }), _jsx("div", { className: "workflow-steps", children: editing.steps.map((s, idx) => (_jsx(WorkflowStepEditor, { step: s, onChange: (next) => setEditing({
                                                ...editing,
                                                steps: editing.steps.map((cur, i) => (i === idx ? next : cur)),
                                            }), onRemove: () => setEditing({
                                                ...editing,
                                                steps: editing.steps.filter((_, i) => i !== idx),
                                            }), onMoveUp: idx > 0
                                                ? () => {
                                                    const copy = [...editing.steps];
                                                    [copy[idx], copy[idx - 1]] = [copy[idx - 1], copy[idx]];
                                                    setEditing({ ...editing, steps: copy });
                                                }
                                                : undefined, onMoveDown: idx < editing.steps.length - 1
                                                ? () => {
                                                    const copy = [...editing.steps];
                                                    [copy[idx], copy[idx + 1]] = [copy[idx + 1], copy[idx]];
                                                    setEditing({ ...editing, steps: copy });
                                                }
                                                : undefined }, idx))) })] })] }))] })] }));
}
