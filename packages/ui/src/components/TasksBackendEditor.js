import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
const DEFAULTS = { backend: "native" };
export function TasksBackendEditor() {
    const [data, setData] = useState(DEFAULTS);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchConfigSection("tasks")
            .then((res) => {
            if (res.data)
                setData({ ...DEFAULTS, ...res.data });
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);
    async function handleSave() {
        setStatus({ type: "saving" });
        const result = await saveConfigSection("tasks", data);
        if (result.error) {
            setStatus({ type: "error", message: result.error });
        }
        else {
            setStatus({ type: "saved", message: "Saved" });
            setTimeout(() => setStatus({ type: "idle" }), 2500);
        }
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Task Backend" }) }), _jsx("div", { className: "skeleton-card", style: { height: 120 } })] }));
    }
    const backend = data.backend ?? "native";
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Task Backend" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Backend" }), _jsxs("select", { className: "field-select", value: backend, onChange: (e) => setData((p) => ({ ...p, backend: e.target.value })), children: [_jsx("option", { value: "native", children: "native (SQLite)" }), _jsx("option", { value: "github", children: "github (Issues)" }), _jsx("option", { value: "beans", children: "beans (CLI)" }), _jsx("option", { value: "beads", children: "beads (CLI)" })] }), _jsx("span", { className: "field-hint", children: "Determines where project tasks and the autopilot read/write. Switching backends requires a server restart for some integrations." })] }), backend === "github" && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Repo" }), _jsx("input", { className: "field-input", value: data.github?.repo ?? "", onChange: (e) => setData((p) => ({ ...p, github: { ...p.github, repo: e.target.value } })), placeholder: "owner/repo" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Token" }), _jsx("input", { className: "field-input", value: data.github?.token ?? "", onChange: (e) => setData((p) => ({ ...p, github: { ...p.github, token: e.target.value } })), placeholder: "${GITHUB_TOKEN}" }), _jsxs("span", { className: "field-hint", children: ["Use $", "${GITHUB_TOKEN}", " to interpolate from env."] })] })] })), backend === "beans" && (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "beans path" }), _jsx("input", { className: "field-input", value: data.beans?.path ?? "", onChange: (e) => setData((p) => ({ ...p, beans: { ...p.beans, path: e.target.value } })), placeholder: "./.beans" })] })), backend === "beads" && (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "beads path" }), _jsx("input", { className: "field-input", value: data.beads?.path ?? "", onChange: (e) => setData((p) => ({ ...p, beads: { ...p.beads, path: e.target.value } })), placeholder: "./.beads" }), _jsxs("span", { className: "field-hint", children: ["Run ", _jsx("code", { children: "bd init" }), " in this directory before use."] })] }))] })] }));
}
