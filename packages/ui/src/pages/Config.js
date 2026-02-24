import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchConfig, saveConfig } from "../api";
import { ConfigSidebar } from "../components/ConfigSidebar";
import { CommandEditor } from "../components/CommandEditor";
import { CronEditor } from "../components/CronEditor";
import { CustomToolEditor } from "../components/CustomToolEditor";
import { DiscordSetup } from "../components/DiscordSetup";
import { AgentEditor } from "../components/AgentEditor";
import { ProviderSetup } from "../components/ProviderSetup";
import { ToolConfigEditor } from "../components/ToolConfigEditor";
import { TaskWatcherEditor } from "../components/TaskWatcherEditor";
import { WebhookEditor } from "../components/WebhookEditor";
export function Config({ section }) {
    const active = section || "providers";
    function setSection(s) {
        window.location.hash = s === "providers" ? "/config" : `/config/${s}`;
    }
    // --- Raw YAML editor state ---
    const [content, setContent] = useState("");
    const [path, setPath] = useState("");
    const [yamlStatus, setYamlStatus] = useState({
        type: "idle",
    });
    const [configGen, setConfigGen] = useState(0);
    useEffect(() => {
        if (active === "yaml") {
            fetchConfig()
                .then((data) => {
                setContent(data.content);
                setPath(data.path);
            })
                .catch(() => { });
        }
    }, [active, configGen]);
    async function handleYamlSave() {
        setYamlStatus({ type: "saving" });
        try {
            const result = await saveConfig(content);
            if (result.error) {
                setYamlStatus({ type: "error", message: result.error });
            }
            else {
                setYamlStatus({ type: "saved", message: result.message });
                setTimeout(() => setYamlStatus({ type: "idle" }), 4000);
            }
        }
        catch (e) {
            setYamlStatus({ type: "error", message: e.message });
        }
    }
    function handleSectionSaved() {
        setConfigGen((g) => g + 1);
    }
    function renderContent() {
        switch (active) {
            case "providers":
                return _jsx(ProviderSetup, { onSaved: handleSectionSaved });
            case "discord":
                return _jsx(DiscordSetup, {});
            case "agents":
                return _jsx(AgentEditor, {});
            case "profiles": // deprecated route, redirect to agents
                return _jsx(AgentEditor, {});
            case "tools":
                return _jsx(ToolConfigEditor, {});
            case "custom_tools":
                return _jsx(CustomToolEditor, {});
            case "cron":
                return _jsx(CronEditor, {});
            case "task_watcher":
                return _jsx(TaskWatcherEditor, {});
            case "webhooks":
                return _jsx(WebhookEditor, {});
            case "commands":
                return _jsx(CommandEditor, {});
            case "yaml":
                return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "config-header", children: [_jsxs("div", { children: [_jsx("h2", { children: "Raw Configuration" }), _jsx("span", { className: "config-path", children: path })] }), _jsxs("div", { className: "config-actions", children: [yamlStatus.type === "saved" && _jsx("span", { className: "config-saved", children: yamlStatus.message }), yamlStatus.type === "error" && _jsx("span", { className: "config-error", children: yamlStatus.message }), _jsx("button", { type: "button", className: "config-save-btn", onClick: handleYamlSave, disabled: yamlStatus.type === "saving", children: yamlStatus.type === "saving" ? "Saving..." : "Save" })] })] }), _jsx("textarea", { className: "config-editor", value: content, onChange: (e) => setContent(e.target.value), spellCheck: false })] }));
            default:
                return null;
        }
    }
    return (_jsxs("div", { className: "config-layout", children: [_jsx(ConfigSidebar, { active: active, onChange: setSection }), _jsx("div", { className: "config-content", children: renderContent() })] }));
}
