// Shared types for the Ink editor. The pure helpers in setup.ts (renderNewConfig,
// patchExistingYaml, hydrateFromYaml, resolveOnePlugin) operate on these same
// shapes — the Ink app is just a different driver.

export type ProviderKind = "openai_compatible" | "openai" | "anthropic";

export interface ProviderDraft {
  kind: ProviderKind;
  defaultModel: string;
  apiKey?: string;
  baseUrl?: string;
  /** Display name for openai_compatible presets (vLLM, Ollama, etc.). */
  presetName?: string;
}

export interface ToolsDraft {
  memory: boolean;
  exec: boolean;
  read: boolean;
  write: boolean;
  web_fetch: boolean;
  web_search: boolean;
}

export interface ResolvedPlugin {
  uri: string;
  manifestId?: string;
  version?: string;
  /** Set when the loader rejected the URI. */
  resolveError?: string;
}

/**
 * Slot for swappable subsystems. "builtin" means use the default; a string is
 * a plugin URI (npm:/tai-registry:/git:) that will replace the built-in once
 * the matching package ships. "disabled" is currently only valid for `ui`.
 */
export type SlotChoice = "builtin" | "disabled" | { customUri: string };

export interface DraftConfig {
  homeDir: string;
  provider: ProviderDraft;
  tools: ToolsDraft;
  channels: { discord: boolean };
  plugins: ResolvedPlugin[];
  /** Web UI — "builtin" serves bundled UI, "disabled" skips serving entirely. */
  ui: SlotChoice;
  /** Memory backend. "disabled" not allowed (kept symmetric for future). */
  memory: SlotChoice;
  /** Task backend. "disabled" not allowed. */
  taskBackend: SlotChoice;
  /**
   * Externally-loaded agent URIs (npm/git/file/https/tai-registry). At
   * runtime these are resolved through `loadExternalAgents` and registered
   * into the AgentRegistry, sitting alongside agents defined inline under
   * `agents:`.
   */
  externalAgents: ResolvedPlugin[];
  /** Lines appended to .env (API keys, etc.). */
  envLines: string[];
}

export const DEFAULT_TOOLS: ToolsDraft = {
  memory: true,
  exec: true,
  read: true,
  write: true,
  web_fetch: true,
  web_search: false,
};

export function defaultDraft(homeDir: string): DraftConfig {
  return {
    homeDir,
    provider: { kind: "anthropic", defaultModel: "claude-sonnet-4-5-20250929" },
    tools: { ...DEFAULT_TOOLS },
    channels: { discord: false },
    plugins: [],
    ui: "builtin",
    memory: "builtin",
    taskBackend: "builtin",
    externalAgents: [],
    envLines: [],
  };
}
