import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, fetchTools, saveConfigSection } from "../api";
const DEFAULTS = {
    defaultMode: "auto",
    timeoutMs: 300000,
    timeoutAction: "reject",
    tools: {},
};
export function PermissionsEditor() {
    const [data, setData] = useState(DEFAULTS);
    const [availableTools, setAvailableTools] = useState([]);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        Promise.all([
            fetchConfigSection("permissions"),
            fetchTools(),
        ])
            .then(([res, tools]) => {
            if (res.data) {
                setData({ ...DEFAULTS, ...res.data, tools: res.data.tools ?? {} });
            }
            setAvailableTools(tools.map((t) => t.name).sort());
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            // Only save permissions if there's actual config (don't save empty defaults)
            const hasConfig = Object.keys(data.tools).length > 0
                || data.defaultMode !== "auto"
                || data.timeoutMs !== 300000
                || data.timeoutAction !== "reject";
            const result = await saveConfigSection("permissions", hasConfig ? data : null);
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
    function setToolConfig(toolName, config) {
        setData((prev) => ({
            ...prev,
            tools: { ...prev.tools, [toolName]: config },
        }));
    }
    function removeToolConfig(toolName) {
        setData((prev) => {
            const { [toolName]: _, ...rest } = prev.tools;
            return { ...prev, tools: rest };
        });
    }
    function addToolConfig() {
        // Find a tool not yet configured
        const unconfigured = availableTools.filter((t) => !(t in data.tools));
        if (unconfigured.length === 0)
            return;
        setToolConfig(unconfigured[0], { mode: "auto" });
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Permissions" }) }), _jsx("div", { className: "skeleton-card", style: { height: 200 } })] }));
    }
    const configuredTools = Object.keys(data.tools).sort();
    const unconfiguredTools = availableTools.filter((t) => !(t in data.tools));
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Permissions" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsxs("div", { className: "section-card", children: [_jsx("div", { className: "section-card-header", children: _jsx("span", { className: "section-card-name", children: "Global Settings" }) }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Default Mode" }), _jsxs("select", { className: "field-select", value: data.defaultMode, onChange: (e) => setData((p) => ({ ...p, defaultMode: e.target.value })), children: [_jsx("option", { value: "auto", children: "auto (allow all by default)" }), _jsx("option", { value: "approve", children: "approve (require approval by default)" })] })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Timeout (ms)" }), _jsx("input", { className: "field-input", type: "number", value: data.timeoutMs, onChange: (e) => setData((p) => ({ ...p, timeoutMs: Number(e.target.value) || 0 })), placeholder: "300000" }), _jsx("span", { style: { fontSize: 11, color: "var(--text-dim)" }, children: data.timeoutMs > 0 ? `${(data.timeoutMs / 1000).toFixed(0)}s` : "no timeout (wait forever)" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Timeout Action" }), _jsxs("select", { className: "field-select", value: data.timeoutAction, onChange: (e) => setData((p) => ({ ...p, timeoutAction: e.target.value })), children: [_jsx("option", { value: "reject", children: "reject" }), _jsx("option", { value: "auto_approve", children: "auto_approve" })] })] })] }), _jsx("h4", { className: "provider-section-title", style: { marginTop: 16 }, children: "Per-Tool Permissions" }), configuredTools.length === 0 && (_jsx("p", { style: { color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }, children: "No per-tool permissions configured. All tools use the default mode." })), configuredTools.map((toolName) => (_jsx(ToolPermissionCard, { toolName: toolName, config: data.tools[toolName], allToolNames: availableTools, unconfiguredTools: unconfiguredTools, onChange: (config) => setToolConfig(toolName, config), onRemove: () => removeToolConfig(toolName), onRename: (newName) => {
                    const config = data.tools[toolName];
                    removeToolConfig(toolName);
                    setToolConfig(newName, config);
                } }, toolName))), unconfiguredTools.length > 0 && (_jsx("button", { type: "button", className: "section-add-btn", onClick: addToolConfig, children: "+ Add Tool Permission" }))] }));
}
function ToolPermissionCard({ toolName, config, unconfiguredTools, onChange, onRemove, onRename, }) {
    function setMode(mode) {
        if (mode === "conditional") {
            onChange({ ...config, mode, rules: config.rules ?? [{ match: {}, action: "approve" }] });
        }
        else {
            onChange({ ...config, mode });
        }
    }
    function updateRule(index, rule) {
        const rules = [...(config.rules ?? [])];
        rules[index] = rule;
        onChange({ ...config, rules });
    }
    function addRule() {
        const rules = [...(config.rules ?? []), { match: {}, action: "approve" }];
        onChange({ ...config, rules });
    }
    function removeRule(index) {
        const rules = (config.rules ?? []).filter((_, i) => i !== index);
        onChange({ ...config, rules });
    }
    // Options for the tool name selector: current name + unconfigured tools
    const nameOptions = [toolName, ...unconfiguredTools];
    return (_jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "section-card-header", children: [_jsx("select", { className: "field-select", style: { width: "auto", minWidth: 140, fontWeight: 600, color: "var(--accent)", fontSize: 14 }, value: toolName, onChange: (e) => onRename(e.target.value), children: nameOptions.map((n) => (_jsx("option", { value: n, children: n }, n))) }), _jsx("button", { type: "button", className: "section-card-remove", onClick: onRemove, children: "\u2715" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Mode" }), _jsxs("select", { className: "field-select", value: config.mode, onChange: (e) => setMode(e.target.value), children: [_jsx("option", { value: "auto", children: "auto (always allow)" }), _jsx("option", { value: "approve", children: "approve (always ask)" }), _jsx("option", { value: "conditional", children: "conditional (rule-based)" })] })] }), config.mode === "conditional" && (_jsxs("div", { style: { marginTop: 8 }, children: [_jsx("label", { className: "field-label", style: { marginBottom: 8 }, children: "Rules (first match wins)" }), (config.rules ?? []).map((rule, i) => (_jsx(RuleEditor, { rule: rule, onChange: (r) => updateRule(i, r), onRemove: () => removeRule(i) }, i))), _jsx("button", { type: "button", className: "section-add-btn", style: { marginTop: 4 }, onClick: addRule, children: "+ Add Rule" })] }))] }));
}
function RuleEditor({ rule, onChange, onRemove }) {
    const matchEntries = Object.entries(rule.match);
    const isCatchAll = matchEntries.length === 0;
    function setMatchParam(oldKey, newKey, value) {
        const match = { ...rule.match };
        if (oldKey !== newKey)
            delete match[oldKey];
        match[newKey] = value;
        onChange({ ...rule, match });
    }
    function removeMatchParam(key) {
        const { [key]: _, ...rest } = rule.match;
        onChange({ ...rule, match: rest });
    }
    function addMatchParam() {
        onChange({ ...rule, match: { ...rule.match, "": "" } });
    }
    return (_jsxs("div", { style: {
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "8px 10px",
            marginBottom: 6,
        }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [_jsxs("select", { className: "field-select", style: { width: "auto", minWidth: 100 }, value: rule.action, onChange: (e) => onChange({ ...rule, action: e.target.value }), children: [_jsx("option", { value: "auto", children: "auto" }), _jsx("option", { value: "approve", children: "approve" })] }), _jsx("span", { style: { fontSize: 11, color: "var(--text-dim)" }, children: isCatchAll ? "(catch-all)" : `when ${matchEntries.length} param${matchEntries.length > 1 ? "s" : ""} match` })] }), _jsx("button", { type: "button", className: "sub-item-remove", onClick: onRemove, children: "\u2715" })] }), matchEntries.map(([key, value], i) => (_jsxs("div", { className: "sub-item", children: [_jsx("input", { className: "field-input", style: { maxWidth: 120 }, value: key, onChange: (e) => setMatchParam(key, e.target.value, value), placeholder: "param" }), _jsx("span", { style: { color: "var(--text-dim)", fontSize: 12 }, children: "=~" }), _jsx("input", { className: "field-input", value: value, onChange: (e) => setMatchParam(key, key, e.target.value), placeholder: "regex pattern" }), _jsx("button", { type: "button", className: "sub-item-remove", onClick: () => removeMatchParam(key), children: "\u2715" })] }, i))), _jsx("button", { type: "button", style: {
                    background: "none",
                    border: "none",
                    color: "var(--text-dim)",
                    fontSize: 11,
                    cursor: "pointer",
                    padding: "2px 0",
                    fontFamily: "var(--font)",
                }, onClick: addMatchParam, children: "+ add match condition" })] }));
}
