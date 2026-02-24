import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { fetchConfigSection, fetchModels, fetchProviders, saveConfigSection } from "../api";
const CUSTOM_VALUE = "__custom__";
function providerLabel(name) {
    const labels = { ollama: "Ollama", openai: "OpenAI", anthropic: "Anthropic" };
    return labels[name] ?? name;
}
export function AgentEditor() {
    const [agents, setAgents] = useState({});
    const [status, setStatus] = useState({
        type: "idle",
    });
    const [loading, setLoading] = useState(true);
    // Provider data for model dropdowns
    const [providerNames, setProviderNames] = useState([]);
    const [providerModels, setProviderModels] = useState({});
    const [customMode, setCustomMode] = useState(new Set());
    const loadModels = useCallback((providerName) => {
        if (providerModels[providerName])
            return;
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
            fetchConfigSection("agents"),
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
                    const initCustom = new Set();
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
    async function handleSave() {
        setStatus({ type: "saving" });
        try {
            // Derive legacy model/provider from models list for backward compat
            const payload = {};
            for (const [name, agentDef] of Object.entries(agents)) {
                const a = { ...agentDef };
                if (a.models && a.models.length > 0) {
                    a.model = a.models[0].model;
                    a.provider = a.models[0].provider;
                }
                else {
                    delete a.models;
                    delete a.model;
                    delete a.provider;
                }
                payload[name] = a;
            }
            const result = await saveConfigSection("agents", payload);
            if (result.error) {
                setStatus({ type: "error", message: result.error });
            }
            else {
                setStatus({ type: "saved", message: "Saved" });
                setTimeout(() => setStatus({ type: "idle" }), 3000);
            }
        }
        catch (e) {
            setStatus({ type: "error", message: e.message });
        }
    }
    function addAgent() {
        const name = `agent_${Date.now()}`;
        setAgents((prev) => ({
            ...prev,
            [name]: { instructions: "" },
        }));
    }
    function removeAgent(name) {
        setAgents((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
    }
    function renameAgent(oldName, newName) {
        if (newName === oldName || !newName.trim())
            return;
        setAgents((prev) => {
            const next = {};
            for (const [k, v] of Object.entries(prev)) {
                next[k === oldName ? newName : k] = v;
            }
            return next;
        });
        // Update customMode keys
        setCustomMode((prev) => {
            const next = new Set();
            for (const key of prev) {
                if (key.startsWith(`${oldName}:`)) {
                    next.add(`${newName}:${key.slice(oldName.length + 1)}`);
                }
                else {
                    next.add(key);
                }
            }
            return next;
        });
    }
    function updateAgent(name, field, value) {
        setAgents((prev) => ({
            ...prev,
            [name]: { ...prev[name], [field]: value },
        }));
    }
    // --- Model list helpers ---
    const providerOptions = providerNames.length > 0 ? providerNames : ["ollama", "openai", "anthropic"];
    function getModels(agentName) {
        return agents[agentName]?.models ?? [];
    }
    function setModels(agentName, models) {
        updateAgent(agentName, "models", models.length > 0 ? models : undefined);
    }
    function addModelEntry(agentName) {
        const firstProvider = providerOptions[0];
        setModels(agentName, [...getModels(agentName), { provider: firstProvider, model: "" }]);
    }
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
    function renderModelList(agentName) {
        const models = getModels(agentName);
        function update(index, field, value) {
            setModels(agentName, models.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
        }
        function remove(index) {
            setModels(agentName, models.filter((_, i) => i !== index));
        }
        function move(index, dir) {
            const next = [...models];
            const target = index + dir;
            if (target < 0 || target >= next.length)
                return;
            [next[index], next[target]] = [next[target], next[index]];
            setModels(agentName, next);
        }
        return (_jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Models (priority list)" }), models.length > 0 && (_jsx("div", { className: "model-list", children: models.map((entry, i) => {
                        const available = providerModels[entry.provider] ?? [];
                        const custom = isCustom(agentName, i);
                        return (_jsxs("div", { className: "model-entry", children: [_jsx("span", { className: "model-entry-number", children: i + 1 }), _jsxs("select", { className: "model-entry-provider", value: entry.provider, onChange: (e) => {
                                        loadModels(e.target.value);
                                        setCustom(agentName, i, false);
                                        update(i, "provider", e.target.value);
                                    }, children: [providerOptions.map((p) => (_jsx("option", { value: p, children: providerLabel(p) }, p))), !providerOptions.includes(entry.provider) && (_jsx("option", { value: entry.provider, children: providerLabel(entry.provider) }))] }), custom || available.length === 0 ? (_jsxs("div", { className: "model-entry-model-wrap", children: [_jsx("input", { className: "model-entry-model", type: "text", value: entry.model, onChange: (e) => update(i, "model", e.target.value), placeholder: "model name" }), available.length > 0 && (_jsx("button", { type: "button", className: "model-entry-toggle", title: "Pick from list", onClick: () => setCustom(agentName, i, false), children: "\u25BC" }))] })) : (_jsxs("select", { className: "model-entry-model", value: available.includes(entry.model) ? entry.model : CUSTOM_VALUE, onChange: (e) => {
                                        if (e.target.value === CUSTOM_VALUE) {
                                            setCustom(agentName, i, true);
                                        }
                                        else {
                                            update(i, "model", e.target.value);
                                        }
                                    }, children: [!entry.model && _jsx("option", { value: "", disabled: true, children: "Select model..." }), available.map((m) => (_jsx("option", { value: m, children: m }, m))), _jsx("option", { value: CUSTOM_VALUE, children: "Custom..." })] })), _jsxs("div", { className: "model-entry-actions", children: [_jsx("button", { type: "button", title: "Move up", disabled: i === 0, onClick: () => move(i, -1), children: "\u25B2" }), _jsx("button", { type: "button", title: "Move down", disabled: i === models.length - 1, onClick: () => move(i, 1), children: "\u25BC" }), _jsx("button", { type: "button", title: "Remove", onClick: () => remove(i), children: "\u2715" })] })] }, i));
                    }) })), _jsx("button", { type: "button", className: "model-add-btn", onClick: () => addModelEntry(agentName), children: "+ Add Model" })] }));
    }
    if (loading) {
        return (_jsxs("div", { className: "provider-section", children: [_jsx("div", { className: "section-header", children: _jsx("h3", { children: "Agents" }) }), _jsx("div", { className: "skeleton-card", style: { height: 120 } })] }));
    }
    const entries = Object.entries(agents);
    return (_jsxs("div", { className: "provider-section", children: [_jsxs("div", { className: "section-header", children: [_jsx("h3", { children: "Agents" }), _jsxs("div", { className: "config-actions", children: [status.type === "saved" && _jsx("span", { className: "config-saved", children: status.message }), status.type === "error" && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleSave, disabled: status.type === "saving", children: status.type === "saving" ? "Saving..." : "Save" })] })] }), entries.length === 0 && (_jsx("p", { style: { color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }, children: "No agents defined." })), entries.map(([name, agentDef]) => (_jsxs("div", { className: "section-card", children: [_jsxs("div", { className: "section-card-header", children: [_jsx("input", { className: "field-input", style: { maxWidth: 200, fontWeight: 600, color: "var(--accent)" }, value: name, onChange: (e) => renameAgent(name, e.target.value) }), _jsx("button", { type: "button", className: "section-card-remove", onClick: () => removeAgent(name), children: "\u2715" })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Description" }), _jsx("input", { className: "field-input", value: agentDef.description ?? "", onChange: (e) => updateAgent(name, "description", e.target.value || undefined), placeholder: "Short description shown in agent list" })] }), renderModelList(name), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Instructions" }), _jsx("textarea", { className: "field-textarea", value: agentDef.instructions ?? "", onChange: (e) => updateAgent(name, "instructions", e.target.value || undefined), placeholder: "System instructions for this agent", rows: 3 })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Tools (comma-separated)" }), _jsx("input", { className: "field-input", value: (agentDef.tools ?? []).join(", "), onChange: (e) => {
                                    const tools = e.target.value
                                        .split(",")
                                        .map((t) => t.trim())
                                        .filter(Boolean);
                                    updateAgent(name, "tools", tools.length > 0 ? tools : undefined);
                                }, placeholder: "web_search, memory, exec" })] }), _jsxs("div", { style: { display: "flex", gap: 12 }, children: [_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Temperature" }), _jsx("input", { className: "field-input", type: "number", step: "0.1", min: "0", max: "2", value: agentDef.temperature ?? "", onChange: (e) => updateAgent(name, "temperature", e.target.value ? Number(e.target.value) : undefined), placeholder: "0.3" })] }), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Max Tool Rounds" }), _jsx("input", { className: "field-input", type: "number", value: agentDef.maxToolRounds ?? "", onChange: (e) => updateAgent(name, "maxToolRounds", e.target.value ? Number(e.target.value) : undefined), placeholder: "10" })] }), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Nudge on Text" }), _jsx("input", { className: "field-input", type: "number", value: agentDef.nudgeOnText ?? "", onChange: (e) => updateAgent(name, "nudgeOnText", e.target.value ? Number(e.target.value) : undefined), placeholder: "0" })] })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Context Directory" }), _jsx("input", { className: "field-input", value: agentDef.contextDir ?? "", onChange: (e) => updateAgent(name, "contextDir", e.target.value || undefined), placeholder: "(optional override)" })] }), _jsx("div", { className: "field-group", children: _jsxs("div", { className: "field-row", children: [_jsx("button", { type: "button", className: `toggle-switch ${agentDef.skipGlobalContext ? "on" : "off"}`, onClick: () => updateAgent(name, "skipGlobalContext", !agentDef.skipGlobalContext), children: _jsx("span", { className: "toggle-switch-knob" }) }), _jsx("span", { className: "field-inline-label", children: "Skip Global Context" })] }) })] }, name))), _jsx("button", { type: "button", className: "section-add-btn", onClick: addAgent, children: "+ Add Agent" })] }));
}
