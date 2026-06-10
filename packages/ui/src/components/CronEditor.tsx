import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";

interface CronJob {
  name: string;
  schedule: string;
  prompt: string;
  sessionKey?: string;
  model?: string;
  profile?: string;
  enabled?: boolean;
  delivery?: {
    channel?: string;
    mode?: "channel" | "dm";
    target?: string;
  };
  wakeAgent?: boolean;
  newSession?: boolean;
}

interface CronConfig {
  enabled: boolean;
  jobs: CronJob[];
}

// UI modes over the open `{ channel, mode, target }` delivery shape. "log" is
// the console-only sentinel (stored as `{ channel: "log" }`); "channel" posts
// to a channel/thread and "dm" DMs a user. The channel id is open free-text.
type DeliveryMode = "log" | "channel" | "dm";

function deliveryToMode(delivery: CronJob["delivery"]): DeliveryMode {
  if (!delivery || !delivery.channel || delivery.channel === "log") return "log";
  return delivery.mode === "dm" ? "dm" : "channel";
}

function buildDelivery(mode: DeliveryMode, channel?: string, target?: string): CronJob["delivery"] {
  if (mode === "log") return { channel: "log" };
  return { channel: channel || undefined, mode, target };
}

const DEFAULTS: CronConfig = {
  enabled: false,
  jobs: [],
};

export function CronEditor() {
  const [data, setData] = useState<CronConfig>(DEFAULTS);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConfigSection<CronConfig | null>("cron")
      .then((res) => {
        if (res.data) setData({ ...DEFAULTS, ...res.data, jobs: res.data.jobs ?? [] });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setStatus({ type: "saving" });
    try {
      const result = await saveConfigSection("cron", data);
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

  function addJob() {
    setData((prev) => ({
      ...prev,
      jobs: [...prev.jobs, { name: `job_${Date.now()}`, schedule: "0 * * * *", prompt: "" }],
    }));
  }

  function removeJob(index: number) {
    setData((prev) => ({
      ...prev,
      jobs: prev.jobs.filter((_, i) => i !== index),
    }));
  }

  function updateJob(index: number, field: string, value: unknown) {
    setData((prev) => ({
      ...prev,
      jobs: prev.jobs.map((j, i) => (i === index ? { ...j, [field]: value } : j)),
    }));
  }

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header">
          <h3>Cron Jobs</h3>
        </div>
        <div className="skeleton-card" style={{ height: 120 }} />
      </div>
    );
  }

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Cron Jobs</h3>
        <div className="config-actions">
          {status.type === "saved" && <span className="config-saved">{status.message}</span>}
          {status.type === "error" && <span className="config-error">{status.message}</span>}
          <button type="button" className="config-save-btn" onClick={handleSave} disabled={status.type === "saving"}>
            {status.type === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="section-card" style={{ marginBottom: 16 }}>
        <div className="field-group">
          <div className="field-row">
            <button
              type="button"
              className={`toggle-switch ${data.enabled ? "on" : "off"}`}
              onClick={() => setData((p) => ({ ...p, enabled: !p.enabled }))}
            >
              <span className="toggle-switch-knob" />
            </button>
            <span className="field-inline-label">Cron Enabled</span>
          </div>
        </div>
      </div>

      {data.jobs.length === 0 && (
        <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }}>No cron jobs defined.</p>
      )}

      {data.jobs.map((job, i) => (
        <div key={i} className="section-card">
          <div className="section-card-header">
            <span className="section-card-name">{job.name}</span>
            <button type="button" className="section-card-remove" onClick={() => removeJob(i)}>
              &#x2715;
            </button>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Name</label>
              <input className="field-input" value={job.name} onChange={(e) => updateJob(i, "name", e.target.value)} />
            </div>

            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Schedule (cron)</label>
              <input
                className="field-input"
                value={job.schedule}
                onChange={(e) => updateJob(i, "schedule", e.target.value)}
                placeholder="0 9 * * *"
              />
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Prompt</label>
            <textarea
              className="field-textarea"
              value={job.prompt}
              onChange={(e) => updateJob(i, "prompt", e.target.value)}
              placeholder="What the agent should do"
              rows={2}
            />
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Profile</label>
              <input
                className="field-input"
                value={job.profile ?? ""}
                onChange={(e) => updateJob(i, "profile", e.target.value || undefined)}
                placeholder="(optional)"
              />
            </div>

            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Delivery Mode</label>
              <select
                className="field-select"
                value={deliveryToMode(job.delivery)}
                onChange={(e) => {
                  const mode = e.target.value as DeliveryMode;
                  updateJob(i, "delivery", buildDelivery(mode, job.delivery?.channel, job.delivery?.target));
                }}
              >
                <option value="log">log (stdout)</option>
                <option value="channel">channel</option>
                <option value="dm">dm</option>
              </select>
            </div>
          </div>

          {deliveryToMode(job.delivery) !== "log" && (
            <div style={{ display: "flex", gap: 12 }}>
              <div className="field-group" style={{ flex: 1 }}>
                <label className="field-label" htmlFor={`cron-delivery-channel-${i}`}>
                  Delivery Channel
                </label>
                <input
                  id={`cron-delivery-channel-${i}`}
                  className="field-input"
                  value={job.delivery?.channel ?? ""}
                  onChange={(e) =>
                    updateJob(
                      i,
                      "delivery",
                      buildDelivery(deliveryToMode(job.delivery), e.target.value || undefined, job.delivery?.target),
                    )
                  }
                  placeholder="default channel"
                />
              </div>
              <div className="field-group" style={{ flex: 1 }}>
                <label className="field-label" htmlFor={`cron-delivery-target-${i}`}>
                  Delivery Target (optional)
                </label>
                <input
                  id={`cron-delivery-target-${i}`}
                  className="field-input"
                  value={job.delivery?.target ?? ""}
                  onChange={(e) =>
                    updateJob(
                      i,
                      "delivery",
                      buildDelivery(deliveryToMode(job.delivery), job.delivery?.channel, e.target.value || undefined),
                    )
                  }
                  placeholder={
                    deliveryToMode(job.delivery) === "dm" ? "User ID (optional)" : "Channel/thread ID (optional)"
                  }
                />
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 24, marginTop: 4 }}>
            <div className="field-group">
              <div className="field-row">
                <button
                  type="button"
                  className={`toggle-switch ${job.enabled !== false ? "on" : "off"}`}
                  onClick={() => updateJob(i, "enabled", job.enabled === false ? undefined : false)}
                >
                  <span className="toggle-switch-knob" />
                </button>
                <span className="field-inline-label">Enabled</span>
              </div>
            </div>

            <div className="field-group">
              <div className="field-row">
                <button
                  type="button"
                  className={`toggle-switch ${job.wakeAgent !== false ? "on" : "off"}`}
                  onClick={() => updateJob(i, "wakeAgent", job.wakeAgent === false ? undefined : false)}
                >
                  <span className="toggle-switch-knob" />
                </button>
                <span className="field-inline-label">Wake Agent</span>
              </div>
            </div>

            <div className="field-group">
              <div className="field-row">
                <button
                  type="button"
                  className={`toggle-switch ${job.newSession ? "on" : "off"}`}
                  onClick={() => updateJob(i, "newSession", !job.newSession)}
                >
                  <span className="toggle-switch-knob" />
                </button>
                <span className="field-inline-label">New Session</span>
              </div>
            </div>
          </div>
        </div>
      ))}

      <button type="button" className="section-add-btn" onClick={addJob}>
        + Add Cron Job
      </button>
    </div>
  );
}
