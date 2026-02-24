interface PermissionRule {
  match: Record<string, string>;
  action: "auto" | "approve";
}

interface RuleEditorProps {
  rule: PermissionRule;
  onChange: (rule: PermissionRule) => void;
  onRemove: () => void;
}

export function PermissionRuleEditor({ rule, onChange, onRemove }: RuleEditorProps) {
  const matchEntries = Object.entries(rule.match);
  const isCatchAll = matchEntries.length === 0;

  function setMatchParam(oldKey: string, newKey: string, value: string) {
    const match = { ...rule.match };
    if (oldKey !== newKey) delete match[oldKey];
    match[newKey] = value;
    onChange({ ...rule, match });
  }

  function removeMatchParam(key: string) {
    const { [key]: _, ...rest } = rule.match;
    onChange({ ...rule, match: rest });
  }

  function addMatchParam() {
    onChange({ ...rule, match: { ...rule.match, "": "" } });
  }

  return (
    <div style={{
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      padding: "8px 10px",
      marginBottom: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: matchEntries.length > 0 ? 6 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            className="field-select"
            style={{ width: "auto", minWidth: 100 }}
            value={rule.action}
            onChange={(e) => onChange({ ...rule, action: e.target.value as "auto" | "approve" })}
          >
            <option value="auto">auto</option>
            <option value="approve">approve</option>
          </select>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {isCatchAll ? "(catch-all)" : `when ${matchEntries.length} param${matchEntries.length > 1 ? "s" : ""} match`}
          </span>
        </div>
        <button type="button" className="sub-item-remove" onClick={onRemove}>&#x2715;</button>
      </div>

      {matchEntries.map(([key, value], i) => (
        <div key={i} className="sub-item">
          <input
            className="field-input"
            style={{ maxWidth: 120 }}
            value={key}
            onChange={(e) => setMatchParam(key, e.target.value, value)}
            placeholder="param"
          />
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>=~</span>
          <input
            className="field-input"
            value={value}
            onChange={(e) => setMatchParam(key, key, e.target.value)}
            placeholder="regex pattern"
          />
          <button type="button" className="sub-item-remove" onClick={() => removeMatchParam(key)}>&#x2715;</button>
        </div>
      ))}

      <button
        type="button"
        style={{
          background: "none",
          border: "none",
          color: "var(--text-dim)",
          fontSize: 11,
          cursor: "pointer",
          padding: "2px 0",
          fontFamily: "var(--font)",
        }}
        onClick={addMatchParam}
      >
        + add match condition
      </button>
    </div>
  );
}

// --- Inline permission controls for a single tool card ---

export interface ToolPermissionConfig {
  mode: "auto" | "approve" | "conditional";
  rules?: PermissionRule[];
}

interface InlinePermissionProps {
  toolName: string;
  config: ToolPermissionConfig | undefined;
  defaultMode: string;
  onChange: (toolName: string, config: ToolPermissionConfig | undefined) => void;
}

export function InlinePermission({ toolName, config, defaultMode, onChange }: InlinePermissionProps) {
  const mode = config?.mode ?? "default";

  function setMode(newMode: string) {
    if (newMode === "default") {
      onChange(toolName, undefined);
      return;
    }
    const m = newMode as ToolPermissionConfig["mode"];
    if (m === "conditional") {
      onChange(toolName, { mode: m, rules: config?.rules ?? [{ match: {}, action: "approve" }] });
    } else {
      onChange(toolName, { mode: m });
    }
  }

  function updateRule(index: number, rule: PermissionRule) {
    const rules = [...(config?.rules ?? [])];
    rules[index] = rule;
    onChange(toolName, { ...config!, rules });
  }

  function addRule() {
    const rules = [...(config?.rules ?? []), { match: {} as Record<string, string>, action: "approve" as const }];
    onChange(toolName, { ...config!, rules });
  }

  function removeRule(index: number) {
    const rules = (config?.rules ?? []).filter((_, i) => i !== index);
    onChange(toolName, { ...config!, rules });
  }

  return (
    <div className="field-group">
      <label className="field-label">Permission</label>
      <select
        className="field-select"
        value={mode}
        onChange={(e) => setMode(e.target.value)}
      >
        <option value="default">default ({defaultMode})</option>
        <option value="auto">auto (always allow)</option>
        <option value="approve">approve (always ask)</option>
        <option value="conditional">conditional (rule-based)</option>
      </select>

      {config?.mode === "conditional" && (
        <div style={{ marginTop: 8 }}>
          <label className="field-label" style={{ marginBottom: 6 }}>
            Rules (first match wins)
          </label>
          {(config.rules ?? []).map((rule, i) => (
            <PermissionRuleEditor
              key={i}
              rule={rule}
              onChange={(r) => updateRule(i, r)}
              onRemove={() => removeRule(i)}
            />
          ))}
          <button
            type="button"
            className="section-add-btn"
            style={{ marginTop: 4 }}
            onClick={addRule}
          >
            + Add Rule
          </button>
        </div>
      )}
    </div>
  );
}
