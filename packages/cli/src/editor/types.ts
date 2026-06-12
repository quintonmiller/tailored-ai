// Shared types for the Ink editor. The pure helpers in setup.ts (renderNewConfig,
// patchExistingYaml, hydrateFromYaml, resolveOnePlugin) operate on these same
// shapes — the Ink app is just a different driver.

/**
 * Provider factory id. The one built-in ("openai_compatible") is offered as
 * a preset; hosted vendors ("openai", "anthropic", "openrouter", "bedrock",
 * …) register their ids from plugin packages (#236) and show up through
 * discovery. Any registered provider id is valid — core resolves it through
 * the provider registry, so built-ins aren't privileged.
 */
export type ProviderKind = string;

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
  /**
   * Outbound channels keyed by channel id, mapped to enabled/disabled. The
   * built-in `discord` channel is always seeded here (default false) so it
   * shows as an available row even when absent from config; plugin channels
   * add their own ids. No id is privileged.
   */
  channels: Record<string, boolean>;
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
  /**
   * Global system-prompt base override — path to a file holding the base
   * prompt. Empty/undefined means use the built-in BASE_SYSTEM_PROMPT.
   * Per-agent overrides in `agents.<name>.systemPrompt` continue to win
   * field-by-field at runtime.
   */
  systemPromptBaseFile?: string;
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
    provider: { kind: "openai_compatible", defaultModel: "", baseUrl: "http://localhost:11434/v1" },
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
