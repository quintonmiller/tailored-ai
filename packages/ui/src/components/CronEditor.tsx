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
    channel: "log" | "discord" | "discord-dm";
    target?: string;
  };
  wakeAgent?: boolean;
  newSession?: boolean;
}

interface CronConfig {
  enabled: boolean;
  jobs: CronJob[];
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
        <div className="section-header"><h3>Cron Jobs</h3></div>
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
            <button type="button" className="section-card-remove" onClick={() => removeJob(i)}>&#x2715;</button>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Name</label>
              <input
                className="field-input"
                value={job.name}
                onChange={(e) => updateJob(i, "name", e.target.value)}
              />
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
              <label className="field-label">Delivery Channel</label>
              <select
                className="field-select"
                value={job.delivery?.channel ?? "log"}
                onChange={(e) => {
                  const channel = e.target.value as "log" | "discord" | "discord-dm";
                  updateJob(i, "delivery", channel === "log" ? undefined : { channel, target: job.delivery?.target });
                }}
              >
                <option value="log">log (stdout)</option>
                <option value="discord">discord</option>
                <option value="discord-dm">discord-dm</option>
              </select>
            </div>
          </div>

          {job.delivery && job.delivery.channel !== "log" && (
            <div className="field-group">
              <label className="field-label">Delivery Target</label>
              <input
                className="field-input"
                value={job.delivery.target ?? ""}
                onChange={(e) =>
                  updateJob(i, "delivery", { ...job.delivery!, target: e.target.value || undefined })
                }
                placeholder="Channel ID"
              />
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

      <button type="button" className="section-add-btn" onClick={addJob}>+ Add Cron Job</button>
    </div>
  );
}
