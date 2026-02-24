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

interface Props {
  section?: string;
}

export function Config({ section }: Props) {
  const active = section || "providers";

  function setSection(s: string) {
    window.location.hash = s === "providers" ? "/config" : `/config/${s}`;
  }

  // --- Raw YAML editor state ---
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [yamlStatus, setYamlStatus] = useState<{ type: "idle" | "saving" | "saved" | "error"; message?: string }>({
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
        .catch(() => {});
    }
  }, [active, configGen]);

  async function handleYamlSave() {
    setYamlStatus({ type: "saving" });
    try {
      const result = await saveConfig(content);
      if (result.error) {
        setYamlStatus({ type: "error", message: result.error });
      } else {
        setYamlStatus({ type: "saved", message: result.message });
        setTimeout(() => setYamlStatus({ type: "idle" }), 4000);
      }
    } catch (e) {
      setYamlStatus({ type: "error", message: (e as Error).message });
    }
  }

  function handleSectionSaved() {
    setConfigGen((g) => g + 1);
  }

  function renderContent() {
    switch (active) {
      case "providers":
        return <ProviderSetup onSaved={handleSectionSaved} />;
      case "discord":
        return <DiscordSetup />;
      case "agents":
        return <AgentEditor />;
      case "profiles": // deprecated route, redirect to agents
        return <AgentEditor />;
      case "tools":
        return <ToolConfigEditor />;
      case "custom_tools":
        return <CustomToolEditor />;
      case "cron":
        return <CronEditor />;
      case "task_watcher":
        return <TaskWatcherEditor />;
      case "webhooks":
        return <WebhookEditor />;
      case "commands":
        return <CommandEditor />;
      case "yaml":
        return (
          <>
            <div className="config-header">
              <div>
                <h2>Raw Configuration</h2>
                <span className="config-path">{path}</span>
              </div>
              <div className="config-actions">
                {yamlStatus.type === "saved" && <span className="config-saved">{yamlStatus.message}</span>}
                {yamlStatus.type === "error" && <span className="config-error">{yamlStatus.message}</span>}
                <button
                  type="button"
                  className="config-save-btn"
                  onClick={handleYamlSave}
                  disabled={yamlStatus.type === "saving"}
                >
                  {yamlStatus.type === "saving" ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
            <textarea
              className="config-editor"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
            />
          </>
        );
      default:
        return null;
    }
  }

  return (
    <div className="config-layout">
      <ConfigSidebar active={active} onChange={setSection} />
      <div className="config-content">
        {renderContent()}
      </div>
    </div>
  );
}
