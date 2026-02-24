import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
const DEFAULTS = {
    enabled: false,
    prompt: "Task {{action}}: {{task_title}} ({{task_id}}), status: {{task_status}}. {{task_description}}",
    debounceMs: 5000,
    triggers: ["created", "updated"],
};
const ALL_TRIGGERS = ["created", "updated", "commented"];
const DELIVERY_CHANNELS = ["log", "discord", "discord-dm"];
export function TaskWatcherEditor() {
    const [data, setData] = useState(DEFAULTS);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchConfigSection("task_watcher")
            .then((res) => {
            if (res.data)
                setData({ ...DEFAULTS, ...res.data, triggers: res.data.triggers ?? DEFAULTS.triggers });
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            const result = await saveConfigSection("task_watcher", data);
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
    function toggleTrigger(trigger) {
        setData((prev) => {
            const has = prev.triggers.includes(trigger);
            return {
                ...prev,
                triggers: has ? prev.triggers.filter((t) => t !== trigger) : [...prev.triggers, trigger],
            };
        });
    }
    const deliveryChannel = data.delivery?.channel ?? "log";
    const needsTarget = deliveryChannel === "discord" || deliveryChannel === "discord-dm";
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Task Watcher" }) }), _jsx("div", { className: "skeleton-card", style: { height: 120 } })] }));
    }
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Task Watcher" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsxs("div", { className: "section-card", children: [_jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${data.enabled ? "on" : "off"}`, onClick: () => setData((p) => ({ ...p, enabled: !p.enabled })), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Enabled" })] }) }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Profile" }), _jsx("input", { className: "field-input", value: data.profile ?? "", onChange: (e) => setData((p) => ({ ...p, profile: e.target.value || undefined })), placeholder: "(empty = primary agent)" }), _jsx("span", { className: "field-hint", children: "When set, uses a dedicated agent with its own session. When empty, shares the primary agent's session." })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Prompt Template" }), _jsx("textarea", { className: "field-textarea", value: data.prompt, onChange: (e) => setData((p) => ({ ...p, prompt: e.target.value })), placeholder: DEFAULTS.prompt, rows: 3 }), _jsxs("span", { className: "field-hint", children: ["Variables: ", "{{action}}", ", ", "{{task_id}}", ", ", "{{task_title}}", ", ", "{{task_status}}", ", ", "{{task_description}}", ", ", "{{task_author}}", ", ", "{{task_tags}}"] })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Debounce (ms)" }), _jsx("input", { className: "field-input", type: "number", value: data.debounceMs, onChange: (e) => setData((p) => ({ ...p, debounceMs: Number.parseInt(e.target.value, 10) || 0 })), min: 0, step: 1000 })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Triggers" }), _jsx("div", { className: "field-row", style: { gap: 12 }, children: ALL_TRIGGERS.map((trigger) => (_jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }, children: [_jsx("input", { type: "checkbox", checked: data.triggers.includes(trigger), onChange: () => toggleTrigger(trigger) }), trigger] }, trigger))) })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Delivery" }), _jsx("select", { className: "field-select", value: deliveryChannel, onChange: (e) => {
                                    const ch = e.target.value;
                                    setData((p) => ({
                                        ...p,
                                        delivery: ch === "log" ? undefined : { channel: ch, target: p.delivery?.target },
                                    }));
                                }, children: DELIVERY_CHANNELS.map((ch) => (_jsx("option", { value: ch, children: ch }, ch))) })] }), needsTarget && (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: deliveryChannel === "discord" ? "Channel ID" : "User ID" }), _jsx("input", { className: "field-input", value: data.delivery?.target ?? "", onChange: (e) => setData((p) => ({
                                    ...p,
                                    delivery: { channel: deliveryChannel, target: e.target.value || undefined },
                                })), placeholder: deliveryChannel === "discord" ? "Discord channel ID" : "Discord user ID (defaults to owner)" })] }))] })] }));
}
