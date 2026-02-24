import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
export function CommandEditor() {
    const [commands, setCommands] = useState({});
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchConfigSection("commands")
            .then((res) => {
            if (res.data)
                setCommands(res.data);
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            const result = await saveConfigSection("commands", commands);
            if (result.error) {
                setStatus({ type: "error", message: result.error });
            }
            else {
                setStatus({ type: "saved", message: "Saved" });
                setTimeout(() => setStatus({ type: "idle" }), 3000);
            }
        }
        catch (e) {
            setStatus({ type: "error", message: e.message });
        }
    }
    function addCommand() {
        const name = `cmd_${Date.now()}`;
        setCommands((prev) => ({
            ...prev,
            [name]: { description: "" },
        }));
    }
    function removeCommand(name) {
        setCommands((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
    }
    function renameCommand(oldName, newName) {
        if (newName === oldName || !newName.trim())
            return;
        setCommands((prev) => {
            const next = {};
            for (const [k, v] of Object.entries(prev)) {
                next[k === oldName ? newName : k] = v;
            }
            return next;
        });
    }
    function updateCommand(name, field, value) {
        setCommands((prev) => ({
            ...prev,
            [name]: { ...prev[name], [field]: value },
        }));
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Commands" }) }), _jsx("div", { className: "skeleton-card", style: { height: 120 } })] }));
    }
    const entries = Object.entries(commands);
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Commands" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), entries.length === 0 && (_jsx("p", { style: { color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }, children: "No custom commands defined." })), entries.map(([name, cmd]) => (_jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "section-card-header", children: [_jsx("input", { className: "field-input", style: { maxWidth: 200, fontWeight: 600, color: "var(--accent)" }, value: name, onChange: (e) => renameCommand(name, e.target.value) }), _jsx("button", { type: "button", className: "section-card-remove", onClick: () => removeCommand(name), children: "\u2715" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Description" }), _jsx("input", { className: "field-input", value: cmd.description, onChange: (e) => updateCommand(name, "description", e.target.value) })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Shell Command" }), _jsx("input", { className: "field-input", value: cmd.command ?? "", onChange: (e) => updateCommand(name, "command", e.target.value || undefined), placeholder: "shell command template (optional)" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Prompt" }), _jsx("textarea", { className: "field-textarea", value: cmd.prompt ?? "", onChange: (e) => updateCommand(name, "prompt", e.target.value || undefined), placeholder: "Agent prompt template (optional)" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Profile" }), _jsx("input", { className: "field-input", value: cmd.profile ?? "", onChange: (e) => updateCommand(name, "profile", e.target.value || undefined), placeholder: "(optional)" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Timeout (ms)" }), _jsx("input", { className: "field-input", type: "number", value: cmd.timeout_ms ?? "", onChange: (e) => updateCommand(name, "timeout_ms", e.target.value ? Number(e.target.value) : undefined), placeholder: "30000", style: { maxWidth: 150 } })] }), _jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${cmd.new_session ? "on" : "off"}`, onClick: () => updateCommand(name, "new_session", !cmd.new_session), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "New Session" })] }) })] }, name))), _jsx("button", { type: "button", className: "section-add-btn", onClick: addCommand, children: "+ Add Command" })] }));
}
