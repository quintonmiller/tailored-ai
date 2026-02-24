import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { toggleCronJob, triggerCronJob } from "../api";
import { useRelativeTime } from "../hooks/useRelativeTime";
export function CronJobList(props) {
    useRelativeTime();
    const { data, onJobTriggered } = props;
    const [running, setRunning] = useState({});
    const [toggling, setToggling] = useState({});
    if (!data.enabled) {
        return _jsx("div", { className: "cron-banner", children: "Cron is disabled globally. Enable it in config to schedule jobs." });
    }
    if (data.jobs.length === 0) {
        return _jsx("div", { className: "empty-state", children: "No cron jobs configured." });
    }
    const handleRun = async (name) => {
        setRunning((prev) => ({ ...prev, [name]: true }));
        try {
            await triggerCronJob(name);
            onJobTriggered?.();
        }
        catch (err) {
            console.error(`Failed to trigger job "${name}":`, err);
        }
        finally {
            setRunning((prev) => ({ ...prev, [name]: false }));
        }
    };
    const handleToggle = async (name, currentlyEnabled) => {
        setToggling((prev) => ({ ...prev, [name]: true }));
        try {
            await toggleCronJob(name, !currentlyEnabled);
            onJobTriggered?.();
        }
        catch (err) {
            console.error(`Failed to toggle job "${name}":`, err);
        }
        finally {
            setToggling((prev) => ({ ...prev, [name]: false }));
        }
    };
    return (_jsx("div", { className: "cron-list", children: data.jobs.map((job) => {
            const enabled = !!job.enabled;
            return (_jsxs("div", { className: `cron-item${enabled ? "" : " cron-item-disabled"}`, children: [_jsxs("div", { className: "cron-item-header", children: [_jsx("button", { type: "button", className: `cron-toggle ${enabled ? "on" : "off"}`, disabled: toggling[job.name], onClick: () => handleToggle(job.name, enabled), "aria-label": enabled ? "Disable job" : "Enable job", children: _jsx("span", { className: "cron-toggle-knob" }) }), _jsx("span", { className: "cron-name", children: job.name }), _jsx("span", { className: "cron-schedule", children: job.schedule }), _jsx("button", { type: "button", className: `cron-run-btn${running[job.name] ? " running" : ""}`, disabled: running[job.name] || !enabled, onClick: () => handleRun(job.name), children: running[job.name] ? "Running..." : "Run" })] }), _jsx("div", { className: "cron-meta", children: job.last_run ? `Last run ${formatRelative(job.last_run)}` : "Never run" })] }, job.name));
        }) }));
}
function formatRelative(iso) {
    const d = new Date(`${iso}Z`);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000)
        return "just now";
    if (diff < 3600_000)
        return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000)
        return `${Math.floor(diff / 3600_000)}h ago`;
    return d.toLocaleDateString();
}
