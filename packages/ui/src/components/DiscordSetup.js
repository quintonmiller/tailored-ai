import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
const DEFAULTS = {
    enabled: false,
    token: "",
    owner: "",
    respondToDMs: true,
    respondToMentions: true,
};
export function DiscordSetup() {
    const [data, setData] = useState(DEFAULTS);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchConfigSection("discord")
            .then((res) => {
            if (res.data)
                setData({ ...DEFAULTS, ...res.data });
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            const result = await saveConfigSection("discord", data);
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
    function toggle(key) {
        setData((prev) => ({ ...prev, [key]: !prev[key] }));
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Discord" }) }), _jsx("div", { className: "skeleton-card", style: { height: 200 } })] }));
    }
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Discord" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsxs("div", { className: "section-card", children: [_jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${data.enabled ? "on" : "off"}`, onClick: () => toggle("enabled"), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Enabled" })] }) }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Bot Token" }), _jsx("input", { className: "field-input", type: "password", value: data.token, onChange: (e) => setData((p) => ({ ...p, token: e.target.value })), placeholder: "Discord bot token" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Owner ID" }), _jsx("input", { className: "field-input", type: "text", value: data.owner ?? "", onChange: (e) => setData((p) => ({ ...p, owner: e.target.value })), placeholder: "Discord user ID for ask_user tool" })] }), _jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${data.respondToDMs ? "on" : "off"}`, onClick: () => toggle("respondToDMs"), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Respond to DMs" })] }) }), _jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${data.respondToMentions ? "on" : "off"}`, onClick: () => toggle("respondToMentions"), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Respond to Mentions" })] }) })] })] }));
}
