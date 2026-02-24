import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
import { InlinePermission } from "./PermissionRuleEditor";
const PERMS_DEFAULTS = {
    defaultMode: "auto",
    timeoutMs: 300000,
    timeoutAction: "reject",
    tools: {},
};
export function CustomToolEditor() {
    const [tools, setTools] = useState({});
    const [perms, setPerms] = useState(PERMS_DEFAULTS);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        Promise.all([
            fetchConfigSection("custom_tools"),
            fetchConfigSection("permissions"),
        ])
            .then(([toolsRes, permsRes]) => {
            if (toolsRes.data)
                setTools(toolsRes.data);
            if (permsRes.data)
                setPerms({ ...PERMS_DEFAULTS, ...permsRes.data, tools: permsRes.data.tools ?? {} });
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            const hasPermsConfig = Object.keys(perms.tools).length > 0
                || perms.defaultMode !== "auto"
                || perms.timeoutMs !== 300000
                || perms.timeoutAction !== "reject";
            const [toolsResult, permsResult] = await Promise.all([
                saveConfigSection("custom_tools", tools),
                saveConfigSection("permissions", hasPermsConfig ? perms : null),
            ]);
            const error = toolsResult.error || permsResult.error;
            if (error) {
                setStatus({ type: "error", message: error });
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
    function addTool() {
        const name = `tool_${Date.now()}`;
        setTools((prev) => ({
            ...prev,
            [name]: { description: "", command: "", parameters: {} },
        }));
    }
    function removeTool(name) {
        setTools((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
        // Also clean up any permission config for this tool
        setPerms((prev) => {
            if (!(name in prev.tools))
                return prev;
            const { [name]: _, ...rest } = prev.tools;
            return { ...prev, tools: rest };
        });
    }
    function renameTool(oldName, newName) {
        if (newName === oldName || !newName.trim())
            return;
        setTools((prev) => {
            const next = {};
            for (const [k, v] of Object.entries(prev)) {
                next[k === oldName ? newName : k] = v;
            }
            return next;
        });
        // Rename permission config too
        setPerms((prev) => {
            if (!(oldName in prev.tools))
                return prev;
            const { [oldName]: config, ...rest } = prev.tools;
            return { ...prev, tools: { ...rest, [newName]: config } };
        });
    }
    function updateTool(name, field, value) {
        setTools((prev) => ({
            ...prev,
            [name]: { ...prev[name], [field]: value },
        }));
    }
    function addParam(toolName) {
        const paramName = `param_${Object.keys(tools[toolName].parameters).length + 1}`;
        updateTool(toolName, "parameters", {
            ...tools[toolName].parameters,
            [paramName]: { type: "string", description: "" },
        });
    }
    function removeParam(toolName, paramName) {
        const params = { ...tools[toolName].parameters };
        delete params[paramName];
        updateTool(toolName, "parameters", params);
    }
    function renameParam(toolName, oldName, newName) {
        if (newName === oldName || !newName.trim())
            return;
        const params = {};
        for (const [k, v] of Object.entries(tools[toolName].parameters)) {
            params[k === oldName ? newName : k] = v;
        }
        updateTool(toolName, "parameters", params);
    }
    function updateParam(toolName, paramName, field, value) {
        updateTool(toolName, "parameters", {
            ...tools[toolName].parameters,
            [paramName]: { ...tools[toolName].parameters[paramName], [field]: value },
        });
    }
    function handlePermChange(toolName, config) {
        setPerms((prev) => {
            const next = { ...prev, tools: { ...prev.tools } };
            if (config) {
                next.tools[toolName] = config;
            }
            else {
                delete next.tools[toolName];
            }
            return next;
        });
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Custom Tools" }) }), _jsx("div", { className: "skeleton-card", style: { height: 120 } })] }));
    }
    const toolEntries = Object.entries(tools);
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Custom Tools" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), toolEntries.length === 0 && (_jsx("p", { style: { color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }, children: "No custom tools defined." })), toolEntries.map(([name, tool]) => (_jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "section-card-header", children: [_jsx("input", { className: "field-input", style: { maxWidth: 200, fontWeight: 600, color: "var(--accent)" }, value: name, onChange: (e) => renameTool(name, e.target.value) }), _jsx("button", { type: "button", className: "section-card-remove", onClick: () => removeTool(name), children: "\u2715" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Description" }), _jsx("input", { className: "field-input", value: tool.description, onChange: (e) => updateTool(name, "description", e.target.value) })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Command" }), _jsx("input", { className: "field-input", value: tool.command, onChange: (e) => updateTool(name, "command", e.target.value), placeholder: "echo Hello {{name}}" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Timeout (ms)" }), _jsx("input", { className: "field-input", type: "number", value: tool.timeout_ms ?? "", onChange: (e) => updateTool(name, "timeout_ms", e.target.value ? Number(e.target.value) : undefined), placeholder: "30000", style: { maxWidth: 150 } })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Parameters" }), Object.entries(tool.parameters).map(([pName, param]) => (_jsxs("div", { className: "sub-item", children: [_jsx("input", { className: "field-input", style: { maxWidth: 120 }, value: pName, onChange: (e) => renameParam(name, pName, e.target.value), placeholder: "name" }), _jsxs("select", { className: "field-select", style: { maxWidth: 100 }, value: param.type, onChange: (e) => updateParam(name, pName, "type", e.target.value), children: [_jsx("option", { value: "string", children: "string" }), _jsx("option", { value: "number", children: "number" }), _jsx("option", { value: "boolean", children: "boolean" })] }), _jsx("input", { className: "field-input", value: param.description, onChange: (e) => updateParam(name, pName, "description", e.target.value), placeholder: "description" }), _jsx("button", { type: "button", className: "sub-item-remove", onClick: () => removeParam(name, pName), children: "\u2715" })] }, pName))), _jsx("button", { type: "button", className: "section-add-btn", style: { marginTop: 4 }, onClick: () => addParam(name), children: "+ Add Parameter" })] }), _jsx(InlinePermission, { toolName: name, config: perms.tools[name], defaultMode: perms.defaultMode, onChange: handlePermChange })] }, name))), _jsx("button", { type: "button", className: "section-add-btn", onClick: addTool, children: "+ Add Custom Tool" })] }));
}
