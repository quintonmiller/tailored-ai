import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { PermissionsConfig } from "./approval.js";
import { DEFAULT_AUTOPILOT_TASK_PROMPT } from "./autopilot/task-prompt.js";
import { DEFAULT_BRIEFING_PROMPT } from "./briefing.js";
import { DEFAULT_SUGGESTIONS_PROMPT } from "./suggestions.js";

export interface ModelEntry {
  provider: string;
  model: string;
  /**
   * Context window this model supports, in tokens. Surfaced in the
   * `/context` display and used as a per-model override of
   * `agent.maxContextTokens`. Falls back to the global default when unset.
   */
  maxContextTokens?: number;
}

export interface AgentDefinition {
  description?: string;
  model?: string;
  provider?: string;
  /** Ordered priority list of provider+model combinations. First available is used. */
  models?: ModelEntry[];
  instructions?: string;
  tools?: string[];
  temperature?: number;
  maxToolRounds?: number;
  contextDir?: string;
  /** When >0, re-prompt the model up to N times if it responds with text instead of tool calls. */
  nudgeOnText?: number;
  /** Custom nudge message to send when re-prompting. Defaults to a generic "continue" prompt. */
  nudgeMessage?: string;
  /** When true, only load agent-specific context files (skip global context). */
  skipGlobalContext?: boolean;
  /** When true, summarize dropped history instead of silently discarding it. */
  summarizeOnTrim?: boolean;
  /** When true, prepend a `[Relevant memory]` block built from recall hits to the system prompt. */
  injectMemory?: boolean;
  /**
   * When true, inject mid-loop budget warnings at 50% and 80% of
   * `maxToolRounds` so the model can decide to commit progress before
   * running out. Useful for coding agents whose default mode is
   * depth-first exploration. Off by default.
   */
  budgetWarnings?: boolean;
  /** Token budget for the injected memory block. Default 800. */
  memoryInjectBudgetTokens?: number;
  /** Max number of recall hits to consider for injection. Default 5. */
  memoryInjectLimit?: number;
  /** Hooks to run before/after the agent loop when using this agent. */
  hooks?: {
    beforeRun?: AgentHook | AgentHook[];
    afterRun?: AgentHook | AgentHook[];
  };
  /** Sandbox kind to run shell/file tools in. Defaults to host (no isolation). */
  sandbox?: "host" | "docker" | "podman";
  /**
   * Skills to layer into this agent. Each entry is a skill resource id (e.g.
   * "my-org/code-reviewer"). Skill instructions append to the agent's; skill
   * tools merge into the agent's effective tool set; skill hooks append after
   * the agent's own hooks. Skills must be registered in the skill registry
   * before they take effect — unknown ids are ignored with a warning.
   *
   * Pass the literal `"*"` to expose every registered skill to the agent's
   * skill catalog (progressive mode only).
   */
  skills?: string[];
  /**
   * How `skills` is loaded:
   *   - "eager"        (default, deprecated) — skill instructions / tools /
   *     hooks merge into the agent at resolve time and ride along in every
   *     prompt. Simple but bloats the system prompt.
   *   - "progressive"  — agentskills.io model. A skill catalog (name +
   *     description) is injected into the system prompt and the agent calls
   *     `load_skill(name)` to activate a skill on demand. The skill's body
   *     and allowed-tools are loaded only when needed.
   */
  skillLoading?: "eager" | "progressive";
  /**
   * Exploratory ("always-on") configuration. When enabled, the ExploratoryWorker
   * runs this agent on a cadence — independently of user/task triggers — so it
   * can observe, research, and file notes/tasks proactively. See
   * docs/always-on-agents.md.
   */
  online?: OnlineAgentConfig;
  /**
   * Customize the system-prompt composition. By default the seven built-in
   * layers run in DEFAULT_LAYER_ORDER. Set `base` / `baseFile` to replace
   * BASE_SYSTEM_PROMPT, `order` to reorder/strip, `custom` to inject extra
   * layers. See docs/agents.md.
   */
  systemPrompt?: import("./agent/system-prompt.js").SystemPromptOverride;
}

export interface OnlineAgentConfig {
  /** Master switch. Off by default. */
  enabled?: boolean;
  cadence?: {
    /** Base interval between ticks, in minutes. Default 30. */
    interval_minutes?: number;
    /** Multiplier applied to interval after a no-op tick. Default 2.0. */
    idle_backoff_multiplier?: number;
    /** Cap on backed-off interval, in minutes. Default 240. */
    max_interval_minutes?: number;
    /**
     * Optional time-of-day window in which ticks fire. HH:MM strings, supports
     * windows that cross midnight. Omit to allow any time.
     */
    window?: {
      start: string;
      end: string;
    };
  };
  /**
   * Relative path (under the agent's context directory) to a goals file the
   * agent reads on each tick. Falls back to `goals.md` when omitted.
   */
  goals_file?: string;
  budgets?: {
    /** Max tokens consumable in a single tick. Default 8000. */
    tokens_per_tick?: number;
    /** Per-agent daily token cap. Shared with autopilot's 24h cap. */
    tokens_per_day?: number;
    /** Max tool calls in a single tick. Default 8. */
    tool_calls_per_tick?: number;
    /** Hard cap on runs per day, even if tokens are available. Default 12. */
    stop_after_runs_per_day?: number;
  };
  output?: {
    notes?: boolean;
    facts?: boolean;
    tasks?: boolean;
    /** Default false. When true, high-importance findings can DM the owner. */
    notify_owner?: boolean;
  };
  /**
   * Optional narrower tool subset for online ticks. Must be a subset of the
   * agent's `tools`. When omitted, falls back to the agent's normal tools.
   */
  tools?: string[];
}

/** @deprecated Use AgentDefinition instead. */
export type AgentProfile = AgentDefinition;

export interface AgentHook {
  tool: string;
  args?: Record<string, unknown>;
  /** Regex — if the tool output matches, skip the rest of the pipeline. */
  skipIf?: string;
}

/** @deprecated Use AgentHook instead. */
export type CronHook = AgentHook;

export interface CronJobConfig {
  name: string;
  schedule: string;
  prompt: string;
  sessionKey?: string;
  model?: string;
  agent?: string;
  /** @deprecated Use agent instead. */
  profile?: string;
  /** When set, the cron job triggers a workflow run instead of an agent loop. The expanded prompt becomes the workflow input prompt. */
  workflow?: string;
  enabled?: boolean;
  /**
   * Where to deliver this job's response. `channel` is an open channel id
   * (resolved against the runtime's outbound registry) or the reserved
   * sentinel `"log"` (console only, the default when omitted). `mode` picks
   * channel-post (`send`) vs direct-message (`sendDM`). `target` is the room
   * id (channel mode) or user id (dm mode); for dm it defaults to the
   * channel's configured owner. The legacy `"discord"` / `"discord-dm"`
   * string channel values are migrated to this shape by `migrateDeliveryConfig`.
   */
  delivery?: {
    channel?: string;
    mode?: "channel" | "dm";
    target?: string;
  };
  wakeAgent?: boolean;
  /** When true, create a fresh session for each run (no history from previous runs). */
  newSession?: boolean;
  hooks?: {
    beforeRun?: AgentHook | AgentHook[];
    afterRun?: AgentHook | AgentHook[];
  };
  /**
   * Bind this job to a registered project. When set, the job runs with the
   * project's path as cwd and tasks/sessions are scoped to it. Jobs declared
   * inside a project's `.tai.yaml` overlay only fire when that project is the
   * runtime's active project (single-tenant constraint of S7).
   */
  project?: string;
}

export interface CustomToolConfig {
  description: string;
  parameters: Record<string, { type: string; description: string }>;
  command: string;
  timeout_ms?: number;
}

export interface CommandConfig {
  description: string;
  command?: string; // Shell command template ({{input}} interpolated)
  prompt?: string; // Prompt template sent through agent loop ({{input}}, {{output}})
  agent?: string; // Named agent to use
  /** @deprecated Use agent instead. */
  profile?: string;
  new_session?: boolean; // Start fresh session (default: false)
  timeout_ms?: number; // Shell timeout (default: 30s)
}

export interface TaskWatcherConfig {
  enabled: boolean;
  /** Named agent to use. When set, uses a dedicated session. When omitted, shares the primary agent's session. */
  agent?: string;
  /** @deprecated Use agent instead. */
  profile?: string;
  prompt: string;
  debounceMs: number;
  triggers: ("created" | "updated" | "commented")[];
  /**
   * Where to deliver the watcher's notification. `channel` is an open channel
   * id (resolved against the runtime's outbound registry) or the reserved
   * sentinel `"log"` (console only, the default when omitted). `mode` picks
   * channel-post (`send`) vs direct-message (`sendDM`). `target` is the room
   * id (channel mode) or user id (dm mode); for dm it defaults to the
   * channel's configured owner. The legacy `"discord"` / `"discord-dm"`
   * string channel values are migrated to this shape by `migrateDeliveryConfig`.
   */
  delivery?: {
    channel?: string;
    mode?: "channel" | "dm";
    target?: string;
  };
  hooks?: {
    beforeRun?: AgentHook | AgentHook[];
    afterRun?: AgentHook | AgentHook[];
  };
  /**
   * When a coding-agent run ends with `[Agent stopped: …]` (max rounds,
   * repeated calls, or shutdown), the watcher writes a structured stall
   * comment and either retries (up to maxStallRetries) or transitions
   * the task to `blocked`. Default: 1 retry, then block.
   */
  maxStallRetries?: number;
}

export interface WebhookRouteConfig {
  path: string;
  action: "agent" | "log" | "workflow";
  messageTemplate: string;
  agent?: string;
  /** @deprecated Use agent instead. */
  profile?: string;
  /** When set (and action="workflow"), this webhook triggers the named workflow with input = { message, payload }. */
  workflow?: string;
  sessionKey?: string;
  newSession?: boolean;
  /**
   * Per-route authentication mode. Overrides the global `webhooks.secret`
   * Bearer check on this route only.
   *
   * - `"bearer"` (default when `secret` is set, or implied by the global
   *   `webhooks.secret`): expects `Authorization: Bearer <secret>`.
   * - `"github_hmac"`: expects `X-Hub-Signature-256: sha256=<hex>`
   *   computed as HMAC-SHA256(raw body, `secret`). Use this to accept
   *   webhooks from GitHub. The raw body is read once and parsed
   *   downstream — message templates and workflow inputs still see the
   *   decoded JSON.
   */
  auth?: "bearer" | "github_hmac";
  /** Secret used by `auth`. Required when `auth` is set; ignored otherwise. */
  secret?: string;
}

/**
 * One entry in `config.plugins`. A bare string is the module specifier; the
 * object form adds `enabled` (default true — `false` skips the entry) and a
 * per-plugin `config` bag threaded into the plugin's `ctx.config`.
 */
export type PluginEntry = string | { module: string; enabled?: boolean; config?: Record<string, unknown> };

/** The default plugins seeded into `config.plugins` as enabled `builtin:*` entries. */
export const DEFAULT_PLUGIN_MODULES = [
  "builtin:agent-notifier",
  "builtin:owner-notifier",
  "builtin:scope-creep-flagger",
  "builtin:stall-guard",
  "builtin:coder-project-guard",
] as const;

/**
 * Built-in plugins seeded `enabled: false` — installed and discoverable but
 * opt-in. These do something a conservative default shouldn't do unasked
 * (autonomous LLM calls, background memory writes), so users turn them on
 * deliberately by flipping the seeded entry's `enabled` to `true`.
 *
 * Seeded and re-appended (disabled) by {@link migrateDefaultPlugins} exactly
 * like the enabled set, but the loader skips them until enabled. Once a user
 * sets `enabled: true`, the migration leaves their entry untouched.
 */
export const DEFAULT_DISABLED_PLUGIN_MODULES = ["builtin:session-summarizer"] as const;

export interface AgentConfig {
  server: {
    port: number;
    host: string;
    /**
     * Legacy bearer token that gates only mutating endpoints (POST/PUT/PATCH/DELETE).
     * Prefer `authToken` below — it gates every route, closing the
     * read-access leak when the server binds non-loopback. Kept for
     * back-compat; set `authToken` instead for new deployments.
     */
    apiKey?: string;
    /**
     * Bearer token that gates every /api/* route (including GETs). Set this
     * whenever the server binds anywhere except 127.0.0.1. Clients send
     * `Authorization: Bearer <token>` on every request. Compared in
     * constant time. Leave unset only when running on loopback.
     */
    authToken?: string;
    proxyAuth?: {
      enabled: boolean;
      password: string;
    };
    /**
     * Web UI configuration. `enabled: false` is the kill-switch for
     * headless deployments (server skips static mounting entirely).
     * `provider` selects which UI implementation to mount; defaults to
     * "builtin" (bundled web UI). Third-party providers register via
     * `registerUiProviderFactory(id, ...)`. Per-provider config goes
     * under `server.ui.<id>` and is passed to the factory.
     */
    ui?: {
      enabled?: boolean;
      provider?: string;
      [providerId: string]: unknown;
    };
  };
  database: {
    path: string;
  };
  /**
   * Configured providers keyed by id. The key is a registered provider
   * factory id — the built-ins "openai_compatible" (vLLM / Ollama's /v1 /
   * LM Studio / llama.cpp), "openai", "anthropic", or any plugin-registered
   * id — and `agent.defaultProvider` selects which one is active. Each value
   * is a backend-opaque options bag the provider reads itself, so core
   * privileges no built-in and carries no per-provider schema. The
   * openai-family providers read `baseUrl` / `defaultModel` / `apiKey`
   * (plus `name` for openai_compatible).
   */
  providers: {
    [id: string]: Record<string, unknown> | undefined;
  };
  agent: {
    defaultProvider: string;
    /** Ordered priority list of provider+model combinations. First available is used. */
    models?: ModelEntry[];
    extraInstructions: string;
    maxHistoryTokens: number;
    maxContextTokens: number;
    temperature: number;
    maxToolRounds: number;
    /** Default sandbox kind for agents that don't set their own. Defaults to host. */
    sandbox?: "host" | "docker" | "podman";
    /**
     * Default system-prompt composition for every agent that doesn't set its
     * own `systemPrompt`. Per-agent overrides win field-by-field (see
     * `mergeSystemPromptOverrides`); list-shaped fields (`order`, `custom`)
     * replace rather than concatenate.
     */
    systemPrompt?: import("./agent/system-prompt.js").SystemPromptOverride;
  };
  /**
   * Channels keyed by id. Every channel — the built-in Discord and any
   * plugin-registered channel (slack, telegram, imessage, …) — is configured
   * the same way: an `enabled` flag plus a backend-opaque options bag the
   * channel reads itself. Core privileges no built-in and carries no
   * per-channel schema; e.g. the Discord channel parses `channels.discord`
   * via `getDiscordConfig` (`channels/discord-config.ts`). Channels with
   * `enabled: true` are started by `startRegisteredChannels` on CLI startup.
   */
  channels: {
    [channelId: string]: { enabled?: boolean; [key: string]: unknown } | undefined;
  };
  /**
   * Id of the channel that acts as the deployment's primary / default
   * communication channel — must name a key in `channels`. Drives the
   * operator identity (`runtime.getPrimaryOwner()`) and is the fallback sink
   * for plugins that don't pin their own channel. When unset, resolution
   * falls back to the first configured channel that declares an `owner`, then
   * to the first registered channel. Built-ins are not privileged here: the
   * value is a plain channel id resolved against `channels`.
   */
  defaultChannel?: string;
  /**
   * Plugin modules to load at startup. Each entry is either a package
   * specifier (`"@some-author/tai-plugin-x"`) or an object with `module`,
   * optional `enabled`, and optional `config`. Loading happens before
   * runtime construction for registry-shaped plugins (tools, channels,
   * providers, task backends, step executors); event-driven plugins that
   * need the runtime receive it on `ctx.runtime`.
   *
   * The default plugins ship here too as `builtin:*` entries
   * (`builtin:agent-notifier`, `builtin:owner-notifier`,
   * `builtin:scope-creep-flagger`, `builtin:stall-guard`,
   * `builtin:coder-project-guard`). Built-ins are not privileged — they are
   * loaded through the same path as third parties; the `builtin:` prefix
   * only tells the CLI importer to resolve them from
   * `@tailored-ai/core/plugins/*`.
   *
   * `enabled: false` disables an entry durably (the loader skips it). Per-
   * plugin `config` is threaded into the plugin's `ctx.config`; a plugin may
   * still read shared settings from the normal `tools.*`, `channels.*`, etc.
   * blocks. See {@link migrateDefaultPlugins} for the default seeding.
   */
  plugins?: PluginEntry[];
  /**
   * External agent URIs loaded into the AgentRegistry at startup. Each entry
   * is a resource URI (npm:/git:/file:/https:/tai-registry:) pointing at a
   * `kind: "agent"` manifest. Loaded via `loadExternalAgents()`, parallel
   * to the `plugins` block — the goal is to install agents authored
   * elsewhere without copying their definition into this config.
   *
   * Inline definitions under `agents:` continue to work; the two paths are
   * complementary. The registry resolves matching ids before falling back
   * to `agents:` (see `resolveAgent`).
   */
  externalAgents?: string[];
  cron: {
    enabled: boolean;
    jobs: CronJobConfig[];
  };
  agents: Record<string, AgentDefinition>;
  context: {
    directory: string;
    kbDirectory: string;
  };
  tools: {
    memory?: {
      enabled: boolean;
    };
    exec?: {
      enabled: boolean;
      allowedCommands?: string[];
    };
    read?: {
      enabled: boolean;
      allowedPaths?: string[];
    };
    write?: {
      enabled: boolean;
      allowedPaths?: string[];
    };
    web_fetch?: {
      enabled: boolean;
    };
    web_search?: {
      enabled: boolean;
      provider: string;
      apiKey: string;
      maxResults: number;
    };
    tasks?: {
      enabled: boolean;
    };
    facts?: {
      enabled: boolean;
    };
    recall?: {
      enabled: boolean;
      defaultTtlDays?: number;
    };
    gmail?: {
      enabled: boolean;
      account: string;
    };
    google_calendar?: {
      enabled: boolean;
      account: string;
    };
    claude_code?: {
      enabled: boolean;
      allowedTools?: string[];
      disallowedTools?: string[];
      maxTurns?: number;
      model?: string;
      timeoutMs?: number;
    };
    notify_owner?: {
      enabled: boolean;
      /** Optional outbound channel id override. Defaults to the default channel. */
      channel?: string;
    };
    browser?: {
      enabled: boolean;
      headless?: boolean;
      screenshotDir?: string;
      timeoutMs?: number;
    };
    browser_mediator?: {
      enabled: boolean;
      headless?: boolean;
      timeoutMs?: number;
      /** Hostnames the session is allowed to reach (subdomains match). Empty = deny all. */
      egressAllowList?: string[];
      /** When true, type_text values run through vault $ns.key expansion. */
      vaultEnabled?: boolean;
    };
    md_to_pdf?: {
      enabled: boolean;
    };
    google_drive?: {
      enabled: boolean;
      account: string;
      folder_name?: string;
      folder_id?: string;
    };
    ask_user?: {
      enabled: boolean;
      /**
       * File (relative to the global context dir) the out-of-autopilot
       * `ask_user` fallback appends questions to. Default "inbox.md".
       */
      inboxFile?: string;
    };
    projects?: {
      enabled: boolean;
      directory?: string;
    };
    documents?: {
      enabled: boolean;
    };
    extract_document?: {
      enabled: boolean;
    };
  };
  taskWatcher: TaskWatcherConfig;
  /**
   * Trusted-actions executor — separate process that holds credentials
   * and runs approval-gated operations (e.g. Amazon purchases). When
   * `enabled`, factories register the `purchase_item`, `request_action`,
   * and `check_action_status` tools so agents can enqueue approval-
   * gated actions. The executor itself runs in its own package
   * (`@tailored-ai/trusted-actions`) under a separate uid.
   */
  trustedActions?: {
    enabled: boolean;
    /** Base URL of the executor, e.g. http://localhost:3100. */
    url: string;
    /** Shared secret for TAI → executor enqueue auth (env-substituted). */
    sharedSecret: string;
    /** Polling interval for check_action_status, ms. Default 5000. */
    pollIntervalMs?: number;
    /**
     * Base URL the executor calls back to when an action finishes.
     * Must be reachable from the executor's network (when run in
     * docker, that's typically http://host.docker.internal:3000).
     * Defaults to the TAI server's local URL if unset.
     */
    callbackBaseUrl?: string;
  };
  webhooks: {
    enabled: boolean;
    secret?: string;
    routes: WebhookRouteConfig[];
  };
  custom_tools: Record<string, CustomToolConfig>;
  commands: Record<string, CommandConfig>;
  permissions?: PermissionsConfig;
  prompts?: {
    /** Allow `!`cmd`` shell expansion in prompt templates. Off by default. */
    allowShellExpansion?: boolean;
    /** Timeout per shell expansion (ms). Default 5000. */
    shellTimeoutMs?: number;
    /** Max nested {{include:...}} depth. Default 5. */
    maxIncludeDepth?: number;
    /** Base directory for relative include paths. Defaults to the config file directory. */
    includeBaseDir?: string;
  };
  tasks?: {
    /**
     * Task backend id, resolved through the task-backend registry.
     * Built-ins and third-party plugins are treated identically — any
     * registered name works. Default "native".
     */
    backend?: string;
    /**
     * Backend-specific options, opaque to core and read by the selected
     * backend — the same bag a third-party backend reads, so built-ins
     * aren't privileged. The `github` backend reads `repo`, `token`,
     * `agentRoles`; `beans`/`beads` read `path`.
     *
     * Legacy `tasks.github` / `tasks.beans` / `tasks.beads` blocks are
     * folded into this bag at load time (see `migrateTaskBackendConfig`).
     */
    options?: Record<string, unknown>;
  };
  /**
   * Forge integration for pushing branches and opening proposals
   * (pull/merge requests). Slice 4 of the platform vision — see
   * `docs/repo-backend.md`. Opt-in: with `backend` unset, core does not
   * push or open proposals (today's behavior — the coder commits and the
   * host/user integrates by hand).
   */
  repo?: {
    /**
     * Forge backend id, resolved through the repo-backend registry.
     * Built-ins and third-party plugins are treated identically — any
     * registered name works. Unset (or the reserved "none") → no
     * programmatic forge, today's behavior. The default built-in is
     * "github" (wraps the `gh` CLI).
     */
    backend?: string;
    /** Default target branch for new proposals. Default "main". */
    defaultBase?: string;
    /** Default git remote for pushes. Default "origin". */
    remote?: string;
    /**
     * Backend-specific options, opaque to core and read by the selected
     * backend — the same bag a third-party backend reads, so built-ins
     * aren't privileged. The `github` backend reads `repo` and `token`
     * (falling back to `tasks.github` then ambient `gh auth`).
     */
    options?: Record<string, unknown>;
  };
  /**
   * Centralized SSRF / outbound-HTTP egress policy. Applied to web_fetch,
   * the workflow http_request executor, and the trigger pollers. See
   * #57 / packages/core/src/security/egress-policy.ts.
   *
   * Default (block: undefined): policy is active with safe defaults —
   * loopback, RFC1918, link-local, IPv6 ULA, and cloud metadata IPs are
   * denied. Self-hosted integrations that need an internal target should
   * flip the appropriate field on or add the host to `allowHosts`.
   */
  security?: {
    egress?: {
      /** Skip every check. Use only in trusted networks. */
      disabled?: boolean;
      /** Allow loopback, RFC1918, ULA, link-local. */
      allowPrivateNetworks?: boolean;
      /** Allow AWS/GCP/Azure IMDS at 169.254.169.254 etc. */
      allowMetadataEndpoints?: boolean;
      /** Hostnames (or *.suffix) that always pass. */
      allowHosts?: string[];
      /** Hostnames (or *.suffix) that always fail. */
      denyHosts?: string[];
    };
  };
  sandboxes?: {
    docker?: {
      imageName?: string;
      mounts?: Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }>;
      env?: Record<string, string>;
      network?: string;
      sandboxWorkdir?: string;
    };
    podman?: {
      imageName?: string;
      mounts?: Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }>;
      env?: Record<string, string>;
      network?: string;
      sandboxWorkdir?: string;
    };
  };
  workflows?: {
    /** Directory containing workflow YAML files. Default "./workflows". */
    directory?: string;
    /** Global cap on concurrent workflow runs. Default 4. */
    maxConcurrent?: number;
    /** Per-agent cap on concurrent agent_run steps. Use "_default" for fallback. */
    maxConcurrentByAgent?: Record<string, number>;
    /** Retain log files for the last N runs per workflow. Default 100. */
    retainRuns?: number;
  };
  /** Always-on exploratory worker. See docs/always-on-agents.md. */
  exploratory?: {
    /** Master switch for the worker. Off by default. */
    enabled?: boolean;
    /** How often the worker scans for due agents, in ms. Default 60000. */
    baseIntervalMs?: number;
  };
  /** Tiered memory settings (notes, chunks, embeddings). See docs/memory-tiers.md. */
  memory?: {
    embeddings?: {
      /** When false / omitted, recall stays keyword-only. Default false. */
      enabled?: boolean;
      /**
       * Registered embedding factory id. Defaults to "openai_compatible".
       * Register custom factories via `registerEmbeddingFactory` from
       * `@tailored-ai/core`.
       */
      type?: string;
      /** Base URL for an OpenAI-compatible /v1/embeddings endpoint. */
      baseUrl?: string;
      /** Optional bearer key. Omit for local servers without auth. */
      apiKey?: string;
      /** Default embedding model id. */
      model?: string;
      /** Output dimension hint (used for sanity checks). */
      dim?: number;
    };
    /** Chunking parameters for the indexer. */
    chunks?: {
      maxChunkChars?: number;
      overlap?: number;
    };
    /**
     * Memory storage backend selection. `provider` names a registered
     * `MemoryBackendFactory` (default "builtin" = bundled SQLite). Plugins
     * register custom factories via `registerMemoryBackendFactory(id, ...)`
     * and read their config slice from `memory.backend.<id>`. See
     * docs/memory-storage-registry.md for the design.
     */
    backend?: {
      provider?: string;
      [providerId: string]: unknown;
    };
  };
  /**
   * Home-page briefing surface. Off by default — when disabled the server's
   * `/api/briefing` returns `{ enabled: false }` with no provider call, so
   * there's no behavior or token cost for non-users. When enabled, the server
   * runs ONE provider completion against a compact, data-only context and
   * caches the result for `ttlMinutes`. `prompt` is the system prompt (a
   * generic default ships in DEFAULT_CONFIG, replaceable per install).
   * `model` optionally overrides the model used (against the active provider);
   * omit it to use the runtime default. See docs/tasks-and-autopilot.md.
   */
  briefing?: {
    enabled?: boolean;
    prompt?: string;
    ttlMinutes?: number;
    model?: string;
    /** Completion token cap for the generation call. Thinking models spend
     *  reasoning tokens from this budget, so keep headroom above the
     *  expected output length. */
    maxTokens?: number;
    /** Opaque provider-specific request fields for the generation call,
     *  passed through as `ChatParams.extra` (e.g. vLLM's
     *  `chat_template_kwargs: { enable_thinking: false }`). */
    providerExtra?: Record<string, unknown>;
  };
  /**
   * Chat empty-state suggestion chips. Off by default — when disabled the
   * server's `/api/suggestions` returns `{ enabled: false }` with no provider
   * call, so there's no behavior or token cost for non-users. When enabled, the
   * server runs ONE provider completion against the same compact, data-only
   * context the briefing uses and caches the result for `ttlMinutes`. The model
   * is asked for `count` short prompts; `prompt` is the system prompt (a generic
   * default ships in DEFAULT_CONFIG, replaceable per install). `model`
   * optionally overrides the model used (against the active provider); omit it
   * to use the runtime default. See docs/tasks-and-autopilot.md.
   */
  suggestions?: {
    enabled?: boolean;
    prompt?: string;
    count?: number;
    ttlMinutes?: number;
    model?: string;
    /** Completion token cap for the generation call. Thinking models spend
     *  reasoning tokens from this budget, so keep headroom above the
     *  expected output length. */
    maxTokens?: number;
    /** Opaque provider-specific request fields for the generation call,
     *  passed through as `ChatParams.extra` (e.g. vLLM's
     *  `chat_template_kwargs: { enable_thinking: false }`). */
    providerExtra?: Record<string, unknown>;
  };
  /**
   * Autopilot worker tuning. Today this holds the overridable task prompt —
   * the orchestration rules the worker hands an agent when it picks up a
   * task. DEFAULT_CONFIG ships {@link DEFAULT_AUTOPILOT_TASK_PROMPT}, so
   * out-of-the-box behavior is unchanged. Override `taskPrompt` to reshape
   * how autopilot drives agents. Template vars: `{{task_id}}`,
   * `{{task_title}}`, `{{task_description}}`, `{{prior_activity}}` (the
   * rendered prior-comment block, or empty when there are none). See
   * docs/tasks-and-autopilot.md.
   */
  autopilot?: {
    taskPrompt?: string;
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  server: {
    port: 3000,
    host: "127.0.0.1",
  },
  database: {
    path: "./agent.db",
  },
  providers: {
    openai_compatible: {
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "devstral-small-2:latest",
    },
  },
  agent: {
    defaultProvider: "openai_compatible",
    extraInstructions: "",
    maxHistoryTokens: 2000,
    maxContextTokens: 32768,
    temperature: 0.3,
    maxToolRounds: 10,
  },
  agents: {},
  // The default plugin set ships installed + enabled. These reproduce the
  // out-of-the-box workflow (agent-completed delivery, owner notifications,
  // scope-creep flagging, stall retries, coder/reviewer project guard).
  // Disable one with
  // `{ module: "builtin:...", enabled: false }`; deleting an entry is not
  // durable because `migrateDefaultPlugins` re-appends missing modules.
  //
  // Opt-in built-ins (DEFAULT_DISABLED_PLUGIN_MODULES) are seeded too, but
  // `enabled: false` — the loader skips them until the user flips them on.
  plugins: [
    ...DEFAULT_PLUGIN_MODULES.map((module) => ({ module })),
    ...DEFAULT_DISABLED_PLUGIN_MODULES.map((module) => ({ module, enabled: false })),
  ],
  cron: {
    enabled: false,
    jobs: [],
  },
  context: {
    directory: "./data/context",
    kbDirectory: "./data/kb",
  },
  channels: {},
  tools: {
    memory: { enabled: true },
    exec: { enabled: true },
    read: { enabled: true },
    write: { enabled: true },
    web_fetch: { enabled: true },
    web_search: { enabled: false, provider: "brave", apiKey: "", maxResults: 5 },
    tasks: { enabled: true },
    facts: { enabled: true },
    recall: { enabled: true, defaultTtlDays: 14 },
    projects: { enabled: true, directory: "./data/projects" },
    documents: { enabled: true },
    extract_document: { enabled: false },
    ask_user: { enabled: true, inboxFile: "inbox.md" },
  },
  taskWatcher: {
    enabled: false,
    prompt: "Task {{action}}: {{task_title}} ({{task_id}}), status: {{task_status}}. {{task_description}}",
    debounceMs: 5000,
    triggers: ["created", "updated"],
    maxStallRetries: 1,
  },
  webhooks: {
    enabled: false,
    routes: [],
  },
  custom_tools: {},
  commands: {},
  prompts: {
    allowShellExpansion: false,
    shellTimeoutMs: 5000,
    maxIncludeDepth: 5,
  },
  tasks: {
    backend: "native",
  },
  briefing: {
    enabled: false,
    prompt: DEFAULT_BRIEFING_PROMPT,
    ttlMinutes: 30,
  },
  suggestions: {
    enabled: false,
    prompt: DEFAULT_SUGGESTIONS_PROMPT,
    count: 4,
    ttlMinutes: 15,
  },
  autopilot: {
    taskPrompt: DEFAULT_AUTOPILOT_TASK_PROMPT,
  },
};

function interpolateEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? "");
}

export function deepInterpolate(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(deepInterpolate);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepInterpolate(v);
    }
    return result;
  }
  return obj;
}

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Merge a per-project `.tai.yaml` overlay on top of the global config.
 *
 * Semantics: deep merge with project-wins precedence.
 *   - Maps: project keys override global keys at the same path; new keys are added
 *   - Arrays: replaced wholesale (no concat) — least-surprising default; documented
 *   - `agents.<name>` deep-merges so a project can tweak one field without redefining the agent
 *
 * Returns a new object; inputs are not mutated.
 */
export function mergeProjectOverlay(
  base: AgentConfig,
  overlay: Record<string, unknown> | undefined | null,
): AgentConfig {
  if (!overlay || Object.keys(overlay).length === 0) return base;
  // Interpolate ${ENV} references in the overlay before merging. The base
  // config was interpolated by loadConfig; without this, secret tokens in
  // `.tai.yaml` (e.g. `tasks.options.token: ${GITHUB_PERSONAL_TOKEN}`) reach
  // downstream consumers as literal `${VAR}` strings.
  const interpolated = deepInterpolate(overlay) as Record<string, unknown>;
  // Apply the same legacy-block migrations as loadConfig so per-project
  // overlays written against the old `tasks.github` / legacy `delivery.channel`
  // shapes still resolve.
  migrateTaskBackendConfig(interpolated);
  migrateDeliveryConfig(interpolated);
  return deepMerge(base as unknown as Record<string, unknown>, interpolated) as unknown as AgentConfig;
}

/** Validate config and return warnings. Does not throw — issues are advisory. */
export function validateConfig(config: AgentConfig): string[] {
  const warnings: string[] = [];

  // Collect all tool names that would be enabled
  const enabledToolNames = new Set<string>();
  const toolsConfig = config.tools;
  for (const [name, cfg] of Object.entries(toolsConfig)) {
    if (cfg && typeof cfg === "object" && "enabled" in cfg && (cfg as { enabled: boolean }).enabled !== false) {
      enabledToolNames.add(name);
    }
  }
  // Tools that have a hard credential gate at construction time. Listed here
  // so we can warn when a tool is "enabled" but won't actually register —
  // otherwise agents reference it, the UI silently omits it, and the user is
  // left guessing why.
  if (toolsConfig.web_search?.enabled && !toolsConfig.web_search.apiKey) {
    warnings.push(
      "tools.web_search is enabled but apiKey is empty (unresolved ${BRAVE_API_KEY}?); tool will be skipped at load",
    );
    enabledToolNames.delete("web_search");
  }
  if (toolsConfig.gmail?.enabled && !toolsConfig.gmail.account) {
    warnings.push(
      "tools.gmail is enabled but account is empty (unresolved ${GOG_ACCOUNT}?); tool will be skipped at load",
    );
    enabledToolNames.delete("gmail");
  }
  if (toolsConfig.google_calendar?.enabled && !toolsConfig.google_calendar.account) {
    warnings.push(
      "tools.google_calendar is enabled but account is empty (unresolved ${GOG_ACCOUNT}?); tool will be skipped at load",
    );
    enabledToolNames.delete("google_calendar");
  }
  if (toolsConfig.google_drive?.enabled && !toolsConfig.google_drive.account) {
    warnings.push(
      "tools.google_drive is enabled but account is empty (unresolved ${GOG_ACCOUNT}?); tool will be skipped at load",
    );
    enabledToolNames.delete("google_drive");
  }
  // Custom tools are always available when defined. Flag malformed entries so
  // the runtime can skip them cleanly instead of crashing at construction.
  for (const [name, raw] of Object.entries(config.custom_tools ?? {})) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`custom_tools.${name}: entry must be an object — got ${typeof raw}; will be skipped at load`);
      continue;
    }
    const cfg = raw as Partial<CustomToolConfig>;
    if (typeof cfg.command !== "string" || !cfg.command) {
      warnings.push(`custom_tools.${name}: missing required "command" string; will be skipped at load`);
      continue;
    }
    if (typeof cfg.description !== "string") {
      warnings.push(`custom_tools.${name}: missing required "description" string; will be skipped at load`);
      continue;
    }
    if (cfg.parameters !== undefined && cfg.parameters !== null) {
      if (typeof cfg.parameters !== "object" || Array.isArray(cfg.parameters)) {
        warnings.push(`custom_tools.${name}: "parameters" must be an object; will be skipped at load`);
        continue;
      }
    }
    enabledToolNames.add(name);
  }
  // Meta tools are always available
  for (const name of ["delegate", "task_status", "admin", "memory", "ask_user"]) {
    enabledToolNames.add(name);
  }

  // Validate agent tool references
  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (agent.tools) {
      for (const toolName of agent.tools) {
        if (!enabledToolNames.has(toolName)) {
          warnings.push(`Agent "${agentName}" references tool "${toolName}" which is not enabled`);
        }
      }
    }

    // Validate agent provider reference
    if (agent.provider) {
      const providerCfg = config.providers[agent.provider as keyof typeof config.providers];
      if (!providerCfg) {
        warnings.push(`Agent "${agentName}" references provider "${agent.provider}" which is not configured`);
      }
    }

    // Validate hook tool references
    const hookSections = [agent.hooks?.beforeRun, agent.hooks?.afterRun].filter(Boolean);
    for (const hookDef of hookSections) {
      const hooks = Array.isArray(hookDef) ? hookDef : [hookDef!];
      for (const hook of hooks) {
        if (hook.tool && !enabledToolNames.has(hook.tool)) {
          warnings.push(`Agent "${agentName}" hook references tool "${hook.tool}" which is not enabled`);
        }
      }
    }

    // Validate online (exploratory) config
    if (agent.online?.enabled) {
      const agentTools = new Set(agent.tools ?? []);
      if (!agentTools.has("recall")) {
        warnings.push(
          `Agent "${agentName}" has online.enabled but does not include "recall" in tools — exploratory ticks need recall to read goals and write findings`,
        );
      }
      const onlineTools = agent.online.tools;
      if (onlineTools) {
        for (const t of onlineTools) {
          if (!agentTools.has(t)) {
            warnings.push(`Agent "${agentName}" online.tools entry "${t}" is not in the agent's main tools list`);
          }
        }
      }
      const cadence = agent.online.cadence;
      if (cadence?.interval_minutes !== undefined && cadence.interval_minutes <= 0) {
        warnings.push(`Agent "${agentName}" online.cadence.interval_minutes must be > 0`);
      }
      if (
        cadence?.max_interval_minutes !== undefined &&
        cadence.interval_minutes !== undefined &&
        cadence.max_interval_minutes < cadence.interval_minutes
      ) {
        warnings.push(
          `Agent "${agentName}" online.cadence.max_interval_minutes (${cadence.max_interval_minutes}) is less than interval_minutes (${cadence.interval_minutes})`,
        );
      }
      if (cadence?.window) {
        const ok = (s: string) => /^\d{1,2}:\d{2}$/.test(s);
        if (!ok(cadence.window.start) || !ok(cadence.window.end)) {
          warnings.push(`Agent "${agentName}" online.cadence.window must use HH:MM strings`);
        }
      }
    }
  }

  // Validate cron job references
  for (const job of config.cron.jobs) {
    const jobAgent = job.agent ?? job.profile;
    if (jobAgent && !config.agents[jobAgent]) {
      warnings.push(`Cron job "${job.name}" references agent "${jobAgent}" which does not exist`);
    }

    const hookSections = [job.hooks?.beforeRun, job.hooks?.afterRun].filter(Boolean);
    for (const hookDef of hookSections) {
      const hooks = Array.isArray(hookDef) ? hookDef : [hookDef!];
      for (const hook of hooks) {
        if (hook.tool && !enabledToolNames.has(hook.tool)) {
          warnings.push(`Cron job "${job.name}" hook references tool "${hook.tool}" which is not enabled`);
        }
      }
    }
  }

  // Validate default provider
  const defaultProvider = config.agent.defaultProvider;
  const providerCfg = config.providers[defaultProvider as keyof typeof config.providers];
  if (!providerCfg) {
    warnings.push(`Default provider "${defaultProvider}" is not configured in providers`);
  }

  // Task-backend validity is not checked here: the backend id is resolved
  // dynamically through the registry (createTaskBackend throws a helpful
  // "Known: …" error on an unknown name), and backend-specific options are
  // the backend's own concern — core privileges no built-in. A backend that
  // needs missing options (e.g. github without repo/token) throws on
  // construction with a clear message.

  // Validate sandbox kinds
  const validSandboxes = ["host", "docker", "podman"];
  const defaultSandbox = config.agent.sandbox;
  if (defaultSandbox && !validSandboxes.includes(defaultSandbox)) {
    warnings.push(
      `agent.sandbox "${defaultSandbox}" is not valid (use ${validSandboxes.map((s) => `"${s}"`).join(", ")})`,
    );
  }
  if (defaultSandbox === "docker" && !config.sandboxes?.docker?.imageName) {
    warnings.push(`agent.sandbox is "docker" but sandboxes.docker.imageName is not set`);
  }
  if (defaultSandbox === "podman" && !config.sandboxes?.podman?.imageName) {
    warnings.push(`agent.sandbox is "podman" but sandboxes.podman.imageName is not set`);
  }
  for (const [agentName, agent] of Object.entries(config.agents)) {
    const kind = agent.sandbox;
    if (kind && !validSandboxes.includes(kind)) {
      warnings.push(
        `Agent "${agentName}" sandbox "${kind}" is not valid (use ${validSandboxes.map((s) => `"${s}"`).join(", ")})`,
      );
    }
    if (kind === "docker" && !config.sandboxes?.docker?.imageName) {
      warnings.push(`Agent "${agentName}" uses sandbox "docker" but sandboxes.docker.imageName is not set`);
    }
    if (kind === "podman" && !config.sandboxes?.podman?.imageName) {
      warnings.push(`Agent "${agentName}" uses sandbox "podman" but sandboxes.podman.imageName is not set`);
    }
  }

  // Validate workflows block
  if (config.workflows) {
    if (
      config.workflows.maxConcurrent !== undefined &&
      (typeof config.workflows.maxConcurrent !== "number" || config.workflows.maxConcurrent < 1)
    ) {
      warnings.push(`workflows.maxConcurrent must be a positive integer`);
    }
    if (
      config.workflows.retainRuns !== undefined &&
      (typeof config.workflows.retainRuns !== "number" || config.workflows.retainRuns < 0)
    ) {
      warnings.push(`workflows.retainRuns must be a non-negative integer`);
    }
    if (config.workflows.maxConcurrentByAgent) {
      for (const [k, v] of Object.entries(config.workflows.maxConcurrentByAgent)) {
        if (typeof v !== "number" || v < 1) {
          warnings.push(`workflows.maxConcurrentByAgent["${k}"] must be a positive integer`);
        }
      }
    }
  }

  // Validate prompts block
  if (config.prompts) {
    const depth = config.prompts.maxIncludeDepth;
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) {
      warnings.push(`prompts.maxIncludeDepth "${depth}" must be a positive integer`);
    }
    const timeout = config.prompts.shellTimeoutMs;
    if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0)) {
      warnings.push(`prompts.shellTimeoutMs "${timeout}" must be greater than 0`);
    }
  }

  // Validate permissions config
  if (config.permissions) {
    const validModes = ["auto", "approve"];
    if (config.permissions.defaultMode && !validModes.includes(config.permissions.defaultMode)) {
      warnings.push(
        `permissions.defaultMode "${config.permissions.defaultMode}" is not valid (use "auto" or "approve")`,
      );
    }
    const validTimeoutActions = ["reject", "auto_approve"];
    if (config.permissions.timeoutAction && !validTimeoutActions.includes(config.permissions.timeoutAction)) {
      warnings.push(
        `permissions.timeoutAction "${config.permissions.timeoutAction}" is not valid (use "reject" or "auto_approve")`,
      );
    }
    if (config.permissions.tools) {
      for (const toolName of Object.keys(config.permissions.tools)) {
        if (!enabledToolNames.has(toolName)) {
          warnings.push(`permissions.tools references tool "${toolName}" which is not enabled`);
        }
      }
    }
  }

  // Network exposure check. The default host is "127.0.0.1" — loopback only.
  // When a user opts in to a non-loopback bind (e.g. 0.0.0.0 to reach the
  // dashboard from another machine), every session, chat history, and tool
  // output becomes readable by anyone on the network unless auth is set.
  // Flag loud at startup.
  const host = config.server.host;
  const looksLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const hasAuth = !!(config.server.authToken || config.server.proxyAuth?.enabled);
  if (!looksLoopback && !hasAuth) {
    warnings.push(
      `server.host="${host}" exposes the API beyond loopback but neither server.authToken ` +
        `nor server.proxyAuth.enabled is set — all reads are unauthenticated. ` +
        `Set server.authToken to a strong secret, or bind to 127.0.0.1.`,
    );
  }

  // Egress policy: flag a `disabled: true` setting since it turns off the
  // SSRF guard wholesale. allow* flags get noted as informational so a
  // YAML typo doesn't silently re-enable internal targets.
  const egress = config.security?.egress;
  if (egress?.disabled) {
    warnings.push(
      `security.egress.disabled is true — the SSRF guard is OFF for web_fetch, ` +
        `the http_request workflow step, and trigger pollers. Set this only on ` +
        `trusted networks; prefer allowHosts for narrow internal-target opt-ins.`,
    );
  }

  return warnings;
}

export function loadConfig(configPath?: string): AgentConfig {
  const path = configPath ?? resolve(process.cwd(), "config.yaml");

  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = YAML.parse(raw) as Record<string, unknown>;
  const interpolated = deepInterpolate(parsed) as Record<string, unknown>;

  // Backward compat: if YAML has 'profiles:' key, merge into 'agents:' and warn
  if (interpolated.profiles && typeof interpolated.profiles === "object") {
    console.warn("[config] Warning: 'profiles:' is deprecated in config.yaml, rename it to 'agents:'");
    const existing = (interpolated.agents as Record<string, unknown> | undefined) ?? {};
    interpolated.agents = { ...(interpolated.profiles as Record<string, unknown>), ...existing };
    delete interpolated.profiles;
  }

  migrateOllamaProvider(interpolated);
  migrateTaskBackendConfig(interpolated);
  migrateNotifyOwnerTool(interpolated);
  coerceCronJobs(interpolated);
  // After coerceCronJobs so a JSON-string cron.jobs is already an array.
  migrateDeliveryConfig(interpolated);

  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    interpolated,
  ) as unknown as AgentConfig;
  // Run AFTER the merge: deepMerge replaces the `plugins` array wholesale, so
  // a user who declares any `plugins:` block drops the seeded defaults. This
  // re-appends any missing default modules to whatever the user has.
  migrateDefaultPlugins(merged);
  return merged;
}

/**
 * Back-compat: the old per-backend `tasks.github` / `tasks.beans` /
 * `tasks.beads` config blocks are folded into the generic, backend-opaque
 * `tasks.options` bag so core privileges no built-in. The selected backend
 * reads its settings from `options` exactly how a third-party backend
 * would. Mutates `interpolated` in place. Run on both the main config and
 * project overlays.
 */
export function migrateTaskBackendConfig(interpolated: Record<string, unknown>): void {
  const tasks = interpolated.tasks as Record<string, unknown> | undefined;
  if (!tasks) return;
  const legacyKeys = ["github", "beans", "beads"] as const;
  const present = legacyKeys.filter((k) => tasks[k] && typeof tasks[k] === "object");
  if (present.length === 0) return;

  console.warn(
    `[config] Warning: tasks.${present.join(", tasks.")} ${present.length > 1 ? "blocks are" : "block is"} deprecated; move the settings under tasks.options`,
  );
  // Explicit tasks.options wins over any legacy block.
  let merged = { ...((tasks.options as Record<string, unknown> | undefined) ?? {}) };
  for (const k of present) {
    merged = { ...(tasks[k] as Record<string, unknown>), ...merged };
    delete tasks[k];
  }
  tasks.options = merged;
}

/**
 * Back-compat: the old `tools.discord_dm` tool key was renamed to
 * `tools.notify_owner` when the Discord-specific DM tool became the
 * channel-neutral owner-notify tool. Move the block to the new key (deleting
 * the old one) so an existing config keeps the tool enabled. Explicit
 * `tools.notify_owner` wins. Mutates `interpolated` in place.
 */
export function migrateNotifyOwnerTool(interpolated: Record<string, unknown>): void {
  const tools = interpolated.tools as Record<string, unknown> | undefined;
  if (!tools || !tools.discord_dm) return;
  console.warn("[config] Warning: tools.discord_dm is deprecated; rename it to tools.notify_owner");
  if (tools.notify_owner === undefined) {
    tools.notify_owner = tools.discord_dm;
  }
  delete tools.discord_dm;
}

/**
 * Back-compat: the old delivery union pinned `channel` to a closed
 * `"log" | "discord" | "discord-dm"` set that conflated *which* channel with
 * *channel-post vs DM*. The new shape is `{ channel?: string; mode?: "channel"
 * | "dm"; target? }` where `channel` is an open id (or the `"log"` sentinel).
 * Map the three legacy string values onto it for `config.taskWatcher.delivery`
 * and each `config.cron.jobs[].delivery`, preserving `target`:
 *   - `"discord"`     → `{ channel: "discord", mode: "channel" }`
 *   - `"discord-dm"`  → `{ channel: "discord", mode: "dm" }`
 *   - `"log"`         → `{ channel: "log" }`
 * Idempotent: only rewrites when `channel` is one of those legacy strings and
 * `mode` is not already set; already-migrated or other configs are untouched.
 * Mutates `interpolated` in place. Run on both the main config and overlays.
 */
export function migrateDeliveryConfig(interpolated: Record<string, unknown>): void {
  const migrate = (delivery: unknown): void => {
    if (!delivery || typeof delivery !== "object") return;
    const d = delivery as Record<string, unknown>;
    // Already on the new shape (or a custom channel + explicit mode): leave it.
    if (d.mode !== undefined) return;
    if (d.channel === "discord") {
      d.mode = "channel";
    } else if (d.channel === "discord-dm") {
      d.channel = "discord";
      d.mode = "dm";
    }
    // "log" needs no rewrite (channel stays "log", no mode); other/custom
    // channel ids are left as-is.
  };

  const taskWatcher = interpolated.taskWatcher as Record<string, unknown> | undefined;
  if (taskWatcher) migrate(taskWatcher.delivery);

  const cron = interpolated.cron as Record<string, unknown> | undefined;
  const jobs = cron?.jobs;
  if (Array.isArray(jobs)) {
    for (const job of jobs) {
      if (job && typeof job === "object") migrate((job as Record<string, unknown>).delivery);
    }
  }
}

/**
 * Ensure the default `builtin:*` plugins are present in `config.plugins`.
 * `deepMerge` replaces the `plugins` array wholesale, so a user who declares
 * their own `plugins:` block silently drops the seeded defaults. This appends
 * any default module whose name is absent — AFTER the user's entries, so user
 * order is preserved and explicit user entries (including ones flipped to
 * `enabled: false`) win.
 *
 * Two tiers of default:
 *   - {@link DEFAULT_PLUGIN_MODULES} — appended enabled (bare `{ module }`).
 *   - {@link DEFAULT_DISABLED_PLUGIN_MODULES} — appended `enabled: false`.
 *     A user opts in by flipping their seeded entry to `enabled: true`; because
 *     this only appends *absent* modules, an existing entry (enabled OR
 *     disabled) is never rewritten — so an opt-in choice is preserved across
 *     reloads.
 *
 * Disable semantics: because this re-appends missing modules on every load,
 * **deleting** a default entry is not a durable off switch — it comes back.
 * To turn an enabled default off durably, keep the entry but set
 * `enabled: false`; the module name stays present (so nothing is re-added) and
 * the loader skips it.
 *
 * Also rewrites the renamed default `builtin:discord-notifier` →
 * `builtin:agent-notifier` (string or object form, preserving `config` /
 * `enabled`) so an existing config keeps its delivery plugin after the
 * channel-neutral rename.
 *
 * Idempotent. Mutates `config.plugins` in place; runs on the merged config.
 */
export function migrateDefaultPlugins(config: AgentConfig): void {
  const RENAMES: Record<string, string> = {
    "builtin:discord-notifier": "builtin:agent-notifier",
  };
  const existing = (config.plugins ?? []).map((e) => {
    if (typeof e === "string") {
      return RENAMES[e] ?? e;
    }
    if (e && typeof e.module === "string" && RENAMES[e.module]) {
      return { ...e, module: RENAMES[e.module] };
    }
    return e;
  });
  const present = new Set(
    existing.map((e) => (typeof e === "string" ? e : e?.module)).filter((m): m is string => typeof m === "string"),
  );
  const missingEnabled: PluginEntry[] = DEFAULT_PLUGIN_MODULES.filter((m) => !present.has(m)).map((module) => ({
    module,
  }));
  const missingDisabled: PluginEntry[] = DEFAULT_DISABLED_PLUGIN_MODULES.filter((m) => !present.has(m)).map(
    (module) => ({ module, enabled: false }),
  );
  const missing = [...missingEnabled, ...missingDisabled];
  config.plugins = missing.length === 0 ? existing : [...existing, ...missing];
}

/**
 * Tolerate `cron.jobs` written as a JSON string in config.yaml. Some hand-
 * edited configs use a quoted JSON array to keep the cron block on one
 * line; parse it here so downstream code can treat `jobs` as a real array.
 */
function coerceCronJobs(interpolated: Record<string, unknown>): void {
  const cron = interpolated.cron as Record<string, unknown> | undefined;
  if (!cron || typeof cron.jobs !== "string") return;
  try {
    cron.jobs = JSON.parse(cron.jobs);
  } catch (err) {
    console.warn(`[config] cron.jobs is a string but not valid JSON: ${(err as Error).message}`);
    cron.jobs = [];
  }
}

/**
 * Back-compat: the old `providers.ollama` config (native /api/chat) is folded
 * into the generic `openai_compatible` provider that talks to Ollama's /v1
 * OpenAI-compatible endpoint instead. Mutates `interpolated` in place.
 */
function migrateOllamaProvider(interpolated: Record<string, unknown>): void {
  const providers = interpolated.providers as Record<string, unknown> | undefined;
  const ollama = providers?.ollama as { baseUrl?: string; defaultModel?: string } | undefined;
  if (!providers || !ollama) {
    // Still translate a stale defaultProvider so old configs don't validate-error.
    const agent = interpolated.agent as Record<string, unknown> | undefined;
    if (agent && agent.defaultProvider === "ollama") {
      console.warn('[config] Warning: agent.defaultProvider "ollama" is deprecated; using "openai_compatible" instead');
      agent.defaultProvider = "openai_compatible";
    }
    return;
  }

  console.warn(
    "[config] Warning: providers.ollama is deprecated; migrate to providers.openai_compatible with baseUrl ending in /v1",
  );

  // Don't clobber an explicit openai_compatible block — user wins.
  if (!providers.openai_compatible) {
    const base = (ollama.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    const baseUrl = base.endsWith("/v1") ? base : `${base}/v1`;
    providers.openai_compatible = {
      baseUrl,
      defaultModel: ollama.defaultModel ?? "devstral-small-2:latest",
      name: "Ollama",
    };
  }
  delete providers.ollama;

  const agent = interpolated.agent as Record<string, unknown> | undefined;
  if (agent && agent.defaultProvider === "ollama") {
    agent.defaultProvider = "openai_compatible";
  }
}
