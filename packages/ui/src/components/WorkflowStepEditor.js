import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
const STEP_TYPES = [
    "agent_run",
    "tool_call",
    "shell",
    "condition",
    "loop",
    "parallel",
];
const ON_ERROR = ["fail", "continue", "retry"];
export function WorkflowStepEditor({ step, onChange, onRemove, onMoveUp, onMoveDown, depth = 0 }) {
    function update(key, value) {
        onChange({ ...step, [key]: value });
    }
    return (_jsxs("div", { className: "workflow-step", style: { marginLeft: depth * 16 }, children: [_jsxs("div", { className: "workflow-step-header", children: [_jsx("input", { className: "field-input workflow-step-name", value: step.name, onChange: (e) => update("name", e.target.value), placeholder: "step name" }), _jsx("select", { className: "field-select", value: step.type, onChange: (e) => onChange(changeStepType(step, e.target.value)), children: STEP_TYPES.map((t) => (_jsx("option", { value: t, children: t }, t))) }), _jsxs("div", { className: "workflow-step-actions", children: [onMoveUp && (_jsx("button", { type: "button", className: "btn-ghost", onClick: onMoveUp, title: "Move up", children: "\u2191" })), onMoveDown && (_jsx("button", { type: "button", className: "btn-ghost", onClick: onMoveDown, title: "Move down", children: "\u2193" })), _jsx("button", { type: "button", className: "btn-danger-ghost", onClick: onRemove, title: "Remove step", children: "\u00D7" })] })] }), _jsxs("div", { className: "workflow-step-body", children: [renderTypeFields(step, update, depth), _jsxs("details", { className: "workflow-step-advanced", children: [_jsx("summary", { children: "Advanced" }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "onError" }), _jsx("select", { className: "field-select", value: step.onError ?? "fail", onChange: (e) => update("onError", e.target.value), children: ON_ERROR.map((v) => (_jsx("option", { value: v, children: v }, v))) })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "deadlineMs" }), _jsx("input", { className: "field-input", type: "number", value: step.deadlineMs ?? "", onChange: (e) => update("deadlineMs", e.target.value ? Number(e.target.value) : undefined), placeholder: "(none)" })] }), step.onError === "retry" && (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "retry.maxAttempts" }), _jsx("input", { className: "field-input", type: "number", min: 1, value: step.retry?.maxAttempts ?? 1, onChange: (e) => update("retry", {
                                            maxAttempts: Number(e.target.value) || 1,
                                            backoffMs: step.retry?.backoffMs,
                                        }) }), _jsx("label", { className: "field-label", children: "retry.backoffMs" }), _jsx("input", { className: "field-input", type: "number", min: 0, value: step.retry?.backoffMs ?? "", onChange: (e) => update("retry", {
                                            maxAttempts: step.retry?.maxAttempts ?? 1,
                                            backoffMs: e.target.value ? Number(e.target.value) : undefined,
                                        }), placeholder: "(default)" })] }))] })] })] }));
}
function renderTypeFields(step, update, depth) {
    switch (step.type) {
        case "agent_run":
            return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Agent" }), _jsx("input", { className: "field-input", value: step.agent ?? "", onChange: (e) => update("agent", e.target.value), placeholder: "agent name" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Prompt" }), _jsx("textarea", { className: "field-textarea", rows: 3, value: step.prompt ?? "", onChange: (e) => update("prompt", e.target.value) })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "maxToolRounds (optional)" }), _jsx("input", { className: "field-input", type: "number", value: step.maxToolRounds ?? "", onChange: (e) => update("maxToolRounds", e.target.value ? Number(e.target.value) : undefined) })] })] }));
        case "tool_call":
            return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Tool" }), _jsx("input", { className: "field-input", value: step.tool ?? "", onChange: (e) => update("tool", e.target.value), placeholder: "tool name" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Args (JSON)" }), _jsx("textarea", { className: "field-textarea", rows: 4, value: step.args ? JSON.stringify(step.args, null, 2) : "", onChange: (e) => {
                                    const text = e.target.value;
                                    try {
                                        update("args", text.trim() ? JSON.parse(text) : undefined);
                                    }
                                    catch {
                                        // Keep typing — invalid JSON is allowed mid-edit; we'll catch it on save.
                                    }
                                }, placeholder: '{"key": "value"}' })] })] }));
        case "shell":
            return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Command" }), _jsx("textarea", { className: "field-textarea", rows: 3, value: step.command ?? "", onChange: (e) => update("command", e.target.value), placeholder: "echo hello" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "cwd (optional)" }), _jsx("input", { className: "field-input", value: step.cwd ?? "", onChange: (e) => update("cwd", e.target.value || undefined) })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "timeoutMs (optional)" }), _jsx("input", { className: "field-input", type: "number", value: step.timeoutMs ?? "", onChange: (e) => update("timeoutMs", e.target.value ? Number(e.target.value) : undefined) })] })] }));
        case "condition":
            return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "if (expression)" }), _jsx("input", { className: "field-input", value: step.if ?? "", onChange: (e) => update("if", e.target.value), placeholder: "steps.foo.output.success" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "then (step names, comma-separated)" }), _jsx("input", { className: "field-input", value: (step.then ?? []).join(", "), onChange: (e) => update("then", e.target.value
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean)) })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "else (step names, comma-separated)" }), _jsx("input", { className: "field-input", value: (step.else ?? []).join(", "), onChange: (e) => update("else", e.target.value
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean)) })] })] }));
        case "loop":
            return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "over (expression)" }), _jsx("input", { className: "field-input", value: step.over ?? "", onChange: (e) => update("over", e.target.value), placeholder: "steps.previous.output.items" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "as (variable name)" }), _jsx("input", { className: "field-input", value: step.as ?? "", onChange: (e) => update("as", e.target.value), placeholder: "item" })] }), _jsxs("div", { className: "field-group", children: [_jsxs("label", { className: "field-row", children: [_jsx("input", { type: "checkbox", checked: step.parallel === true, onChange: (e) => update("parallel", e.target.checked) }), _jsx("span", { className: "field-inline-label", children: "parallel" })] }), step.parallel && (_jsxs(_Fragment, { children: [_jsx("label", { className: "field-label", children: "maxConcurrency" }), _jsx("input", { className: "field-input", type: "number", value: step.maxConcurrency ?? "", onChange: (e) => update("maxConcurrency", e.target.value ? Number(e.target.value) : undefined) })] }))] }), _jsx(NestedStepList, { label: "body", steps: step.body ?? [], depth: depth + 1, onChange: (next) => update("body", next) })] }));
        case "parallel":
            return (_jsx(NestedStepList, { label: "steps", steps: step.steps ?? [], depth: depth + 1, onChange: (next) => update("steps", next) }));
    }
}
function NestedStepList({ label, steps, onChange, depth }) {
    function update(idx, next) {
        onChange(steps.map((s, i) => (i === idx ? next : s)));
    }
    function remove(idx) {
        onChange(steps.filter((_, i) => i !== idx));
    }
    function move(idx, dir) {
        const target = idx + dir;
        if (target < 0 || target >= steps.length)
            return;
        const copy = [...steps];
        [copy[idx], copy[target]] = [copy[target], copy[idx]];
        onChange(copy);
    }
    function add() {
        onChange([...steps, blankStep("agent_run")]);
    }
    return (_jsxs("div", { className: "workflow-nested", children: [_jsxs("div", { className: "workflow-nested-header", children: [_jsxs("span", { children: [label, " (", steps.length, ")"] }), _jsx("button", { type: "button", className: "btn-secondary", onClick: add, children: "+ Add" })] }), steps.map((s, idx) => (_jsx(WorkflowStepEditor, { step: s, depth: depth, onChange: (next) => update(idx, next), onRemove: () => remove(idx), onMoveUp: idx > 0 ? () => move(idx, -1) : undefined, onMoveDown: idx < steps.length - 1 ? () => move(idx, 1) : undefined }, idx)))] }));
}
export function blankStep(type) {
    const base = { name: `step_${Math.random().toString(36).slice(2, 6)}`, type };
    switch (type) {
        case "agent_run":
            return { ...base, agent: "primary", prompt: "" };
        case "tool_call":
            return { ...base, tool: "" };
        case "shell":
            return { ...base, command: "" };
        case "condition":
            return { ...base, if: "" };
        case "loop":
            return { ...base, over: "", as: "item", body: [] };
        case "parallel":
            return { ...base, steps: [] };
    }
}
function changeStepType(prev, type) {
    // Preserve name + advanced fields, reset type-specific fields.
    const next = blankStep(type);
    next.name = prev.name;
    next.deadlineMs = prev.deadlineMs;
    next.onError = prev.onError;
    next.retry = prev.retry;
    return next;
}
