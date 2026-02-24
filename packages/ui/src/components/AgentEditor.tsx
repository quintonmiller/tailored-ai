import { useCallback, useEffect, useState } from "react";
import { fetchConfigSection, fetchModels, fetchProviders, saveConfigSection } from "../api";

interface ModelEntry {
  provider: string;
  model: string;
}

interface AgentDefinition {
  description?: string;
  model?: string;
  provider?: string;
  models?: ModelEntry[];
  instructions?: string;
  tools?: string[];
  temperature?: number;
  maxToolRounds?: number;
  nudgeOnText?: number;
  nudgeMessage?: string;
  skipGlobalContext?: boolean;
  contextDir?: string;
}

type AgentMap = Record<string, AgentDefinition>;

const CUSTOM_VALUE = "__custom__";

function providerLabel(name: string): string {
  const labels: Record<string, string> = { ollama: "Ollama", openai: "OpenAI", anthropic: "Anthropic" };
  return labels[name] ?? name;
}

export function AgentEditor() {
  const [agents, setAgents] = useState<AgentMap>({});
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  // Provider data for model dropdowns
  const [providerNames, setProviderNames] = useState<string[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [customMode, setCustomMode] = useState<Set<string>>(new Set());

  const loadModels = useCallback((providerName: string) => {
    if (providerModels[providerName]) return;
    fetchModels(providerName)
      .then((data) => {
        setProviderModels((prev) => ({ ...prev, [providerName]: data.models }));
      })
      .catch(() => {
        setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
      });
  }, [providerModels]);

  useEffect(() => {
    Promise.all([
      fetchConfigSection<AgentMap | null>("agents"),
      fetchProviders(),
    ])
      .then(([agentRes, provData]) => {
        const agentDefs = agentRes.data ?? {};
        setAgents(agentDefs);
        const names = Object.keys(provData.providers);
        setProviderNames(names);

        // Fetch model lists for all providers
        for (const name of names) {
          fetchModels(name)
            .then((data) => {
              setProviderModels((prev) => ({ ...prev, [name]: data.models }));
              // Mark entries whose current model is not in the fetched list as custom
              const initCustom = new Set<string>();
              for (const [agentName, agentDef] of Object.entries(agentDefs)) {
                (agentDef.models ?? []).forEach((entry, i) => {
                  if (entry.provider === name && entry.model && !data.models.includes(entry.model)) {
                    initCustom.add(`${agentName}:${i}`);
                  }
                });
              }
              if (initCustom.size > 0) {
                setCustomMode((prev) => {
                  const next = new Set(prev);
                  for (const k of initCustom) next.add(k);
                  return next;
                });
              }
            })
            .catch(() => {
              setProviderModels((prev) => ({ ...prev, [name]: [] }));
            });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setStatus({ type: "saving" });
    try {
      // Derive legacy model/provider from models list for backward compat
      const payload: AgentMap = {};
      for (const [name, agentDef] of Object.entries(agents)) {
        const a = { ...agentDef };
        if (a.models && a.models.length > 0) {
          a.model = a.models[0].model;
          a.provider = a.models[0].provider;
        } else {
          delete a.models;
          delete a.model;
          delete a.provider;
        }
        payload[name] = a;
      }
      const result = await saveConfigSection("agents", payload);
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

  function addAgent() {
    const name = `agent_${Date.now()}`;
    setAgents((prev) => ({
      ...prev,
      [name]: { instructions: "" },
    }));
  }

  function removeAgent(name: string) {
    setAgents((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function renameAgent(oldName: string, newName: string) {
    if (newName === oldName || !newName.trim()) return;
    setAgents((prev) => {
      const next: AgentMap = {};
      for (const [k, v] of Object.entries(prev)) {
        next[k === oldName ? newName : k] = v;
      }
      return next;
    });
    // Update customMode keys
    setCustomMode((prev) => {
      const next = new Set<string>();
      for (const key of prev) {
        if (key.startsWith(`${oldName}:`)) {
          next.add(`${newName}:${key.slice(oldName.length + 1)}`);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  }

  function updateAgent(name: string, field: string, value: unknown) {
    setAgents((prev) => ({
      ...prev,
      [name]: { ...prev[name], [field]: value },
    }));
  }

  // --- Model list helpers ---

  const providerOptions = providerNames.length > 0 ? providerNames : ["ollama", "openai", "anthropic"];

  function getModels(agentName: string): ModelEntry[] {
    return agents[agentName]?.models ?? [];
  }

  function setModels(agentName: string, models: ModelEntry[]) {
    updateAgent(agentName, "models", models.length > 0 ? models : undefined);
  }

  function addModelEntry(agentName: string) {
    const firstProvider = providerOptions[0];
    setModels(agentName, [...getModels(agentName), { provider: firstProvider, model: "" }]);
  }

  function isCustom(listId: string, index: number): boolean {
    return customMode.has(`${listId}:${index}`);
  }

  function setCustom(listId: string, index: number, on: boolean) {
    setCustomMode((prev) => {
      const next = new Set(prev);
      if (on) next.add(`${listId}:${index}`);
      else next.delete(`${listId}:${index}`);
      return next;
    });
  }

  function renderModelList(agentName: string) {
    const models = getModels(agentName);

    function update(index: number, field: keyof ModelEntry, value: string) {
      setModels(agentName, models.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
    }

    function remove(index: number) {
      setModels(agentName, models.filter((_, i) => i !== index));
    }

    function move(index: number, dir: -1 | 1) {
      const next = [...models];
      const target = index + dir;
      if (target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target], next[index]];
      setModels(agentName, next);
    }

    return (
      <div className="field-group">
        <label className="field-label">Models (priority list)</label>
        {models.length > 0 && (
          <div className="model-list">
            {models.map((entry, i) => {
              const available = providerModels[entry.provider] ?? [];
              const custom = isCustom(agentName, i);
              return (
                <div key={i} className="model-entry">
                  <span className="model-entry-number">{i + 1}</span>
                  <select
                    className="model-entry-provider"
                    value={entry.provider}
                    onChange={(e) => {
                      loadModels(e.target.value);
                      setCustom(agentName, i, false);
                      update(i, "provider", e.target.value);
                    }}
                  >
                    {providerOptions.map((p) => (
                      <option key={p} value={p}>{providerLabel(p)}</option>
                    ))}
                    {!providerOptions.includes(entry.provider) && (
                      <option value={entry.provider}>{providerLabel(entry.provider)}</option>
                    )}
                  </select>
                  {custom || available.length === 0 ? (
                    <div className="model-entry-model-wrap">
                      <input
                        className="model-entry-model"
                        type="text"
                        value={entry.model}
                        onChange={(e) => update(i, "model", e.target.value)}
                        placeholder="model name"
                      />
                      {available.length > 0 && (
                        <button
                          type="button"
                          className="model-entry-toggle"
                          title="Pick from list"
                          onClick={() => setCustom(agentName, i, false)}
                        >
                          &#x25BC;
                        </button>
                      )}
                    </div>
                  ) : (
                    <select
                      className="model-entry-model"
                      value={available.includes(entry.model) ? entry.model : CUSTOM_VALUE}
                      onChange={(e) => {
                        if (e.target.value === CUSTOM_VALUE) {
                          setCustom(agentName, i, true);
                        } else {
                          update(i, "model", e.target.value);
                        }
                      }}
                    >
                      {!entry.model && <option value="" disabled>Select model...</option>}
                      {available.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                      <option value={CUSTOM_VALUE}>Custom...</option>
                    </select>
                  )}
                  <div className="model-entry-actions">
                    <button type="button" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      &#x25B2;
                    </button>
                    <button type="button" title="Move down" disabled={i === models.length - 1} onClick={() => move(i, 1)}>
                      &#x25BC;
                    </button>
                    <button type="button" title="Remove" onClick={() => remove(i)}>
                      &#x2715;
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <button type="button" className="model-add-btn" onClick={() => addModelEntry(agentName)}>
          + Add Model
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="provider-section">
        <div className="section-header"><h3>Agents</h3></div>
        <div className="skeleton-card" style={{ height: 120 }} />
      </div>
    );
  }

  const entries = Object.entries(agents);

  return (
    <div className="provider-section">
      <div className="section-header">
        <h3>Agents</h3>
        <div className="config-actions">
          {status.type === "saved" && <span className="config-saved">{status.message}</span>}
          {status.type === "error" && <span className="config-error">{status.message}</span>}
          <button type="button" className="config-save-btn" onClick={handleSave} disabled={status.type === "saving"}>
            {status.type === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {entries.length === 0 && (
        <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }}>No agents defined.</p>
      )}

      {entries.map(([name, agentDef]) => (
        <div key={name} className="section-card">
          <div className="section-card-header">
            <input
              className="field-input"
              style={{ maxWidth: 200, fontWeight: 600, color: "var(--accent)" }}
              value={name}
              onChange={(e) => renameAgent(name, e.target.value)}
            />
            <button type="button" className="section-card-remove" onClick={() => removeAgent(name)}>&#x2715;</button>
          </div>

          <div className="field-group">
            <label className="field-label">Description</label>
            <input
              className="field-input"
              value={agentDef.description ?? ""}
              onChange={(e) => updateAgent(name, "description", e.target.value || undefined)}
              placeholder="Short description shown in agent list"
            />
          </div>

          {renderModelList(name)}

          <div className="field-group">
            <label className="field-label">Instructions</label>
            <textarea
              className="field-textarea"
              value={agentDef.instructions ?? ""}
              onChange={(e) => updateAgent(name, "instructions", e.target.value || undefined)}
              placeholder="System instructions for this agent"
              rows={3}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Tools (comma-separated)</label>
            <input
              className="field-input"
              value={(agentDef.tools ?? []).join(", ")}
              onChange={(e) => {
                const tools = e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean);
                updateAgent(name, "tools", tools.length > 0 ? tools : undefined);
              }}
              placeholder="web_search, memory, exec"
            />
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Temperature</label>
              <input
                className="field-input"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={agentDef.temperature ?? ""}
                onChange={(e) => updateAgent(name, "temperature", e.target.value ? Number(e.target.value) : undefined)}
                placeholder="0.3"
              />
            </div>

            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Max Tool Rounds</label>
              <input
                className="field-input"
                type="number"
                value={agentDef.maxToolRounds ?? ""}
                onChange={(e) => updateAgent(name, "maxToolRounds", e.target.value ? Number(e.target.value) : undefined)}
                placeholder="10"
              />
            </div>

            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Nudge on Text</label>
              <input
                className="field-input"
                type="number"
                value={agentDef.nudgeOnText ?? ""}
                onChange={(e) => updateAgent(name, "nudgeOnText", e.target.value ? Number(e.target.value) : undefined)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Context Directory</label>
            <input
              className="field-input"
              value={agentDef.contextDir ?? ""}
              onChange={(e) => updateAgent(name, "contextDir", e.target.value || undefined)}
              placeholder="(optional override)"
            />
          </div>

          <div className="field-group">
            <div className="field-row">
              <button
                type="button"
                className={`toggle-switch ${agentDef.skipGlobalContext ? "on" : "off"}`}
                onClick={() => updateAgent(name, "skipGlobalContext", !agentDef.skipGlobalContext)}
              >
                <span className="toggle-switch-knob" />
              </button>
              <span className="field-inline-label">Skip Global Context</span>
            </div>
          </div>
        </div>
      ))}

      <button type="button" className="section-add-btn" onClick={addAgent}>+ Add Agent</button>
    </div>
  );
}
