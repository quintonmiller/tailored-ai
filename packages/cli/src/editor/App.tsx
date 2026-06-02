import { TextInput } from "@inkjs/ui";
import { Box, Text, useApp, useInput } from "ink";
import { useMemo, useReducer } from "react";
import { DetailPane } from "./DetailPane.js";
import { DiffPane } from "./DiffPane.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { MenuPane } from "./MenuPane.js";
import { AgentsEditor } from "./editors/AgentsEditor.js";
import { ChannelsEditor } from "./editors/ChannelsEditor.js";
import { PluginsEditor } from "./editors/PluginsEditor.js";
import { ProviderEditor } from "./editors/ProviderEditor.js";
import { SlotEditor } from "./editors/SlotEditor.js";
import { SystemPromptEditor } from "./editors/SystemPromptEditor.js";
import { ToolsEditor } from "./editors/ToolsEditor.js";
import { computeDiff, previewExisting, previewNew } from "./preview.js";
import { type Action, type AppState, type DetailMode, initialState, reducer } from "./state.js";
import { YamlPane } from "./YamlPane.js";
import type { DraftConfig } from "./types.js";

interface Props {
  initialDraft: DraftConfig;
  mode: "new" | "existing";
  originalText?: string;
  onSave: (draft: DraftConfig) => void;
  onCancel: () => void;
}

const DETAIL_MODES: DetailMode[] = ["details", "yaml", "diff"];

export function App({ initialDraft, mode, originalText, onSave, onCancel }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState(initialDraft, originalText));
  const { exit } = useApp();

  const preview = useMemo(() => {
    return mode === "existing" && originalText ? previewExisting(originalText, state.draft) : previewNew(state.draft);
  }, [mode, originalText, state.draft]);
  const diff = useMemo(() => (originalText ? computeDiff(originalText, preview.text) : []), [originalText, preview.text]);

  useInput((input, key) => {
    if (state.showHelp) {
      if (input === "?" || key.escape) dispatch({ type: "toggleHelp" });
      return;
    }
    if (state.searching) {
      // TextInput owns input — handle esc to cancel search.
      if (key.escape) {
        dispatch({ type: "setSearch", search: "" });
        dispatch({ type: "setSearching", searching: false });
      }
      return;
    }
    if (state.editing) return; // active editor owns input

    if (input === "?") {
      dispatch({ type: "toggleHelp" });
      return;
    }
    if (input === "/") {
      dispatch({ type: "setSearching", searching: true });
      return;
    }
    if (input === "q" || key.escape) {
      onCancel();
      exit();
      return;
    }
    if (input === "s") {
      if (mode === "new" && !state.draft.provider.defaultModel) {
        dispatch({ type: "setStatus", status: "Provider needs a model before save." });
        return;
      }
      onSave(state.draft);
      exit();
      return;
    }
    if (input === "u") {
      dispatch({ type: "undo" });
      return;
    }
    if (key.tab) {
      const i = DETAIL_MODES.indexOf(state.detailMode);
      dispatch({ type: "setDetailMode", mode: DETAIL_MODES[(i + 1) % DETAIL_MODES.length] });
      return;
    }
    if (key.upArrow || input === "k") {
      dispatch({ type: "selectPrev" });
      return;
    }
    if (key.downArrow || input === "j") {
      dispatch({ type: "selectNext" });
      return;
    }
    if (key.return) {
      dispatch({ type: "enterEditor" });
    }
  });

  if (state.showHelp) {
    return <HelpOverlay />;
  }

  const title = mode === "new" ? "Configure tailored-ai" : "Edit configuration";
  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold>{title}</Text>
        <Text dimColor> — {state.draft.homeDir}</Text>
      </Box>
      <Box>
        <MenuPane state={state} />
        <Box flexDirection="column" flexGrow={1} paddingX={1} borderStyle="single" borderColor="gray">
          {state.editing ? (
            <EditorSwitch state={state} dispatch={dispatch} />
          ) : state.detailMode === "yaml" ? (
            <YamlPane text={preview.text} />
          ) : state.detailMode === "diff" ? (
            <DiffPane lines={diff} />
          ) : (
            <DetailPane state={state} />
          )}
        </Box>
      </Box>
      <Box paddingX={1} flexDirection="column">
        {state.searching ? (
          <Box>
            <Text dimColor>filter: </Text>
            <TextInput
              defaultValue={state.search}
              onChange={(v) => dispatch({ type: "setSearch", search: v })}
              onSubmit={() => dispatch({ type: "setSearching", searching: false })}
            />
          </Box>
        ) : (
          <Text dimColor>
            {state.status ?? "↑↓ navigate · enter edit · tab cycle pane · / search · ? help · s save · q quit"}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function EditorSwitch({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
  const onExit = () => dispatch({ type: "exitEditor" });
  switch (state.selected) {
    case "provider":
      return (
        <ProviderEditor
          provider={state.draft.provider}
          homeDir={state.draft.homeDir}
          dispatch={dispatch}
          onExit={onExit}
        />
      );
    case "tools":
      return (
        <ToolsEditor
          tools={state.draft.tools}
          homeDir={state.draft.homeDir}
          dispatch={dispatch}
          onExit={onExit}
        />
      );
    case "channels":
      return (
        <ChannelsEditor
          discord={state.draft.channels.discord}
          plugins={state.draft.plugins}
          homeDir={state.draft.homeDir}
          dispatch={dispatch}
          onExit={onExit}
        />
      );
    case "plugins":
      return (
        <PluginsEditor
          plugins={state.draft.plugins}
          homeDir={state.draft.homeDir}
          dispatch={dispatch}
          onExit={onExit}
        />
      );
    case "ui":
      return (
        <SlotEditor
          label="UI"
          current={state.draft.ui}
          allowDisabled
          allowCustom
          toAction={(choice) => ({ type: "setUi", choice })}
          toPluginAction={(plugin) => ({ type: "addPlugin", plugin })}
          homeDir={state.draft.homeDir}
          dispatch={dispatch}
          onExit={onExit}
        />
      );
    case "memory":
      return (
        <SlotEditor
          label="Memory backend"
          current={state.draft.memory}
          allowDisabled={false}
          allowCustom
          toAction={(choice) => ({ type: "setMemory", choice })}
          toPluginAction={(plugin) => ({ type: "addPlugin", plugin })}
          homeDir={state.draft.homeDir}
          dispatch={dispatch}
          onExit={onExit}
        />
      );
    case "task":
      return (
        <SlotEditor
          label="Task backend"
          current={state.draft.taskBackend}
          allowDisabled={false}
          allowCustom
          toAction={(choice) => ({ type: "setTaskBackend", choice })}
          toPluginAction={(plugin) => ({ type: "addPlugin", plugin })}
          homeDir={state.draft.homeDir}
          dispatch={dispatch}
          onExit={onExit}
        />
      );
    case "agents":
      return (
        <AgentsEditor
          agents={state.draft.externalAgents}
          homeDir={state.draft.homeDir}
          dispatch={dispatch}
          onExit={onExit}
        />
      );
    case "systemPrompt":
      return (
        <SystemPromptEditor current={state.draft.systemPromptBaseFile} dispatch={dispatch} onExit={onExit} />
      );
  }
}
