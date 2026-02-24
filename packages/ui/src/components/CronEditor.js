import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
const DEFAULTS = {
    enabled: false,
    jobs: [],
};
export function CronEditor() {
    const [data, setData] = useState(DEFAULTS);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchConfigSection("cron")
            .then((res) => {
            if (res.data)
                setData({ ...DEFAULTS, ...res.data, jobs: res.data.jobs ?? [] });
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []);
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            const result = await saveConfigSection("cron", data);
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
    function addJob() {
        setData((prev) => ({
            ...prev,
            jobs: [...prev.jobs, { name: `job_${Date.now()}`, schedule: "0 * * * *", prompt: "" }],
        }));
    }
    function removeJob(index) {
        setData((prev) => ({
            ...prev,
            jobs: prev.jobs.filter((_, i) => i !== index),
        }));
    }
    function updateJob(index, field, value) {
        setData((prev) => ({
            ...prev,
            jobs: prev.jobs.map((j, i) => (i === index ? { ...j, [field]: value } : j)),
        }));
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Cron Jobs" }) }), _jsx("div", { className: "skeleton-card", style: { height: 120 } })] }));
    }
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Cron Jobs" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsx("div", { className: "section-card", style: { marginBottom: 16 }, children: _jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${data.enabled ? "on" : "off"}`, onClick: () => setData((p) => ({ ...p, enabled: !p.enabled })), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Cron Enabled" })] }) }) }), data.jobs.length === 0 && (_jsx("p", { style: { color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }, children: "No cron jobs defined." })), data.jobs.map((job, i) => (_jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "section-card-header", children: [_jsx("span", { className: "section-card-name", children: job.name }), _jsx("button", { type: "button", className: "section-card-remove", onClick: () => removeJob(i), children: "\u2715" })] }), _jsxs("div", { style: { display: "flex", gap: 12 }, children: [_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Name" }), _jsx("input", { className: "field-input", value: job.name, onChange: (e) => updateJob(i, "name", e.target.value) })] }), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Schedule (cron)" }), _jsx("input", { className: "field-input", value: job.schedule, onChange: (e) => updateJob(i, "schedule", e.target.value), placeholder: "0 9 * * *" })] })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Prompt" }), _jsx("textarea", { className: "field-textarea", value: job.prompt, onChange: (e) => updateJob(i, "prompt", e.target.value), placeholder: "What the agent should do", rows: 2 })] }), _jsxs("div", { style: { display: "flex", gap: 12 }, children: [_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Profile" }), _jsx("input", { className: "field-input", value: job.profile ?? "", onChange: (e) => updateJob(i, "profile", e.target.value || undefined), placeholder: "(optional)" })] }), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Delivery Channel" }), _jsxs("select", { className: "field-select", value: job.delivery?.channel ?? "log", onChange: (e) => {
                                            const channel = e.target.value;
                                            updateJob(i, "delivery", channel === "log" ? undefined : { channel, target: job.delivery?.target });
                                        }, children: [_jsx("option", { value: "log", children: "log (stdout)" }), _jsx("option", { value: "discord", children: "discord" }), _jsx("option", { value: "discord-dm", children: "discord-dm" })] })] })] }), job.delivery && job.delivery.channel !== "log" && (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Delivery Target" }), _jsx("input", { className: "field-input", value: job.delivery.target ?? "", onChange: (e) => updateJob(i, "delivery", { ...job.delivery, target: e.target.value || undefined }), placeholder: "Channel ID" })] })), _jsxs("div", { style: { display: "flex", gap: 24, marginTop: 4 }, children: [_jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${job.enabled !== false ? "on" : "off"}`, onClick: () => updateJob(i, "enabled", job.enabled === false ? undefined : false), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Enabled" })] }) }), _jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${job.wakeAgent !== false ? "on" : "off"}`, onClick: () => updateJob(i, "wakeAgent", job.wakeAgent === false ? undefined : false), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Wake Agent" })] }) }), _jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${job.newSession ? "on" : "off"}`, onClick: () => updateJob(i, "newSession", !job.newSession), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "New Session" })] }) })] })] }, i))), _jsx("button", { type: "button", className: "section-add-btn", onClick: addJob, children: "+ Add Cron Job" })] }));
}
