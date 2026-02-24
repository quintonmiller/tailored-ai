import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
import { InlinePermission } from "./PermissionRuleEditor";
const TOOL_DEFS = [
    { key: "memory", label: "Memory", fields: [] },
    {
        key: "exec",
        label: "Exec",
        fields: [
            { key: "allowedCommands", label: "Allowed Commands (comma-separated)", type: "list" },
        ],
    },
    {
        key: "read",
        label: "Read",
        fields: [
            { key: "allowedPaths", label: "Allowed Paths (comma-separated)", type: "list" },
        ],
    },
    {
        key: "write",
        label: "Write",
        fields: [
            { key: "allowedPaths", label: "Allowed Paths (comma-separated)", type: "list" },
        ],
    },
    { key: "web_fetch", label: "Web Fetch", fields: [] },
    {
        key: "web_search",
        label: "Web Search",
        fields: [
            { key: "provider", label: "Provider", type: "text", placeholder: "brave" },
            { key: "apiKey", label: "API Key", type: "password" },
            { key: "maxResults", label: "Max Results", type: "number", placeholder: "5" },
        ],
    },
    {
        key: "tasks",
        label: "Tasks",
        fields: [],
    },
    {
        key: "gmail",
        label: "Gmail",
        fields: [
            { key: "account", label: "Account", type: "text", placeholder: "user@gmail.com" },
        ],
    },
    {
        key: "google_calendar",
        label: "Google Calendar",
        fields: [
            { key: "account", label: "Account", type: "text", placeholder: "user@gmail.com" },
        ],
    },
    {
        key: "google_drive",
        label: "Google Drive",
        fields: [
            { key: "account", label: "Account", type: "text", placeholder: "user@gmail.com" },
            { key: "folder_name", label: "Folder Name", type: "text" },
            { key: "folder_id", label: "Folder ID", type: "text" },
        ],
    },
    {
        key: "claude_code",
        label: "Claude Code",
        fields: [
            { key: "model", label: "Model", type: "text", placeholder: "claude-sonnet-4-20250514" },
            { key: "maxTurns", label: "Max Turns", type: "number", placeholder: "10" },
            { key: "timeoutMs", label: "Timeout (ms)", type: "number", placeholder: "300000" },
            { key: "allowedTools", label: "Allowed Tools (comma-separated)", type: "list" },
            { key: "disallowedTools", label: "Disallowed Tools (comma-separated)", type: "list" },
        ],
    },
    {
        key: "browser",
        label: "Browser",
        fields: [
            { key: "headless", label: "Headless", type: "boolean" },
            { key: "screenshotDir", label: "Screenshot Directory", type: "text" },
            { key: "timeoutMs", label: "Timeout (ms)", type: "number" },
        ],
    },
    { key: "md_to_pdf", label: "Markdown to PDF", fields: [] },
    { key: "ask_user", label: "Ask User", fields: [] },
];
const PERMS_DEFAULTS = {
    defaultMode: "auto",
    timeoutMs: 300000,
    timeoutAction: "reject",
    tools: {},
};
export function ToolConfigEditor() {
    const [tools, setTools] = useState({});
    const [perms, setPerms] = useState(PERMS_DEFAULTS);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        Promise.all([
            fetchConfigSection("tools"),
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
            // Save both sections
            const hasPermsConfig = Object.keys(perms.tools).length > 0
                || perms.defaultMode !== "auto"
                || perms.timeoutMs !== 300000
                || perms.timeoutAction !== "reject";
            const [toolsResult, permsResult] = await Promise.all([
                saveConfigSection("tools", tools),
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
    function isEnabled(toolKey) {
        return tools[toolKey]?.enabled !== false && tools[toolKey]?.enabled !== undefined
            ? !!tools[toolKey]?.enabled
            : false;
    }
    function toggleEnabled(toolKey) {
        setTools((prev) => {
            const existing = prev[toolKey] ?? {};
            const wasEnabled = !!existing.enabled;
            return { ...prev, [toolKey]: { ...existing, enabled: !wasEnabled } };
        });
    }
    function getField(toolKey, fieldKey) {
        return tools[toolKey]?.[fieldKey];
    }
    function setField(toolKey, fieldKey, value) {
        setTools((prev) => ({
            ...prev,
            [toolKey]: { ...prev[toolKey], [fieldKey]: value },
        }));
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
    function renderField(toolKey, field) {
        const value = getField(toolKey, field.key);
        if (field.type === "boolean") {
            return (_jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${value ? "on" : "off"}`, onClick: () => setField(toolKey, field.key, !value), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: field.label })] }) }, field.key));
        }
        if (field.type === "list") {
            const arr = Array.isArray(value) ? value : [];
            return (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: field.label }), _jsx("input", { className: "field-input", value: arr.join(", "), onChange: (e) => {
                            const items = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                            setField(toolKey, field.key, items.length > 0 ? items : undefined);
                        }, placeholder: field.placeholder })] }, field.key));
        }
        return (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: field.label }), _jsx("input", { className: "field-input", type: field.type, value: value != null ? String(value) : "", onChange: (e) => {
                        const v = field.type === "number"
                            ? (e.target.value ? Number(e.target.value) : undefined)
                            : (e.target.value || undefined);
                        setField(toolKey, field.key, v);
                    }, placeholder: field.placeholder })] }, field.key));
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Tools" }) }), _jsx("div", { className: "skeleton-card", style: { height: 200 } })] }));
    }
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Tools" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsxs("div", { className: "section-card", children: [_jsx("div", { className: "section-card-header", children: _jsx("span", { className: "section-card-name", children: "Permission Defaults" }) }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Default Mode" }), _jsxs("select", { className: "field-select", value: perms.defaultMode, onChange: (e) => setPerms((p) => ({ ...p, defaultMode: e.target.value })), children: [_jsx("option", { value: "auto", children: "auto (allow all by default)" }), _jsx("option", { value: "approve", children: "approve (require approval by default)" })] })] }), _jsxs("div", { style: { display: "flex", gap: 12 }, children: [_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Approval Timeout" }), _jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [_jsx("input", { className: "field-input", type: "number", value: perms.timeoutMs, onChange: (e) => setPerms((p) => ({ ...p, timeoutMs: Number(e.target.value) || 0 })), placeholder: "300000", style: { maxWidth: 120 } }), _jsx("span", { style: { fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }, children: perms.timeoutMs > 0 ? `${(perms.timeoutMs / 1000).toFixed(0)}s` : "no timeout" })] })] }), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "On Timeout" }), _jsxs("select", { className: "field-select", value: perms.timeoutAction, onChange: (e) => setPerms((p) => ({ ...p, timeoutAction: e.target.value })), children: [_jsx("option", { value: "reject", children: "reject" }), _jsx("option", { value: "auto_approve", children: "auto_approve" })] })] })] })] }), TOOL_DEFS.map((def) => {
                const enabled = isEnabled(def.key);
                return (_jsxs("div", { className: "section-card", children: [_jsx("div", { className: "section-card-header", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${enabled ? "on" : "off"}`, onClick: () => toggleEnabled(def.key), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "section-card-name", children: def.label })] }) }), enabled && (_jsxs("div", { children: [def.fields.map((field) => renderField(def.key, field)), _jsx(InlinePermission, { toolName: def.key, config: perms.tools[def.key], defaultMode: perms.defaultMode, onChange: handlePermChange })] }))] }, def.key));
            })] }));
}
