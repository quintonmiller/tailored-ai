import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";

interface WebhookRoute {
  path: string;
  action: "agent" | "log";
  messageTemplate: string;
  profile?: string;
  sessionKey?: string;
  newSession?: boolean;
}

interface WebhookConfig {
  enabled: boolean;
  secret?: string;
  routes: WebhookRoute[];
}

const DEFAULTS: WebhookConfig = {
  enabled: false,
  routes: [],
};

export function WebhookEditor() {
  const [data, setData] = useState<WebhookConfig>(DEFAULTS);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConfigSection<WebhookConfig | null>("webhooks")
      .then((res) => {
        if (res.data) setData({ ...DEFAULTS, ...res.data, routes: res.data.routes ?? [] });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setStatus({ type: "saving" });
    try {
      const result = await saveConfigSection("webhooks", data);
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

  function addRoute() {
    setData((prev) => ({
      ...prev,
      routes: [...prev.routes, { path: "/new-route", action: "agent", messageTemplate: "{{body}}" }],
    }));
  }

  function removeRoute(index: number) {
    setData((prev) => ({
      ...prev,
      routes: prev.routes.filter((_, i) => i !== index),
    }));
  }

  function updateRoute(index: number, field: string, value: unknown) {
    setData((prev) => ({
      ...prev,
      routes: prev.routes.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
    }));
  }

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header"><h3>Webhooks</h3></div>
        <div className="skeleton-card" style={{ height: 120 }} />
      </div>
    );
  }

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Webhooks</h3>
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
          <label className="field-label">Secret</label>
          <input
            className="field-input"
            type="password"
            value={data.secret ?? ""}
            onChange={(e) => setData((p) => ({ ...p, secret: e.target.value || undefined }))}
            placeholder="Webhook auth secret (optional)"
          />
        </div>
      </div>

      <h4 className="provider-section-title" style={{ marginTop: 16 }}>Routes</h4>

      {data.routes.length === 0 && (
        <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }}>No webhook routes defined.</p>
      )}

      {data.routes.map((route, i) => (
        <div key={i} className="section-card">
          <div className="section-card-header">
            <span className="section-card-name">{route.path}</span>
            <button type="button" className="section-card-remove" onClick={() => removeRoute(i)}>&#x2715;</button>
          </div>

          <div className="field-group">
            <label className="field-label">Path</label>
            <input
              className="field-input"
              value={route.path}
              onChange={(e) => updateRoute(i, "path", e.target.value)}
              placeholder="/my-webhook"
            />
          </div>

          <div className="field-group">
            <label className="field-label">Action</label>
            <select
              className="field-select"
              value={route.action}
              onChange={(e) => updateRoute(i, "action", e.target.value)}
            >
              <option value="agent">agent</option>
              <option value="log">log</option>
            </select>
          </div>

          <div className="field-group">
            <label className="field-label">Message Template</label>
            <textarea
              className="field-textarea"
              value={route.messageTemplate}
              onChange={(e) => updateRoute(i, "messageTemplate", e.target.value)}
              placeholder="{{body}}"
            />
          </div>

          <div className="field-group">
            <label className="field-label">Profile</label>
            <input
              className="field-input"
              value={route.profile ?? ""}
              onChange={(e) => updateRoute(i, "profile", e.target.value || undefined)}
              placeholder="(optional)"
            />
          </div>

          <div className="field-group">
            <label className="field-label">Session Key</label>
            <input
              className="field-input"
              value={route.sessionKey ?? ""}
              onChange={(e) => updateRoute(i, "sessionKey", e.target.value || undefined)}
              placeholder="(optional)"
            />
          </div>

          <div className="field-group">
            <div className="field-row">
              <button
                type="button"
                className={`toggle-switch ${route.newSession ? "on" : "off"}`}
                onClick={() => updateRoute(i, "newSession", !route.newSession)}
              >
                <span className="toggle-switch-knob" />
              </button>
              <span className="field-inline-label">New Session</span>
            </div>
          </div>
        </div>
      ))}

      <button type="button" className="section-add-btn" onClick={addRoute}>+ Add Route</button>
    </div>
  );
}
