import type { DraftConfig, ProviderDraft, ResolvedPlugin, SlotChoice, ToolsDraft } from "./types.js";

export type RowId = "provider" | "ui" | "memory" | "tools" | "channels" | "task" | "agents" | "plugins";

export const ROWS: RowId[] = ["provider", "ui", "memory", "tools", "channels", "task", "agents", "plugins"];

export type DetailMode = "details" | "yaml" | "diff";

export interface AppState {
  draft: DraftConfig;
  /** Selected menu row. */
  selected: RowId;
  /** Right-pane mode (details vs live YAML vs diff). */
  detailMode: DetailMode;
  /** True when the focus is in an editor (vs the menu). */
  editing: boolean;
  /** Status message shown in the footer (transient). */
  status?: string;
  /** Single-level undo: previous draft snapshot. */
  previousDraft?: DraftConfig;
  /** Substring filter applied to the menu rows. */
  search: string;
  /** True when search input has focus. */
  searching: boolean;
  /** True when the help overlay is shown. */
  showHelp: boolean;
  /** Original config text for edit mode — needed for YAML preview + diff. */
  originalText?: string;
}

export type Action =
  | { type: "select"; row: RowId }
  | { type: "selectNext" }
  | { type: "selectPrev" }
  | { type: "enterEditor" }
  | { type: "exitEditor" }
  | { type: "setDetailMode"; mode: DetailMode }
  | { type: "setProvider"; provider: ProviderDraft }
  | { type: "toggleTool"; tool: keyof ToolsDraft }
  | { type: "setTools"; tools: ToolsDraft }
  | { type: "toggleDiscord" }
  | { type: "addPlugin"; plugin: ResolvedPlugin }
  | { type: "removePlugin"; index: number }
  | { type: "addExternalAgent"; agent: ResolvedPlugin }
  | { type: "removeExternalAgent"; index: number }
  | { type: "setUi"; choice: SlotChoice }
  | { type: "setMemory"; choice: SlotChoice }
  | { type: "setTaskBackend"; choice: SlotChoice }
  | { type: "setStatus"; status: string | undefined }
  | { type: "undo" }
  | { type: "setSearch"; search: string }
  | { type: "setSearching"; searching: boolean }
  | { type: "toggleHelp" };

function snapshot(state: AppState): AppState {
  return { ...state, previousDraft: structuredClone(state.draft) };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "select":
      return { ...state, selected: action.row, editing: false };
    case "selectNext": {
      const i = ROWS.indexOf(state.selected);
      return { ...state, selected: ROWS[(i + 1) % ROWS.length], editing: false };
    }
    case "selectPrev": {
      const i = ROWS.indexOf(state.selected);
      return { ...state, selected: ROWS[(i - 1 + ROWS.length) % ROWS.length], editing: false };
    }
    case "enterEditor":
      return { ...state, editing: true };
    case "exitEditor":
      return { ...state, editing: false };
    case "setDetailMode":
      return { ...state, detailMode: action.mode };
    case "setProvider":
      return { ...snapshot(state), draft: { ...state.draft, provider: action.provider } };
    case "toggleTool":
      return {
        ...snapshot(state),
        draft: { ...state.draft, tools: { ...state.draft.tools, [action.tool]: !state.draft.tools[action.tool] } },
      };
    case "setTools":
      return { ...snapshot(state), draft: { ...state.draft, tools: action.tools } };
    case "toggleDiscord":
      return {
        ...snapshot(state),
        draft: { ...state.draft, channels: { discord: !state.draft.channels.discord } },
      };
    case "addPlugin":
      return { ...snapshot(state), draft: { ...state.draft, plugins: [...state.draft.plugins, action.plugin] } };
    case "removePlugin":
      return {
        ...snapshot(state),
        draft: { ...state.draft, plugins: state.draft.plugins.filter((_, i) => i !== action.index) },
      };
    case "addExternalAgent":
      return {
        ...snapshot(state),
        draft: { ...state.draft, externalAgents: [...state.draft.externalAgents, action.agent] },
      };
    case "removeExternalAgent":
      return {
        ...snapshot(state),
        draft: {
          ...state.draft,
          externalAgents: state.draft.externalAgents.filter((_, i) => i !== action.index),
        },
      };
    case "setUi":
      return { ...snapshot(state), draft: { ...state.draft, ui: action.choice } };
    case "setMemory":
      return { ...snapshot(state), draft: { ...state.draft, memory: action.choice } };
    case "setTaskBackend":
      return { ...snapshot(state), draft: { ...state.draft, taskBackend: action.choice } };
    case "setStatus":
      return { ...state, status: action.status };
    case "undo":
      if (!state.previousDraft) return state;
      return { ...state, draft: state.previousDraft, previousDraft: undefined, status: "Undone." };
    case "setSearch":
      return { ...state, search: action.search };
    case "setSearching":
      return { ...state, searching: action.searching };
    case "toggleHelp":
      return { ...state, showHelp: !state.showHelp };
  }
}

export function initialState(draft: DraftConfig, originalText?: string): AppState {
  return {
    draft,
    selected: "provider",
    detailMode: "details",
    editing: false,
    search: "",
    searching: false,
    showHelp: false,
    originalText,
  };
}
