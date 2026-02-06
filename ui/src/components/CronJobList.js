import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function CronJobList(props) {
    const { data } = props;
    if (!data.enabled) {
        return _jsx("div", { className: "cron-banner", children: "Cron is disabled globally. Enable it in config to schedule jobs." });
    }
    if (data.jobs.length === 0) {
        return _jsx("div", { className: "empty-state", children: "No cron jobs configured." });
    }
    return (_jsx("div", { className: "cron-list", children: data.jobs.map((job) => (_jsxs("div", { className: "cron-item", children: [_jsxs("div", { className: "cron-item-header", children: [_jsx("span", { className: `cron-dot ${job.enabled ? 'enabled' : 'disabled'}` }), _jsx("span", { className: "cron-name", children: job.name }), _jsx("span", { className: "cron-schedule", children: job.schedule })] }), _jsx("div", { className: "cron-meta", children: job.last_run ? `Last run ${formatRelative(job.last_run)}` : 'Never run' })] }, job.id))) }));
}
function formatRelative(iso) {
    const d = new Date(iso + 'Z');
    const diff = Date.now() - d.getTime();
    if (diff < 60_000)
        return 'just now';
    if (diff < 3600_000)
        return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000)
        return `${Math.floor(diff / 3600_000)}h ago`;
    return d.toLocaleDateString();
}
