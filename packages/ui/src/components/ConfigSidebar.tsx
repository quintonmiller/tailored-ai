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

interface Props {
  active: string;
  onChange: (section: string) => void;
}

export function ConfigSidebar({ active, onChange }: Props) {
  return (
    <nav className="config-sidebar">
      {SECTIONS.map((s) => (
        <button
          type="button"
          key={s.key}
          className={`config-sidebar-item${active === s.key ? " active" : ""}`}
          onClick={() => onChange(s.key)}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
