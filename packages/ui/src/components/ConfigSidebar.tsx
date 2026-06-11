import { useState } from "react";

// Everyday config surfaces — shown expanded by default.
const PRIMARY_SECTIONS = [
  { key: "providers", label: "Providers" },
  { key: "discord", label: "Discord" },
  { key: "agents", label: "Agents" },
  { key: "autopilot", label: "Autopilot" },
  { key: "tools", label: "Tools" },
  { key: "cron", label: "Cron" },
  { key: "task_watcher", label: "Task Watcher" },
];

// Lower-traffic / power-user surfaces — collapsed under "Advanced".
const ADVANCED_SECTIONS = [
  { key: "custom_tools", label: "Custom Tools" },
  { key: "tasks", label: "Task Backend" },
  { key: "webhooks", label: "Webhooks" },
  { key: "commands", label: "Commands" },
  { key: "yaml", label: "Raw YAML" },
];

const ADVANCED_KEYS = new Set(ADVANCED_SECTIONS.map((s) => s.key));

interface Props {
  active: string;
  onChange: (section: string) => void;
}

export function ConfigSidebar({ active, onChange }: Props) {
  // Auto-expand Advanced if a section inside it is active (e.g. a deep link).
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_KEYS.has(active));

  return (
    <nav className="config-sidebar" aria-label="Configuration sections">
      {PRIMARY_SECTIONS.map((s) => (
        <button
          type="button"
          key={s.key}
          className={`config-sidebar-item${active === s.key ? " active" : ""}`}
          onClick={() => onChange(s.key)}
        >
          {s.label}
        </button>
      ))}
      <button
        type="button"
        className="config-sidebar-disclosure"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((v) => !v)}
      >
        <span className="config-sidebar-disclosure-caret" aria-hidden="true">
          {advancedOpen ? "▾" : "▸"}
        </span>
        Advanced
      </button>
      {advancedOpen &&
        ADVANCED_SECTIONS.map((s) => (
          <button
            type="button"
            key={s.key}
            className={`config-sidebar-item config-sidebar-item-nested${active === s.key ? " active" : ""}`}
            onClick={() => onChange(s.key)}
          >
            {s.label}
          </button>
        ))}
    </nav>
  );
}
