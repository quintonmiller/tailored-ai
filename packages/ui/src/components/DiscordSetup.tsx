import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";

interface DiscordConfig {
  enabled: boolean;
  token: string;
  owner?: string;
  respondToDMs: boolean;
  respondToMentions: boolean;
}

const DEFAULTS: DiscordConfig = {
  enabled: false,
  token: "",
  owner: "",
  respondToDMs: true,
  respondToMentions: true,
};

export function DiscordSetup() {
  const [data, setData] = useState<DiscordConfig>(DEFAULTS);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConfigSection<DiscordConfig | null>("discord")
      .then((res) => {
        if (res.data) setData({ ...DEFAULTS, ...res.data });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setStatus({ type: "saving" });
    try {
      const result = await saveConfigSection("discord", data);
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

  function toggle(key: keyof DiscordConfig) {
    setData((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header"><h3>Discord</h3></div>
        <div className="skeleton-card" style={{ height: 200 }} />
      </div>
    );
  }

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Discord</h3>
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
              onClick={() => toggle("enabled")}
            >
              <span className="toggle-switch-knob" />
            </button>
            <span className="field-inline-label">Enabled</span>
          </div>
        </div>

        <div className="field-group">
          <label className="field-label">Bot Token</label>
          <input
            className="field-input"
            type="password"
            value={data.token}
            onChange={(e) => setData((p) => ({ ...p, token: e.target.value }))}
            placeholder="Discord bot token"
          />
        </div>

        <div className="field-group">
          <label className="field-label">Owner ID</label>
          <input
            className="field-input"
            type="text"
            value={data.owner ?? ""}
            onChange={(e) => setData((p) => ({ ...p, owner: e.target.value }))}
            placeholder="Discord user ID for ask_user tool"
          />
        </div>

        <div className="field-group">
          <div className="field-row">
            <button
              type="button"
              className={`toggle-switch ${data.respondToDMs ? "on" : "off"}`}
              onClick={() => toggle("respondToDMs")}
            >
              <span className="toggle-switch-knob" />
            </button>
            <span className="field-inline-label">Respond to DMs</span>
          </div>
        </div>

        <div className="field-group">
          <div className="field-row">
            <button
              type="button"
              className={`toggle-switch ${data.respondToMentions ? "on" : "off"}`}
              onClick={() => toggle("respondToMentions")}
            >
              <span className="toggle-switch-knob" />
            </button>
            <span className="field-inline-label">Respond to Mentions</span>
          </div>
        </div>
      </div>
    </div>
  );
}
