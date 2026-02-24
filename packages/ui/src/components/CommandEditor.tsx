import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";

interface CommandConfig {
  description: string;
  command?: string;
  prompt?: string;
  profile?: string;
  new_session?: boolean;
  timeout_ms?: number;
}

type CommandMap = Record<string, CommandConfig>;

export function CommandEditor() {
  const [commands, setCommands] = useState<CommandMap>({});
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConfigSection<CommandMap | null>("commands")
      .then((res) => {
        if (res.data) setCommands(res.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setStatus({ type: "saving" });
    try {
      const result = await saveConfigSection("commands", commands);
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

  function addCommand() {
    const name = `cmd_${Date.now()}`;
    setCommands((prev) => ({
      ...prev,
      [name]: { description: "" },
    }));
  }

  function removeCommand(name: string) {
    setCommands((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function renameCommand(oldName: string, newName: string) {
    if (newName === oldName || !newName.trim()) return;
    setCommands((prev) => {
      const next: CommandMap = {};
      for (const [k, v] of Object.entries(prev)) {
        next[k === oldName ? newName : k] = v;
      }
      return next;
    });
  }

  function updateCommand(name: string, field: string, value: unknown) {
    setCommands((prev) => ({
      ...prev,
      [name]: { ...prev[name], [field]: value },
    }));
  }

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header"><h3>Commands</h3></div>
        <div className="skeleton-card" style={{ height: 120 }} />
      </div>
    );
  }

  const entries = Object.entries(commands);

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Commands</h3>
        <div className="config-actions">
          {status.type === "saved" && <span className="config-saved">{status.message}</span>}
          {status.type === "error" && <span className="config-error">{status.message}</span>}
          <button type="button" className="config-save-btn" onClick={handleSave} disabled={status.type === "saving"}>
            {status.type === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {entries.length === 0 && (
        <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }}>No custom commands defined.</p>
      )}

      {entries.map(([name, cmd]) => (
        <div key={name} className="section-card">
          <div className="section-card-header">
            <input
              className="field-input"
              style={{ maxWidth: 200, fontWeight: 600, color: "var(--accent)" }}
              value={name}
              onChange={(e) => renameCommand(name, e.target.value)}
            />
            <button type="button" className="section-card-remove" onClick={() => removeCommand(name)}>&#x2715;</button>
          </div>

          <div className="field-group">
            <label className="field-label">Description</label>
            <input
              className="field-input"
              value={cmd.description}
              onChange={(e) => updateCommand(name, "description", e.target.value)}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Shell Command</label>
            <input
              className="field-input"
              value={cmd.command ?? ""}
              onChange={(e) => updateCommand(name, "command", e.target.value || undefined)}
              placeholder="shell command template (optional)"
            />
          </div>

          <div className="field-group">
            <label className="field-label">Prompt</label>
            <textarea
              className="field-textarea"
              value={cmd.prompt ?? ""}
              onChange={(e) => updateCommand(name, "prompt", e.target.value || undefined)}
              placeholder="Agent prompt template (optional)"
            />
          </div>

          <div className="field-group">
            <label className="field-label">Profile</label>
            <input
              className="field-input"
              value={cmd.profile ?? ""}
              onChange={(e) => updateCommand(name, "profile", e.target.value || undefined)}
              placeholder="(optional)"
            />
          </div>

          <div className="field-group">
            <label className="field-label">Timeout (ms)</label>
            <input
              className="field-input"
              type="number"
              value={cmd.timeout_ms ?? ""}
              onChange={(e) => updateCommand(name, "timeout_ms", e.target.value ? Number(e.target.value) : undefined)}
              placeholder="30000"
              style={{ maxWidth: 150 }}
            />
          </div>

          <div className="field-group">
            <div className="field-row">
              <button
                type="button"
                className={`toggle-switch ${cmd.new_session ? "on" : "off"}`}
                onClick={() => updateCommand(name, "new_session", !cmd.new_session)}
              >
                <span className="toggle-switch-knob" />
              </button>
              <span className="field-inline-label">New Session</span>
            </div>
          </div>
        </div>
      ))}

      <button type="button" className="section-add-btn" onClick={addCommand}>+ Add Command</button>
    </div>
  );
}
