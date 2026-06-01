import { useCallback, useEffect, useState } from "react";
import {
  fetchModels,
  fetchProviders,
  type ModelEntry,
  type ModelInfo,
  type ProviderConnection,
  type ProvidersData,
  saveProviders,
} from "../api";

/** Known provider definitions — fields needed for each provider type. */
const KNOWN_PROVIDERS: Record<
  string,
  { label: string; fields: { key: string; label: string; type: string; placeholder?: string }[] }
> = {
  openai_compatible: {
    label: "OpenAI-compatible (vLLM, Ollama, LM Studio)",
    fields: [
      { key: "baseUrl", label: "Base URL", type: "text", placeholder: "http://127.0.0.1:8000/v1" },
      { key: "apiKey", label: "API Key (optional)", type: "password" },
      { key: "name", label: "Display Name (optional)", type: "text", placeholder: "vLLM" },
    ],
  },
  openai: {
    label: "OpenAI",
    fields: [
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "baseUrl", label: "Base URL (optional)", type: "text" },
    ],
  },
  anthropic: {
    label: "Anthropic",
    fields: [
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "baseUrl", label: "Base URL (optional)", type: "text" },
    ],
  },
};

function providerLabel(name: string): string {
  return KNOWN_PROVIDERS[name]?.label ?? name;
}

const CUSTOM_VALUE = "__custom__";

interface Props {
  onSaved?: () => void;
}

export function ProviderSetup({ onSaved }: Props) {
  const [providers, setProviders] = useState<Record<string, ProviderConnection>>({});
  const [defaultModels, setDefaultModels] = useState<ModelEntry[]>([]);
  const [status, setStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
    type: "idle",
  });
  const [loading, setLoading] = useState(true);

  // model lists fetched from providers: { [providerName]: string[] }
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  // per-model metadata (context window, etc.) keyed by `${provider}:${modelId}`
  const [modelInfo, setModelInfo] = useState<Record<string, ModelInfo>>({});
  // tracks which model entries are in "custom" mode (typing a free-form name)
  // key format: `${listId}:${index}` where listId is "default" or profile name
  const [customMode, setCustomMode] = useState<Set<string>>(new Set());

  const ingestModelInfo = useCallback((provider: string, info: Record<string, ModelInfo> | undefined) => {
    if (!info) return;
    setModelInfo((prev) => {
      const next = { ...prev };
      for (const [modelId, meta] of Object.entries(info)) {
        next[`${provider}:${modelId}`] = meta;
      }
      return next;
    });
  }, []);

  const loadModels = useCallback(
    (providerName: string) => {
      if (providerModels[providerName]) return; // already loaded
      fetchModels(providerName)
        .then((data) => {
          setProviderModels((prev) => ({ ...prev, [providerName]: data.models }));
          ingestModelInfo(providerName, data.modelInfo);
        })
        .catch(() => {
          setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
        });
    },
    [providerModels, ingestModelInfo],
  );

  useEffect(() => {
    fetchProviders()
      .then((provData) => {
        setProviders(provData.providers);
        setDefaultModels(provData.defaultModels);

        // Kick off model fetches for all configured providers
        for (const name of Object.keys(provData.providers)) {
          fetchModels(name)
            .then((data) => {
              setProviderModels((prev) => ({ ...prev, [name]: data.models }));
              ingestModelInfo(name, data.modelInfo);
              // Mark entries whose current model is not in the fetched list as custom
              const initCustom = new Set<string>();
              provData.defaultModels.forEach((entry, i) => {
                if (entry.provider === name && entry.model && !data.models.includes(entry.model)) {
                  initCustom.add(`default:${i}`);
                }
              });
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
  }, [ingestModelInfo]);

  // When server-side modelInfo arrives, backfill maxContextTokens on entries
  // that don't already have one set. Only fills in known providers/models.
  useEffect(() => {
    if (Object.keys(modelInfo).length === 0) return;
    setDefaultModels((prev) => {
      let changed = false;
      const next = prev.map((entry) => {
        if (entry.maxContextTokens !== undefined) return entry;
        const meta = modelInfo[`${entry.provider}:${entry.model}`];
        if (meta?.maxContextTokens) {
          changed = true;
          return { ...entry, maxContextTokens: meta.maxContextTokens };
        }
        return entry;
      });
      return changed ? next : prev;
    });
  }, [modelInfo]);

  // --- Provider connection helpers ---

  const configuredProviders = Object.keys(providers);
  const availableToAdd = Object.keys(KNOWN_PROVIDERS).filter((p) => !providers[p]);

  function getField(name: string, key: string): string {
    const p = providers[name];
    if (!p) return "";
    return ((p as Record<string, unknown>)[key] as string) ?? "";
  }

  function setField(name: string, key: string, value: string) {
    setProviders((prev) => ({
      ...prev,
      [name]: { ...prev[name], [key]: value },
    }));
  }

  function addProvider(name: string) {
    const def = KNOWN_PROVIDERS[name];
    const initial: ProviderConnection = {};
    if (def) {
      for (const f of def.fields) {
        (initial as Record<string, string>)[f.key] = "";
      }
    }
    setProviders((prev) => ({ ...prev, [name]: initial }));
    // Don't fetch models yet — server doesn't know about this provider until save.
    // Models will load after handleSave() invalidates the cache.
  }

  function removeProvider(name: string) {
    setProviders((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  // --- Model list helpers ---

  function moveModel(list: ModelEntry[], index: number, direction: -1 | 1): ModelEntry[] {
    const next = [...list];
    const target = index + direction;
    if (target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  function removeModel(list: ModelEntry[], index: number): ModelEntry[] {
    return list.filter((_, i) => i !== index);
  }

  function addModel(list: ModelEntry[]): ModelEntry[] {
    const firstProvider = configuredProviders[0] ?? "openai_compatible";
    return [...list, { provider: firstProvider, model: "" }];
  }

  function updateModel(list: ModelEntry[], index: number, field: keyof ModelEntry, value: string): ModelEntry[] {
    return list.map((entry, i) => {
      if (i !== index) return entry;
      const next = { ...entry, [field]: value } as ModelEntry;
      // When the model id changes, auto-populate maxContextTokens from server
      // metadata (e.g. vLLM's max_model_len) — but only if the user hasn't
      // already set one for this entry.
      if (field === "model" && entry.maxContextTokens === undefined) {
        const meta = modelInfo[`${entry.provider}:${value}`];
        if (meta?.maxContextTokens) {
          next.maxContextTokens = meta.maxContextTokens;
        }
      }
      return next;
    });
  }

  // --- Custom mode helpers ---

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

  // When provider changes, ensure models are loaded and reset custom mode
  function handleProviderChange(
    list: ModelEntry[],
    index: number,
    listId: string,
    newProvider: string,
    onChange: (m: ModelEntry[]) => void,
  ) {
    loadModels(newProvider);
    setCustom(listId, index, false);
    onChange(updateModel(list, index, "provider", newProvider));
  }

  // --- Save ---

  async function handleSave() {
    setStatus({ type: "saving" });
    try {
      const payload: ProvidersData = { providers, defaultModels, agentModels: {} };
      const result = await saveProviders(payload);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "saved", message: "Saved" });
        setTimeout(() => setStatus({ type: "idle" }), 3000);
        // Invalidate cached model lists so dropdowns refetch against the
        // freshly-saved provider config (new baseUrl, apiKey, etc.).
        setProviderModels({});
        for (const name of Object.keys(providers)) {
          fetchModels(name)
            .then((data) => setProviderModels((prev) => ({ ...prev, [name]: data.models })))
            .catch(() => setProviderModels((prev) => ({ ...prev, [name]: [] })));
        }
        onSaved?.();
      }
    } catch (e) {
      setStatus({ type: "error", message: (e as Error).message });
    }
  }

  // All provider names that should appear in model dropdowns (configured ones)
  const providerOptions = configuredProviders.length > 0 ? configuredProviders : Object.keys(KNOWN_PROVIDERS);

  // --- Render model selector (dropdown or text input) ---

  function renderModelSelector(
    entry: ModelEntry,
    index: number,
    listId: string,
    models: ModelEntry[],
    onChange: (m: ModelEntry[]) => void,
  ) {
    const available = providerModels[entry.provider] ?? [];
    const custom = isCustom(listId, index);

    if (custom || available.length === 0) {
      // Free-form text input with a back-to-dropdown link if models exist
      return (
        <div className="model-entry-model-wrap">
          <input
            className="model-entry-model"
            type="text"
            value={entry.model}
            onChange={(e) => onChange(updateModel(models, index, "model", e.target.value))}
            placeholder="model name"
          />
          {available.length > 0 && (
            <button
              type="button"
              className="model-entry-toggle"
              title="Pick from list"
              onClick={() => setCustom(listId, index, false)}
            >
              &#x25BC;
            </button>
          )}
        </div>
      );
    }

    // Dropdown with models + custom option
    const currentInList = available.includes(entry.model);
    return (
      <select
        className="model-entry-model"
        value={currentInList ? entry.model : CUSTOM_VALUE}
        onChange={(e) => {
          if (e.target.value === CUSTOM_VALUE) {
            setCustom(listId, index, true);
          } else {
            onChange(updateModel(models, index, "model", e.target.value));
          }
        }}
      >
        {!entry.model && (
          <option value="" disabled>
            Select model...
          </option>
        )}
        {available.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={CUSTOM_VALUE}>Custom...</option>
      </select>
    );
  }

  // --- Render model list ---

  function renderModelList(listId: string, models: ModelEntry[], onChange: (models: ModelEntry[]) => void) {
    return (
      <div className="model-list">
        {models.map((entry, i) => (
          <div key={i} className="model-entry">
            <span className="model-entry-number">{i + 1}</span>
            <select
              className="model-entry-provider"
              value={entry.provider}
              onChange={(e) => handleProviderChange(models, i, listId, e.target.value, onChange)}
            >
              {providerOptions.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p)}
                </option>
              ))}
              {!providerOptions.includes(entry.provider) && (
                <option value={entry.provider}>{providerLabel(entry.provider)}</option>
              )}
            </select>
            {renderModelSelector(entry, i, listId, models, onChange)}
            <input
              className="model-entry-context"
              type="number"
              min={1}
              step={1024}
              value={entry.maxContextTokens ?? ""}
              placeholder={
                modelInfo[`${entry.provider}:${entry.model}`]?.maxContextTokens
                  ? `auto: ${modelInfo[`${entry.provider}:${entry.model}`]!.maxContextTokens}`
                  : "ctx (tokens)"
              }
              title="Context window for this model, in tokens. Auto-detected from the provider's /models response (vLLM advertises this as max_model_len); editable to override."
              onChange={(e) => {
                const raw = e.target.value;
                const num = raw === "" ? undefined : Number(raw);
                onChange(
                  models.map((m, idx) =>
                    idx === i ? { ...m, maxContextTokens: Number.isFinite(num) ? num : undefined } : m,
                  ),
                );
              }}
            />
            <div className="model-entry-actions">
              <button
                type="button"
                title="Move up"
                disabled={i === 0}
                onClick={() => onChange(moveModel(models, i, -1))}
              >
                &#x25B2;
              </button>
              <button
                type="button"
                title="Move down"
                disabled={i === models.length - 1}
                onClick={() => onChange(moveModel(models, i, 1))}
              >
                &#x25BC;
              </button>
              <button type="button" title="Remove" onClick={() => onChange(removeModel(models, i))}>
                &#x2715;
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="model-add-btn" onClick={() => onChange(addModel(models))}>
          + Add
        </button>
      </div>
    );
  }

  // --- Loading state ---

  if (loading) {
    return (
      <div className="provider-section">
        <div className="provider-header">
          <h3>Provider Setup</h3>
        </div>
        <div className="provider-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="provider-card skeleton-pulse" style={{ height: 120 }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="provider-section">
      <div className="provider-header">
        <h3>Provider Setup</h3>
        <div className="config-actions">
          {status.type === "saved" && <span className="config-saved">{status.message}</span>}
          {status.type === "error" && <span className="config-error">{status.message}</span>}
          <button type="button" className="config-save-btn" onClick={handleSave} disabled={status.type === "saving"}>
            {status.type === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Section 1: Provider Connections */}
      <h4 className="provider-section-title">Connections</h4>
      {configuredProviders.length === 0 && <p className="provider-section-desc">No providers configured yet.</p>}
      <div className="provider-grid">
        {configuredProviders.map((name) => {
          const def = KNOWN_PROVIDERS[name];
          const fields = def?.fields ?? [
            { key: "apiKey", label: "API Key", type: "password" },
            { key: "baseUrl", label: "Base URL", type: "text" },
          ];
          return (
            <div key={name} className="provider-card">
              <div className="provider-card-header">
                <span className="provider-card-name">{providerLabel(name)}</span>
                <button
                  type="button"
                  className="provider-remove-btn"
                  onClick={() => removeProvider(name)}
                  title="Remove provider"
                >
                  &#x2715;
                </button>
              </div>
              <div className="provider-fields">
                {fields.map((field) => (
                  <div key={field.key} className="provider-field">
                    <label className="provider-field-label">{field.label}</label>
                    <input
                      className="provider-input"
                      type={field.type}
                      value={getField(name, field.key)}
                      onChange={(e) => setField(name, field.key, e.target.value)}
                      placeholder={field.placeholder ?? ""}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {availableToAdd.length > 0 && (
        <select
          className="action-select"
          value=""
          onChange={(e) => {
            if (e.target.value) {
              addProvider(e.target.value);
              e.target.value = "";
            }
          }}
        >
          <option value="" disabled>
            + Add provider...
          </option>
          {availableToAdd.map((name) => (
            <option key={name} value={name}>
              {providerLabel(name)}
            </option>
          ))}
        </select>
      )}

      {/* Section 2: Default Models */}
      <h4 className="provider-section-title">Default Models</h4>
      <p className="provider-section-desc">
        Ordered priority list. The first available provider+model is used at runtime.
      </p>
      {renderModelList("default", defaultModels, setDefaultModels)}
    </div>
  );
}
