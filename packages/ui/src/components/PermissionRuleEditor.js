import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function PermissionRuleEditor({ rule, onChange, onRemove }) {
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
        }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: matchEntries.length > 0 ? 6 : 0 }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [_jsxs("select", { className: "field-select", style: { width: "auto", minWidth: 100 }, value: rule.action, onChange: (e) => onChange({ ...rule, action: e.target.value }), children: [_jsx("option", { value: "auto", children: "auto" }), _jsx("option", { value: "approve", children: "approve" })] }), _jsx("span", { style: { fontSize: 11, color: "var(--text-dim)" }, children: isCatchAll ? "(catch-all)" : `when ${matchEntries.length} param${matchEntries.length > 1 ? "s" : ""} match` })] }), _jsx("button", { type: "button", className: "sub-item-remove", onClick: onRemove, children: "\u2715" })] }), matchEntries.map(([key, value], i) => (_jsxs("div", { className: "sub-item", children: [_jsx("input", { className: "field-input", style: { maxWidth: 120 }, value: key, onChange: (e) => setMatchParam(key, e.target.value, value), placeholder: "param" }), _jsx("span", { style: { color: "var(--text-dim)", fontSize: 12 }, children: "=~" }), _jsx("input", { className: "field-input", value: value, onChange: (e) => setMatchParam(key, key, e.target.value), placeholder: "regex pattern" }), _jsx("button", { type: "button", className: "sub-item-remove", onClick: () => removeMatchParam(key), children: "\u2715" })] }, i))), _jsx("button", { type: "button", style: {
                    background: "none",
                    border: "none",
                    color: "var(--text-dim)",
                    fontSize: 11,
                    cursor: "pointer",
                    padding: "2px 0",
                    fontFamily: "var(--font)",
                }, onClick: addMatchParam, children: "+ add match condition" })] }));
}
export function InlinePermission({ toolName, config, defaultMode, onChange }) {
    const mode = config?.mode ?? "default";
    function setMode(newMode) {
        if (newMode === "default") {
            onChange(toolName, undefined);
            return;
        }
        const m = newMode;
        if (m === "conditional") {
            onChange(toolName, { mode: m, rules: config?.rules ?? [{ match: {}, action: "approve" }] });
        }
        else {
            onChange(toolName, { mode: m });
        }
    }
    function updateRule(index, rule) {
        const rules = [...(config?.rules ?? [])];
        rules[index] = rule;
        onChange(toolName, { ...config, rules });
    }
    function addRule() {
        const rules = [...(config?.rules ?? []), { match: {}, action: "approve" }];
        onChange(toolName, { ...config, rules });
    }
    function removeRule(index) {
        const rules = (config?.rules ?? []).filter((_, i) => i !== index);
        onChange(toolName, { ...config, rules });
    }
    return (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Permission" }), _jsxs("select", { className: "field-select", value: mode, onChange: (e) => setMode(e.target.value), children: [_jsxs("option", { value: "default", children: ["default (", defaultMode, ")"] }), _jsx("option", { value: "auto", children: "auto (always allow)" }), _jsx("option", { value: "approve", children: "approve (always ask)" }), _jsx("option", { value: "conditional", children: "conditional (rule-based)" })] }), config?.mode === "conditional" && (_jsxs("div", { style: { marginTop: 8 }, children: [_jsx("label", { className: "field-label", style: { marginBottom: 6 }, children: "Rules (first match wins)" }), (config.rules ?? []).map((rule, i) => (_jsx(PermissionRuleEditor, { rule: rule, onChange: (r) => updateRule(i, r), onRemove: () => removeRule(i) }, i))), _jsx("button", { type: "button", className: "section-add-btn", style: { marginTop: 4 }, onClick: addRule, children: "+ Add Rule" })] }))] }));
}
