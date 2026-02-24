import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
import { InlinePermission, type ToolPermissionConfig } from "./PermissionRuleEditor";

interface ToolParam {
  type: string;
  description: string;
}

interface CustomTool {
  description: string;
  command: string;
  timeout_ms?: number;
  parameters: Record<string, ToolParam>;
}

type ToolMap = Record<string, CustomTool>;

interface PermissionsConfig {
  defaultMode: "auto" | "approve";
  timeoutMs: number;
  timeoutAction: "reject" | "auto_approve";
  tools: Record<string, ToolPermissionConfig>;
}

const PERMS_DEFAULTS: PermissionsConfig = {
  defaultMode: "auto",
  timeoutMs: 300000,
  timeoutAction: "reject",
  tools: {},
};

export function CustomToolEditor() {
  const [tools, setTools] = useState<ToolMap>({});
  const [perms, setPerms] = useState<PermissionsConfig>(PERMS_DEFAULTS);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchConfigSection<ToolMap | null>("custom_tools"),
      fetchConfigSection<PermissionsConfig | null>("permissions"),
    ])
      .then(([toolsRes, permsRes]) => {
        if (toolsRes.data) setTools(toolsRes.data);
        if (permsRes.data) setPerms({ ...PERMS_DEFAULTS, ...permsRes.data, tools: permsRes.data.tools ?? {} });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setStatus({ type: "saving" });
    try {
      const hasPermsConfig = Object.keys(perms.tools).length > 0
        || perms.defaultMode !== "auto"
        || perms.timeoutMs !== 300000
        || perms.timeoutAction !== "reject";

      const [toolsResult, permsResult] = await Promise.all([
        saveConfigSection("custom_tools", tools),
        saveConfigSection("permissions", hasPermsConfig ? perms : null),
      ]);

      const error = toolsResult.error || permsResult.error;
      if (error) {
        setStatus({ type: "error", message: error });
      } else {
        setStatus({ type: "saved", message: "Saved" });
        setTimeout(() => setStatus({ type: "idle" }), 3000);
      }
    } catch (e) {
      setStatus({ type: "error", message: (e as Error).message });
    }
  }

  function addTool() {
    const name = `tool_${Date.now()}`;
    setTools((prev) => ({
      ...prev,
      [name]: { description: "", command: "", parameters: {} },
    }));
  }

  function removeTool(name: string) {
    setTools((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    // Also clean up any permission config for this tool
    setPerms((prev) => {
      if (!(name in prev.tools)) return prev;
      const { [name]: _, ...rest } = prev.tools;
      return { ...prev, tools: rest };
    });
  }

  function renameTool(oldName: string, newName: string) {
    if (newName === oldName || !newName.trim()) return;
    setTools((prev) => {
      const next: ToolMap = {};
      for (const [k, v] of Object.entries(prev)) {
        next[k === oldName ? newName : k] = v;
      }
      return next;
    });
    // Rename permission config too
    setPerms((prev) => {
      if (!(oldName in prev.tools)) return prev;
      const { [oldName]: config, ...rest } = prev.tools;
      return { ...prev, tools: { ...rest, [newName]: config } };
    });
  }

  function updateTool(name: string, field: keyof CustomTool, value: unknown) {
    setTools((prev) => ({
      ...prev,
      [name]: { ...prev[name], [field]: value },
    }));
  }

  function addParam(toolName: string) {
    const paramName = `param_${Object.keys(tools[toolName].parameters).length + 1}`;
    updateTool(toolName, "parameters", {
      ...tools[toolName].parameters,
      [paramName]: { type: "string", description: "" },
    });
  }

  function removeParam(toolName: string, paramName: string) {
    const params = { ...tools[toolName].parameters };
    delete params[paramName];
    updateTool(toolName, "parameters", params);
  }

  function renameParam(toolName: string, oldName: string, newName: string) {
    if (newName === oldName || !newName.trim()) return;
    const params: Record<string, ToolParam> = {};
    for (const [k, v] of Object.entries(tools[toolName].parameters)) {
      params[k === oldName ? newName : k] = v;
    }
    updateTool(toolName, "parameters", params);
  }

  function updateParam(toolName: string, paramName: string, field: keyof ToolParam, value: string) {
    updateTool(toolName, "parameters", {
      ...tools[toolName].parameters,
      [paramName]: { ...tools[toolName].parameters[paramName], [field]: value },
    });
  }

  function handlePermChange(toolName: string, config: ToolPermissionConfig | undefined) {
    setPerms((prev) => {
      const next = { ...prev, tools: { ...prev.tools } };
      if (config) {
        next.tools[toolName] = config;
      } else {
        delete next.tools[toolName];
      }
      return next;
    });
  }

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header"><h3>Custom Tools</h3></div>
        <div className="skeleton-card" style={{ height: 120 }} />
      </div>
    );
  }

  const toolEntries = Object.entries(tools);

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Custom Tools</h3>
        <div className="config-actions">
          {status.type === "saved" && <span className="config-saved">{status.message}</span>}
          {status.type === "error" && <span className="config-error">{status.message}</span>}
          <button type="button" className="config-save-btn" onClick={handleSave} disabled={status.type === "saving"}>
            {status.type === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {toolEntries.length === 0 && (
        <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }}>No custom tools defined.</p>
      )}

      {toolEntries.map(([name, tool]) => (
        <div key={name} className="section-card">
          <div className="section-card-header">
            <input
              className="field-input"
              style={{ maxWidth: 200, fontWeight: 600, color: "var(--accent)" }}
              value={name}
              onChange={(e) => renameTool(name, e.target.value)}
            />
            <button type="button" className="section-card-remove" onClick={() => removeTool(name)}>&#x2715;</button>
          </div>

          <div className="field-group">
            <label className="field-label">Description</label>
            <input
              className="field-input"
              value={tool.description}
              onChange={(e) => updateTool(name, "description", e.target.value)}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Command</label>
            <input
              className="field-input"
              value={tool.command}
              onChange={(e) => updateTool(name, "command", e.target.value)}
              placeholder="echo Hello {{name}}"
            />
          </div>

          <div className="field-group">
            <label className="field-label">Timeout (ms)</label>
            <input
              className="field-input"
              type="number"
              value={tool.timeout_ms ?? ""}
              onChange={(e) => updateTool(name, "timeout_ms", e.target.value ? Number(e.target.value) : undefined)}
              placeholder="30000"
              style={{ maxWidth: 150 }}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Parameters</label>
            {Object.entries(tool.parameters).map(([pName, param]) => (
              <div key={pName} className="sub-item">
                <input
                  className="field-input"
                  style={{ maxWidth: 120 }}
                  value={pName}
                  onChange={(e) => renameParam(name, pName, e.target.value)}
                  placeholder="name"
                />
                <select
                  className="field-select"
                  style={{ maxWidth: 100 }}
                  value={param.type}
                  onChange={(e) => updateParam(name, pName, "type", e.target.value)}
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                </select>
                <input
                  className="field-input"
                  value={param.description}
                  onChange={(e) => updateParam(name, pName, "description", e.target.value)}
                  placeholder="description"
                />
                <button type="button" className="sub-item-remove" onClick={() => removeParam(name, pName)}>&#x2715;</button>
              </div>
            ))}
            <button type="button" className="section-add-btn" style={{ marginTop: 4 }} onClick={() => addParam(name)}>
              + Add Parameter
            </button>
          </div>

          <InlinePermission
            toolName={name}
            config={perms.tools[name]}
            defaultMode={perms.defaultMode}
            onChange={handlePermChange}
          />
        </div>
      ))}

      <button type="button" className="section-add-btn" onClick={addTool}>+ Add Custom Tool</button>
    </div>
  );
}
