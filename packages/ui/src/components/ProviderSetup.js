import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { fetchProviders, fetchModels, saveProviders, } from "../api";
/** Known provider definitions — fields needed for each provider type. */
const KNOWN_PROVIDERS = {
    ollama: {
        label: "Ollama",
        fields: [{ key: "baseUrl", label: "Base URL", type: "text", placeholder: "http://localhost:11434" }],
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
function providerLabel(name) {
    return KNOWN_PROVIDERS[name]?.label ?? name;
}
const CUSTOM_VALUE = "__custom__";
export function ProviderSetup({ onSaved }) {
    const [providers, setProviders] = useState({});
    const [defaultModels, setDefaultModels] = useState([]);
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    // model lists fetched from providers: { [providerName]: string[] }
    const [providerModels, setProviderModels] = useState({});
    // tracks which model entries are in "custom" mode (typing a free-form name)
    // key format: `${listId}:${index}` where listId is "default" or profile name
    const [customMode, setCustomMode] = useState(new Set());
    const loadModels = useCallback((providerName) => {
        if (providerModels[providerName])
            return; // already loaded
        fetchModels(providerName)
            .then((data) => {
            setProviderModels((prev) => ({ ...prev, [providerName]: data.models }));
        })
            .catch(() => {
            setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
        });
    }, [providerModels]);
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
                    // Mark entries whose current model is not in the fetched list as custom
                    const initCustom = new Set();
                    provData.defaultModels.forEach((entry, i) => {
                        if (entry.provider === name && entry.model && !data.models.includes(entry.model)) {
                            initCustom.add(`default:${i}`);
                        }
                    });
                    if (initCustom.size > 0) {
                        setCustomMode((prev) => {
                            const next = new Set(prev);
                            for (const k of initCustom)
                                next.add(k);
                            return next;
                        });
                    }
                })
                    .catch(() => {
                    setProviderModels((prev) => ({ ...prev, [name]: [] }));
                });
            }
        })
            .catch(() => { })
            .finally(() => setLoading(false));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // --- Provider connection helpers ---
    const configuredProviders = Object.keys(providers);
    const availableToAdd = Object.keys(KNOWN_PROVIDERS).filter((p) => !providers[p]);
    function getField(name, key) {
        const p = providers[name];
        if (!p)
            return "";
        return p[key] ?? "";
    }
    function setField(name, key, value) {
        setProviders((prev) => ({
            ...prev,
            [name]: { ...prev[name], [key]: value },
        }));
    }
    function addProvider(name) {
        const def = KNOWN_PROVIDERS[name];
        const initial = {};
        if (def) {
            for (const f of def.fields) {
                initial[f.key] = "";
            }
        }
        setProviders((prev) => ({ ...prev, [name]: initial }));
        loadModels(name);
    }
    function removeProvider(name) {
        setProviders((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
    }
    // --- Model list helpers ---
    function moveModel(list, index, direction) {
        const next = [...list];
        const target = index + direction;
        if (target < 0 || target >= next.length)
            return next;
        [next[index], next[target]] = [next[target], next[index]];
        return next;
    }
    function removeModel(list, index) {
        return list.filter((_, i) => i !== index);
    }
    function addModel(list) {
        const firstProvider = configuredProviders[0] ?? "ollama";
        return [...list, { provider: firstProvider, model: "" }];
    }
    function updateModel(list, index, field, value) {
        return list.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry));
    }
    // --- Custom mode helpers ---
    function isCustom(listId, index) {
        return customMode.has(`${listId}:${index}`);
    }
    function setCustom(listId, index, on) {
        setCustomMode((prev) => {
            const next = new Set(prev);
            if (on)
                next.add(`${listId}:${index}`);
            else
                next.delete(`${listId}:${index}`);
            return next;
        });
    }
    // When provider changes, ensure models are loaded and reset custom mode
    function handleProviderChange(list, index, listId, newProvider, onChange) {
        loadModels(newProvider);
        setCustom(listId, index, false);
        onChange(updateModel(list, index, "provider", newProvider));
    }
    // --- Save ---
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            const payload = { providers, defaultModels, agentModels: {} };
            const result = await saveProviders(payload);
            if (result.error) {
                setStatus({ type: "error", message: result.error });
            }
            else {
                setStatus({ type: "saved", message: "Saved" });
                setTimeout(() => setStatus({ type: "idle" }), 3000);
                onSaved?.();
            }
        }
        catch (e) {
            setStatus({ type: "error", message: e.message });
        }
    }
    // All provider names that should appear in model dropdowns (configured ones)
    const providerOptions = configuredProviders.length > 0
        ? configuredProviders
        : Object.keys(KNOWN_PROVIDERS);
    // --- Render model selector (dropdown or text input) ---
    function renderModelSelector(entry, index, listId, models, onChange) {
        const available = providerModels[entry.provider] ?? [];
        const custom = isCustom(listId, index);
        if (custom || available.length === 0) {
            // Free-form text input with a back-to-dropdown link if models exist
            return (_jsxs("div", { className: "model-entry-model-wrap", children: [_jsx("input", { className: "model-entry-model", type: "text", value: entry.model, onChange: (e) => onChange(updateModel(models, index, "model", e.target.value)), placeholder: "model name" }), available.length > 0 && (_jsx("button", { type: "button", className: "model-entry-toggle", title: "Pick from list", onClick: () => setCustom(listId, index, false), children: "\u25BC" }))] }));
        }
        // Dropdown with models + custom option
        const currentInList = available.includes(entry.model);
        return (_jsxs("select", { className: "model-entry-model", value: currentInList ? entry.model : CUSTOM_VALUE, onChange: (e) => {
                if (e.target.value === CUSTOM_VALUE) {
                    setCustom(listId, index, true);
                }
                else {
                    onChange(updateModel(models, index, "model", e.target.value));
                }
            }, children: [!entry.model && _jsx("option", { value: "", disabled: true, children: "Select model..." }), available.map((m) => (_jsx("option", { value: m, children: m }, m))), _jsx("option", { value: CUSTOM_VALUE, children: "Custom..." })] }));
    }
    // --- Render model list ---
    function renderModelList(listId, models, onChange) {
        return (_jsxs("div", { className: "model-list", children: [models.map((entry, i) => (_jsxs("div", { className: "model-entry", children: [_jsx("span", { className: "model-entry-number", children: i + 1 }), _jsxs("select", { className: "model-entry-provider", value: entry.provider, onChange: (e) => handleProviderChange(models, i, listId, e.target.value, onChange), children: [providerOptions.map((p) => (_jsx("option", { value: p, children: providerLabel(p) }, p))), !providerOptions.includes(entry.provider) && (_jsx("option", { value: entry.provider, children: providerLabel(entry.provider) }))] }), renderModelSelector(entry, i, listId, models, onChange), _jsxs("div", { className: "model-entry-actions", children: [_jsx("button", { type: "button", title: "Move up", disabled: i === 0, onClick: () => onChange(moveModel(models, i, -1)), children: "\u25B2" }), _jsx("button", { type: "button", title: "Move down", disabled: i === models.length - 1, onClick: () => onChange(moveModel(models, i, 1)), children: "\u25BC" }), _jsx("button", { type: "button", title: "Remove", onClick: () => onChange(removeModel(models, i)), children: "\u2715" })] })] }, i))), _jsx("button", { type: "button", className: "model-add-btn", onClick: () => onChange(addModel(models)), children: "+ Add" })] }));
    }
    // --- Loading state ---
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "provider-header", children: _jsx("h3", { children: "Provider Setup" }) }), _jsx("div", { className: "provider-grid", children: [0, 1, 2].map((i) => (_jsx("div", { className: "provider-card skeleton-pulse", style: { height: 120 } }, i))) })] }));
    }
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "provider-header", children: [_jsx("h3", { children: "Provider Setup" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), _jsx("h4", { className: "provider-section-title", children: "Connections" }), configuredProviders.length === 0 && (_jsx("p", { className: "provider-section-desc", children: "No providers configured yet." })), _jsx("div", { className: "provider-grid", children: configuredProviders.map((name) => {
                    const def = KNOWN_PROVIDERS[name];
                    const fields = def?.fields ?? [
                        { key: "apiKey", label: "API Key", type: "password" },
                        { key: "baseUrl", label: "Base URL", type: "text" },
                    ];
                    return (_jsxs("div", { className: "provider-card", children: [_jsxs("div", { className: "provider-card-header", children: [_jsx("span", { className: "provider-card-name", children: providerLabel(name) }), _jsx("button", { type: "button", className: "provider-remove-btn", onClick: () => removeProvider(name), title: "Remove provider", children: "\u2715" })] }), _jsx("div", { className: "provider-fields", children: fields.map((field) => (_jsxs("div", { className: "provider-field", children: [_jsx("label", { className: "provider-field-label", children: field.label }), _jsx("input", { className: "provider-input", type: field.type, value: getField(name, field.key), onChange: (e) => setField(name, field.key, e.target.value), placeholder: field.placeholder ?? "" })] }, field.key))) })] }, name));
                }) }), availableToAdd.length > 0 && (_jsxs("select", { className: "action-select", value: "", onChange: (e) => {
                    if (e.target.value) {
                        addProvider(e.target.value);
                        e.target.value = "";
                    }
                }, children: [_jsx("option", { value: "", disabled: true, children: "+ Add provider..." }), availableToAdd.map((name) => (_jsx("option", { value: name, children: providerLabel(name) }, name)))] })), _jsx("h4", { className: "provider-section-title", children: "Default Models" }), _jsx("p", { className: "provider-section-desc", children: "Ordered priority list. The first available provider+model is used at runtime." }), renderModelList("default", defaultModels, setDefaultModels)] }));
}
