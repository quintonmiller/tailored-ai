import { jsx as _jsx } from "react/jsx-runtime";
const SECTIONS = [
    { key: "providers", label: "Providers" },
    { key: "discord", label: "Discord" },
    { key: "agents", label: "Agents" },
    { key: "tools", label: "Tools" },
    { key: "custom_tools", label: "Custom Tools" },
    { key: "cron", label: "Cron" },
    { key: "task_watcher", label: "Task Watcher" },
    { key: "webhooks", label: "Webhooks" },
    { key: "commands", label: "Commands" },
    { key: "yaml", label: "Raw YAML" },
];
export function ConfigSidebar({ active, onChange }) {
    return (_jsx("nav", { className: "config-sidebar", children: SECTIONS.map((s) => (_jsx("button", { type: "button", className: `config-sidebar-item${active === s.key ? " active" : ""}`, onClick: () => onChange(s.key), children: s.label }, s.key))) }));
}
