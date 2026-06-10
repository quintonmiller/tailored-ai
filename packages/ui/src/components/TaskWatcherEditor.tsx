import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";

interface TaskWatcherConfig {
  enabled: boolean;
  profile?: string;
  prompt: string;
  debounceMs: number;
  triggers: string[];
  delivery?: {
    channel?: string;
    mode?: "channel" | "dm";
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
// UI modes over the open `{ channel, mode, target }` delivery shape. "log" is
// the console-only sentinel (stored as `{ channel: "log" }`); "channel" posts
// to a channel/thread and "dm" DMs a user. The channel id is open free-text.
type DeliveryMode = "log" | "channel" | "dm";

function deliveryToMode(delivery: TaskWatcherConfig["delivery"]): DeliveryMode {
  if (!delivery || !delivery.channel || delivery.channel === "log") return "log";
  return delivery.mode === "dm" ? "dm" : "channel";
}

function buildDelivery(mode: DeliveryMode, channel?: string, target?: string): TaskWatcherConfig["delivery"] {
  if (mode === "log") return { channel: "log" };
  return { channel: channel || undefined, mode, target };
}

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

  const deliveryMode = deliveryToMode(data.delivery);
  const needsChannel = deliveryMode !== "log";

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header">
          <h3>Task Watcher</h3>
        </div>
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
            Variables: {"{{action}}"}, {"{{task_id}}"}, {"{{task_title}}"}, {"{{task_status}}"},{" "}
            {"{{task_description}}"}, {"{{task_author}}"}, {"{{task_tags}}"}
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
          <label className="field-label">Delivery Mode</label>
          <select
            className="field-select"
            value={deliveryMode}
            onChange={(e) => {
              const mode = e.target.value as DeliveryMode;
              setData((p) => ({ ...p, delivery: buildDelivery(mode, p.delivery?.channel, p.delivery?.target) }));
            }}
          >
            <option value="log">log (stdout)</option>
            <option value="channel">channel</option>
            <option value="dm">dm</option>
          </select>
        </div>

        {needsChannel && (
          <>
            <div className="field-group">
              <label className="field-label" htmlFor="taskwatcher-delivery-channel">
                Delivery Channel
              </label>
              <input
                id="taskwatcher-delivery-channel"
                className="field-input"
                value={data.delivery?.channel ?? ""}
                onChange={(e) =>
                  setData((p) => ({
                    ...p,
                    delivery: buildDelivery(deliveryMode, e.target.value || undefined, p.delivery?.target),
                  }))
                }
                placeholder="default channel"
              />
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="taskwatcher-delivery-target">
                Delivery Target (optional)
              </label>
              <input
                id="taskwatcher-delivery-target"
                className="field-input"
                value={data.delivery?.target ?? ""}
                onChange={(e) =>
                  setData((p) => ({
                    ...p,
                    delivery: buildDelivery(deliveryMode, p.delivery?.channel, e.target.value || undefined),
                  }))
                }
                placeholder={deliveryMode === "dm" ? "User ID (optional)" : "Channel/thread ID (optional)"}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
