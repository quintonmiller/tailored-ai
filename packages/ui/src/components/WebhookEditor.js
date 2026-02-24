import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
const DEFAULTS = {
    enabled: false,
    routes: [],
};
export function WebhookEditor() {
    const [data, setData] = useState(DEFAULTS);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchConfigSection("webhooks")
            .then((res) => {
            if (res.data)
                setData({ ...DEFAULTS, ...res.data, routes: res.data.routes ?? [] });
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            const result = await saveConfigSection("webhooks", data);
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
    function addRoute() {
        setData((prev) => ({
            ...prev,
            routes: [...prev.routes, { path: "/new-route", action: "agent", messageTemplate: "{{body}}" }],
        }));
    }
    function removeRoute(index) {
        setData((prev) => ({
            ...prev,
            routes: prev.routes.filter((_, i) => i !== index),
        }));
    }
    function updateRoute(index, field, value) {
        setData((prev) => ({
            ...prev,
            routes: prev.routes.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
        }));
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Webhooks" }) }), _jsx("div", { className: "skeleton-card", style: { height: 120 } })] }));
    }
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Webhooks" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsxs("div", { className: "section-card", children: [_jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${data.enabled ? "on" : "off"}`, onClick: () => setData((p) => ({ ...p, enabled: !p.enabled })), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Enabled" })] }) }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Secret" }), _jsx("input", { className: "field-input", type: "password", value: data.secret ?? "", onChange: (e) => setData((p) => ({ ...p, secret: e.target.value || undefined })), placeholder: "Webhook auth secret (optional)" })] })] }), _jsx("h4", { className: "provider-section-title", style: { marginTop: 16 }, children: "Routes" }), data.routes.length === 0 && (_jsx("p", { style: { color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }, children: "No webhook routes defined." })), data.routes.map((route, i) => (_jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "section-card-header", children: [_jsx("span", { className: "section-card-name", children: route.path }), _jsx("button", { type: "button", className: "section-card-remove", onClick: () => removeRoute(i), children: "\u2715" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Path" }), _jsx("input", { className: "field-input", value: route.path, onChange: (e) => updateRoute(i, "path", e.target.value), placeholder: "/my-webhook" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Action" }), _jsxs("select", { className: "field-select", value: route.action, onChange: (e) => updateRoute(i, "action", e.target.value), children: [_jsx("option", { value: "agent", children: "agent" }), _jsx("option", { value: "log", children: "log" })] })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Message Template" }), _jsx("textarea", { className: "field-textarea", value: route.messageTemplate, onChange: (e) => updateRoute(i, "messageTemplate", e.target.value), placeholder: "{{body}}" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Profile" }), _jsx("input", { className: "field-input", value: route.profile ?? "", onChange: (e) => updateRoute(i, "profile", e.target.value || undefined), placeholder: "(optional)" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Session Key" }), _jsx("input", { className: "field-input", value: route.sessionKey ?? "", onChange: (e) => updateRoute(i, "sessionKey", e.target.value || undefined), placeholder: "(optional)" })] }), _jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${route.newSession ? "on" : "off"}`, onClick: () => updateRoute(i, "newSession", !route.newSession), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "New Session" })] }) })] }, i))), _jsx("button", { type: "button", className: "section-add-btn", onClick: addRoute, children: "+ Add Route" })] }));
}
