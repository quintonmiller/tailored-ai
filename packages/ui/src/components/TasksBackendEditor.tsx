import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";

type BackendKind = "native" | "github" | "beans" | "beads";

interface TasksConfig {
  backend?: BackendKind;
  github?: { repo?: string; token?: string };
  beans?: { path?: string };
  beads?: { path?: string };
}

const DEFAULTS: TasksConfig = { backend: "native" };

export function TasksBackendEditor() {
  const [data, setData] = useState<TasksConfig>(DEFAULTS);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConfigSection<TasksConfig | null>("tasks")
      .then((res) => {
        if (res.data) setData({ ...DEFAULTS, ...res.data });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setStatus({ type: "saving" });
    const result = await saveConfigSection("tasks", data);
    if (result.error) {
      setStatus({ type: "error", message: result.error });
    } else {
      setStatus({ type: "saved", message: "Saved" });
      setTimeout(() => setStatus({ type: "idle" }), 2500);
    }
  }

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header"><h3>Task Backend</h3></div>
        <div className="skeleton-card" style={{ height: 120 }} />
      </div>
    );
  }

  const backend = data.backend ?? "native";

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Task Backend</h3>
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
          <label className="field-label">Backend</label>
          <select
            className="field-select"
            value={backend}
            onChange={(e) => setData((p) => ({ ...p, backend: e.target.value as BackendKind }))}
          >
            <option value="native">native (SQLite)</option>
            <option value="github">github (Issues)</option>
            <option value="beans">beans (CLI)</option>
            <option value="beads">beads (CLI)</option>
          </select>
          <span className="field-hint">
            Determines where project tasks and the autopilot read/write. Switching backends requires a server restart for some integrations.
          </span>
        </div>

        {backend === "github" && (
          <>
            <div className="field-group">
              <label className="field-label">Repo</label>
              <input
                className="field-input"
                value={data.github?.repo ?? ""}
                onChange={(e) =>
                  setData((p) => ({ ...p, github: { ...p.github, repo: e.target.value } }))
                }
                placeholder="owner/repo"
              />
            </div>
            <div className="field-group">
              <label className="field-label">Token</label>
              <input
                className="field-input"
                value={data.github?.token ?? ""}
                onChange={(e) =>
                  setData((p) => ({ ...p, github: { ...p.github, token: e.target.value } }))
                }
                placeholder="${GITHUB_TOKEN}"
              />
              <span className="field-hint">Use ${"${GITHUB_TOKEN}"} to interpolate from env.</span>
            </div>
          </>
        )}

        {backend === "beans" && (
          <div className="field-group">
            <label className="field-label">beans path</label>
            <input
              className="field-input"
              value={data.beans?.path ?? ""}
              onChange={(e) =>
                setData((p) => ({ ...p, beans: { ...p.beans, path: e.target.value } }))
              }
              placeholder="./.beans"
            />
          </div>
        )}

        {backend === "beads" && (
          <div className="field-group">
            <label className="field-label">beads path</label>
            <input
              className="field-input"
              value={data.beads?.path ?? ""}
              onChange={(e) =>
                setData((p) => ({ ...p, beads: { ...p.beads, path: e.target.value } }))
              }
              placeholder="./.beads"
            />
            <span className="field-hint">Run <code>bd init</code> in this directory before use.</span>
          </div>
        )}
      </div>
    </div>
  );
}
