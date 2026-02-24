import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";

interface TaskWatcherConfig {
  enabled: boolean;
  profile?: string;
  prompt: string;
  debounceMs: number;
  triggers: string[];
  delivery?: {
    channel: "log" | "discord" | "discord-dm";
    target?: string;
  };
}

const DEFAULTS: TaskWatcherConfig = {
  enabled: false,
  prompt: "Task {{action}}: {{task_title}} ({{task_id}}), status: {{task_status}}. {{task_description}}",
  debounceMs: 5000,
  triggers: ["created", "updated"],
};

const ALL_TRIGGERS = ["created", "updated", "commented"] as const;
const DELIVERY_CHANNELS = ["log", "discord", "discord-dm"] as const;

export function TaskWatcherEditor() {
  const [data, setData] = useState<TaskWatcherConfig>(DEFAULTS);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConfigSection<TaskWatcherConfig | null>("task_watcher")
      .then((res) => {
        if (res.data) setData({ ...DEFAULTS, ...res.data, triggers: res.data.triggers ?? DEFAULTS.triggers });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setStatus({ type: "saving" });
    try {
      const result = await saveConfigSection("task_watcher", data);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "saved", message: "Saved" });
        setTimeout(() => setStatus({ type: "idle" }), 3000);
      }
    } catch (e) {
      setStatus({ type: "error", message: (e as Error).message });
    }
  }

  function toggleTrigger(trigger: string) {
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
    return (
      <div className="provider-section">
        <div className="section-header"><h3>Task Watcher</h3></div>
        <div className="skeleton-card" style={{ height: 120 }} />
      </div>
    );
  }

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Task Watcher</h3>
        <div className="config-actions">
          {status.type === "saved" && <span className="config-saved">{status.message}</span>}
          {status.type === "error" && <span className="config-error">{status.message}</span>}
          <button type="button" className="config-save-btn" onClick={handleSave} disabled={status.type === "saving"}>
            {status.type === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="section-card">
        <div className="field-group">
          <div className="field-row">
            <button
              type="button"
              className={`toggle-switch ${data.enabled ? "on" : "off"}`}
              onClick={() => setData((p) => ({ ...p, enabled: !p.enabled }))}
            >
              <span className="toggle-switch-knob" />
            </button>
            <span className="field-inline-label">Enabled</span>
          </div>
        </div>

        <div className="field-group">
          <label className="field-label">Profile</label>
          <input
            className="field-input"
            value={data.profile ?? ""}
            onChange={(e) => setData((p) => ({ ...p, profile: e.target.value || undefined }))}
            placeholder="(empty = primary agent)"
          />
          <span className="field-hint">
            When set, uses a dedicated agent with its own session. When empty, shares the primary agent's session.
          </span>
        </div>

        <div className="field-group">
          <label className="field-label">Prompt Template</label>
          <textarea
            className="field-textarea"
            value={data.prompt}
            onChange={(e) => setData((p) => ({ ...p, prompt: e.target.value }))}
            placeholder={DEFAULTS.prompt}
            rows={3}
          />
          <span className="field-hint">
            Variables: {"{{action}}"}, {"{{task_id}}"}, {"{{task_title}}"}, {"{{task_status}}"}, {"{{task_description}}"}, {"{{task_author}}"}, {"{{task_tags}}"}
          </span>
        </div>

        <div className="field-group">
          <label className="field-label">Debounce (ms)</label>
          <input
            className="field-input"
            type="number"
            value={data.debounceMs}
            onChange={(e) => setData((p) => ({ ...p, debounceMs: Number.parseInt(e.target.value, 10) || 0 }))}
            min={0}
            step={1000}
          />
        </div>

        <div className="field-group">
          <label className="field-label">Triggers</label>
          <div className="field-row" style={{ gap: 12 }}>
            {ALL_TRIGGERS.map((trigger) => (
              <label key={trigger} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={data.triggers.includes(trigger)}
                  onChange={() => toggleTrigger(trigger)}
                />
                {trigger}
              </label>
            ))}
          </div>
        </div>

        <div className="field-group">
          <label className="field-label">Delivery</label>
          <select
            className="field-select"
            value={deliveryChannel}
            onChange={(e) => {
              const ch = e.target.value as "log" | "discord" | "discord-dm";
              setData((p) => ({
                ...p,
                delivery: ch === "log" ? undefined : { channel: ch, target: p.delivery?.target },
              }));
            }}
          >
            {DELIVERY_CHANNELS.map((ch) => (
              <option key={ch} value={ch}>{ch}</option>
            ))}
          </select>
        </div>

        {needsTarget && (
          <div className="field-group">
            <label className="field-label">
              {deliveryChannel === "discord" ? "Channel ID" : "User ID"}
            </label>
            <input
              className="field-input"
              value={data.delivery?.target ?? ""}
              onChange={(e) =>
                setData((p) => ({
                  ...p,
                  delivery: { channel: deliveryChannel, target: e.target.value || undefined },
                }))
              }
              placeholder={deliveryChannel === "discord" ? "Discord channel ID" : "Discord user ID (defaults to owner)"}
            />
          </div>
        )}
      </div>
    </div>
  );
}
