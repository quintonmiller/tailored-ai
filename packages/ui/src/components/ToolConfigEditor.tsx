import { useEffect, useState } from "react";
import { fetchConfigSection, saveConfigSection } from "../api";
import { InlinePermission, type ToolPermissionConfig } from "./PermissionRuleEditor";

/** Field definition for rendering tool config forms. */
interface FieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "list";
  placeholder?: string;
}

/** Tool metadata: display label + extra fields beyond `enabled`. */
interface ToolDef {
  key: string;
  label: string;
  fields: FieldDef[];
}

const TOOL_DEFS: ToolDef[] = [
  { key: "memory", label: "Memory", fields: [] },
  {
    key: "exec",
    label: "Exec",
    fields: [
      { key: "allowedCommands", label: "Allowed Commands (comma-separated)", type: "list" },
    ],
  },
  {
    key: "read",
    label: "Read",
    fields: [
      { key: "allowedPaths", label: "Allowed Paths (comma-separated)", type: "list" },
    ],
  },
  {
    key: "write",
    label: "Write",
    fields: [
      { key: "allowedPaths", label: "Allowed Paths (comma-separated)", type: "list" },
    ],
  },
  { key: "web_fetch", label: "Web Fetch", fields: [] },
  {
    key: "web_search",
    label: "Web Search",
    fields: [
      { key: "provider", label: "Provider", type: "text", placeholder: "brave" },
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "maxResults", label: "Max Results", type: "number", placeholder: "5" },
    ],
  },
  {
    key: "tasks",
    label: "Tasks",
    fields: [],
  },
  {
    key: "gmail",
    label: "Gmail",
    fields: [
      { key: "account", label: "Account", type: "text", placeholder: "user@gmail.com" },
    ],
  },
  {
    key: "google_calendar",
    label: "Google Calendar",
    fields: [
      { key: "account", label: "Account", type: "text", placeholder: "user@gmail.com" },
    ],
  },
  {
    key: "google_drive",
    label: "Google Drive",
    fields: [
      { key: "account", label: "Account", type: "text", placeholder: "user@gmail.com" },
      { key: "folder_name", label: "Folder Name", type: "text" },
      { key: "folder_id", label: "Folder ID", type: "text" },
    ],
  },
  {
    key: "claude_code",
    label: "Claude Code",
    fields: [
      { key: "model", label: "Model", type: "text", placeholder: "claude-sonnet-4-20250514" },
      { key: "maxTurns", label: "Max Turns", type: "number", placeholder: "10" },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number", placeholder: "300000" },
      { key: "allowedTools", label: "Allowed Tools (comma-separated)", type: "list" },
      { key: "disallowedTools", label: "Disallowed Tools (comma-separated)", type: "list" },
    ],
  },
  {
    key: "browser",
    label: "Browser",
    fields: [
      { key: "headless", label: "Headless", type: "boolean" },
      { key: "screenshotDir", label: "Screenshot Directory", type: "text" },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number" },
    ],
  },
  { key: "md_to_pdf", label: "Markdown to PDF", fields: [] },
  { key: "ask_user", label: "Ask User", fields: [] },
];

type ToolsConfig = Record<string, Record<string, unknown>>;

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

export function ToolConfigEditor() {
  const [tools, setTools] = useState<ToolsConfig>({});
  const [perms, setPerms] = useState<PermissionsConfig>(PERMS_DEFAULTS);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchConfigSection<ToolsConfig | null>("tools"),
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
      // Save both sections
      const hasPermsConfig = Object.keys(perms.tools).length > 0
        || perms.defaultMode !== "auto"
        || perms.timeoutMs !== 300000
        || perms.timeoutAction !== "reject";

      const [toolsResult, permsResult] = await Promise.all([
        saveConfigSection("tools", tools),
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

  function isEnabled(toolKey: string): boolean {
    return tools[toolKey]?.enabled !== false && tools[toolKey]?.enabled !== undefined
      ? !!tools[toolKey]?.enabled
      : false;
  }

  function toggleEnabled(toolKey: string) {
    setTools((prev) => {
      const existing = prev[toolKey] ?? {};
      const wasEnabled = !!existing.enabled;
      return { ...prev, [toolKey]: { ...existing, enabled: !wasEnabled } };
    });
  }

  function getField(toolKey: string, fieldKey: string): unknown {
    return tools[toolKey]?.[fieldKey];
  }

  function setField(toolKey: string, fieldKey: string, value: unknown) {
    setTools((prev) => ({
      ...prev,
      [toolKey]: { ...prev[toolKey], [fieldKey]: value },
    }));
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

  function renderField(toolKey: string, field: FieldDef) {
    const value = getField(toolKey, field.key);

    if (field.type === "boolean") {
      return (
        <div key={field.key} className="field-group">
          <div className="field-row">
            <button
              type="button"
              className={`toggle-switch ${value ? "on" : "off"}`}
              onClick={() => setField(toolKey, field.key, !value)}
            >
              <span className="toggle-switch-knob" />
            </button>
            <span className="field-inline-label">{field.label}</span>
          </div>
        </div>
      );
    }

    if (field.type === "list") {
      const arr = Array.isArray(value) ? value as string[] : [];
      return (
        <div key={field.key} className="field-group">
          <label className="field-label">{field.label}</label>
          <input
            className="field-input"
            value={arr.join(", ")}
            onChange={(e) => {
              const items = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
              setField(toolKey, field.key, items.length > 0 ? items : undefined);
            }}
            placeholder={field.placeholder}
          />
        </div>
      );
    }

    return (
      <div key={field.key} className="field-group">
        <label className="field-label">{field.label}</label>
        <input
          className="field-input"
          type={field.type}
          value={value != null ? String(value) : ""}
          onChange={(e) => {
            const v = field.type === "number"
              ? (e.target.value ? Number(e.target.value) : undefined)
              : (e.target.value || undefined);
            setField(toolKey, field.key, v);
          }}
          placeholder={field.placeholder}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header"><h3>Tools</h3></div>
        <div className="skeleton-card" style={{ height: 200 }} />
      </div>
    );
  }

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Tools</h3>
        <div className="config-actions">
          {status.type === "saved" && <span className="config-saved">{status.message}</span>}
          {status.type === "error" && <span className="config-error">{status.message}</span>}
          <button type="button" className="config-save-btn" onClick={handleSave} disabled={status.type === "saving"}>
            {status.type === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Permission defaults */}
      <div className="section-card">
        <div className="section-card-header">
          <span className="section-card-name">Permission Defaults</span>
        </div>
        <div className="field-group">
          <label className="field-label">Default Mode</label>
          <select
            className="field-select"
            value={perms.defaultMode}
            onChange={(e) => setPerms((p) => ({ ...p, defaultMode: e.target.value as "auto" | "approve" }))}
          >
            <option value="auto">auto (allow all by default)</option>
            <option value="approve">approve (require approval by default)</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Approval Timeout</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                className="field-input"
                type="number"
                value={perms.timeoutMs}
                onChange={(e) => setPerms((p) => ({ ...p, timeoutMs: Number(e.target.value) || 0 }))}
                placeholder="300000"
                style={{ maxWidth: 120 }}
              />
              <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                {perms.timeoutMs > 0 ? `${(perms.timeoutMs / 1000).toFixed(0)}s` : "no timeout"}
              </span>
            </div>
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">On Timeout</label>
            <select
              className="field-select"
              value={perms.timeoutAction}
              onChange={(e) => setPerms((p) => ({ ...p, timeoutAction: e.target.value as "reject" | "auto_approve" }))}
            >
              <option value="reject">reject</option>
              <option value="auto_approve">auto_approve</option>
            </select>
          </div>
        </div>
      </div>

      {/* Tool cards */}
      {TOOL_DEFS.map((def) => {
        const enabled = isEnabled(def.key);
        return (
          <div key={def.key} className="section-card">
            <div className="section-card-header">
              <div className="field-row">
                <button
                  type="button"
                  className={`toggle-switch ${enabled ? "on" : "off"}`}
                  onClick={() => toggleEnabled(def.key)}
                >
                  <span className="toggle-switch-knob" />
                </button>
                <span className="section-card-name">{def.label}</span>
              </div>
            </div>
            {enabled && (
              <div>
                {def.fields.map((field) => renderField(def.key, field))}
                <InlinePermission
                  toolName={def.key}
                  config={perms.tools[def.key]}
                  defaultMode={perms.defaultMode}
                  onChange={handlePermChange}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
