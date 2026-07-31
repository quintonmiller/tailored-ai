import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./agent/tool-output.js";
import type { PermissionsConfig } from "./approval.js";
import { DEFAULT_AUTOPILOT_TASK_PROMPT } from "./autopilot/task-prompt.js";
import { DEFAULT_BRIEFING_PROMPT } from "./briefing.js";
import { type DashboardWidget, validateDashboardWidget } from "./dashboard/index.js";
import type { ThinkingLevel } from "./providers/interface.js";
import { DEFAULT_SUGGESTIONS_PROMPT } from "./suggestions.js";
import { META_TOOL_NAMES } from "./tools/tool-factories.js";

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
  /**
   * Reasoning effort for this agent (#254): off | auto | low | medium | high.
   * Forwarded to the active provider on every chat call and mapped to its wire
   * format; overrides the provider's configured default. Providers without
   * reasoning support ignore it.
   */
  thinking?: ThinkingLevel;
  maxToolRounds?: number;
  /**
   * Hard filesystem boundary for this agent. File and exec tools reject any
   * path resolving outside it — the same enforcement the task watcher uses to
   * pin coder/reviewer to their worktree, but declared rather than injected.
   *
   * Needed because `tools.write.allowedPaths` is deployment-wide: granting an
   * agent `write` otherwise grants it the whole filesystem, and an agent that
   * reads web pages is an agent that can be talked into writing things. A
   * leading `~` is expanded.
   */
  fileBoundary?: string;
  /**
   * Whether this agent remembers each room separately or all of them together.
   *
   * `room` (default) gives it a session per room: clean isolation, and an agent
   * moved into a new room starts blank — which is how eleven agents, freshly
   * added to a channel, all reported the same unassigned tasks as their own
   * work when asked what they were doing.
   *
   * `shared` gives it one session across every room. An assistant that should
   * carry a thread between places wants this. The cost is real: context from
   * unrelated rooms mixes, and history grows with the number of rooms rather
   * than the conversation, so it competes for the same token budget everywhere.
   *
   * Note that continuity of WORK is better served by durable state — tasks
   * assigned to the agent, notes, facts — which is already cross-room. This is
   * continuity of CONVERSATION.
   */
  roomSessionScope?: "room" | "shared";
  contextDir?: string;
  /** When >0, re-prompt the model up to N times if it responds with text instead of tool calls. */
  nudgeOnText?: number;
  /** Custom nudge message to send when re-prompting. Defaults to a generic "continue" prompt. */
  nudgeMessage?: string;
  /** When true, only load agent-specific context files (skip global context). */
  skipGlobalContext?: boolean;
  /** When true, summarize dropped history instead of silently discarding it. */
  summarizeOnTrim?: boolean;
  /**
   * When true, task-watcher dispatches to this agent run in an isolated git
   * worktree on a per-task branch (`agent/<task_id>-<slug>`). The watcher
   * creates the worktree before the loop, mounts it as the working-directory
   * boundary, and cleans it up afterward (retaining the branch). Off by
   * default — only agents that need an isolated checkout (coding / review
   * roles) should opt in. Replaces the historical hardcoded
   * `agentName === "coder" || "reviewer"` check.
   */
  worktree?: boolean;
  /**
   * Prompt template prepended to task-watcher dispatch prompts for this
   * agent. Expanded through the same `{{var}}` path as other prompts, with
   * vars: `task_id`, `task_title`, `task_status`, `task_description`,
   * `task_author`, `task_tags`, `action`, `project_id`, `owner_name`,
   * `worktree_path`, `worktree_branch` (the last two are empty strings when
   * the agent has no worktree). Unset means no preamble — the dispatch
   * prompt is just the task context + the watcher's configured prompt.
   * This is where install-specific role guidance (coder/reviewer lifecycle,
   * review gates, handoff conventions) now lives, instead of hardcoded core.
   */
  taskPreamble?: string;
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
  /**
   * Sandbox kind to run shell/file tools in. Defaults to "host" (no isolation).
   * Built-ins: "host", "docker", "podman". Plugins may register additional kinds
   * via `registerSandboxFactory`.
   */
  sandbox?: string;
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
  /**
   * What to do when this hook errors (throws, is missing, or returns
   * `success: false`).
   *
   * - `"abort"` (default): stop and don't run the agent. A hook's job is to put
   *   data in the prompt; if it failed there is no data, and a prompt that
   *   promises data it doesn't have invites the model to invent it.
   * - `"continue"`: proceed anyway with an empty output for this hook. Only
   *   correct when the hook is genuinely optional enrichment.
   */
  onError?: "abort" | "continue";
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
  parameters: Record<
    string,
    {
      type: string;
      description: string;
      /** Omit-able by the model. Defaults to true, which is how it has always behaved. */
      required?: boolean;
      /** Substituted when the model leaves the parameter out. */
      default?: string | number | boolean;
    }
  >;
  command: string;
  timeout_ms?: number;
}

/**
 * One MCP server under `mcp.servers.<id>`. Exactly one transport: `command`
 * (stdio — TAI spawns the process) or `url` (streamable HTTP). The common
 * `mcpServers` JSON shape used by other MCP hosts maps 1:1 onto an entry
 * here, so server configs can be copy-pasted.
 */
export interface McpServerConfig {
  /** Enabled unless explicitly false — a configured server is presumed wanted. */
  enabled?: boolean;
  /** stdio transport: executable to spawn (resolved against PATH). */
  command?: string;
  args?: string[];
  /** Extra environment for the spawned process, merged over the SDK's safe default set. `${VAR}` interpolation applies. */
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable-HTTP transport: the server's MCP endpoint. */
  url?: string;
  /** Extra HTTP headers (auth tokens etc.) for `url` servers. */
  headers?: Record<string, string>;
  /**
   * Allowlist of server-side tool names to expose. Omit to expose all.
   * Local models degrade past ~5 tools per request — prefer listing the few
   * you need over exposing a 30-tool server wholesale.
   */
  tools?: string[];
  /** Per-call timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
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
  // On by default: an agent silently sitting in a room it created is the
  // failure this closes, and a default that has to be switched on would not
  // have closed it. Costs one line per real membership change, and nothing at
  // all for the config-declared subscriptions re-applied on every reload.
  "builtin:room-announcer",
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
export const DEFAULT_DISABLED_PLUGIN_MODULES = ["builtin:session-summarizer", "builtin:verify-gate"] as const;

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
   * factory id — the built-in "openai_compatible" (vLLM / Ollama's /v1 /
   * LM Studio / llama.cpp / any OpenAI-wire gateway) or any
   * plugin-registered id ("openai", "anthropic", "openrouter", "bedrock",
   * …) — and `agent.defaultProvider` selects which one is active. Each
   * value is a backend-opaque options bag the provider reads itself, so
   * core privileges no built-in and carries no per-provider schema.
   * openai_compatible reads `baseUrl` / `defaultModel` / `apiKey` / `name`.
   *
   * To run several OpenAI-wire endpoints at once (local vLLM + DeepSeek +
   * Groq + …) without a per-vendor plugin, give each its own id and set
   * `type: openai_compatible` — the built-in OpenAIProvider then serves that
   * id directly (#253). A registered factory id always wins over an inline
   * `type`. Example:
   *   providers:
   *     local:    { type: openai_compatible, baseUrl: http://127.0.0.1:8000/v1, defaultModel: qwen3.6-27b }
   *     deepseek: { type: openai_compatible, baseUrl: https://api.deepseek.com, apiKey: ${DEEPSEEK_API_KEY}, defaultModel: deepseek-v4-flash }
   *
   * Reasoning (#254): an openai_compatible bag may also set `thinking`
   * (default effort: off|auto|low|medium|high) and `thinkingDialect`
   * (openai → reasoning_effort, vllm → chat_template_kwargs.enable_thinking,
   * none → ignore; default none). Per-agent `agents.<name>.thinking` overrides
   * the default per call. Hosted-vendor plugins map `thinking` themselves.
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
    /**
     * Chars of a single tool result that reach the conversation. `0` disables.
     * Override per tool with `tools.<id>.maxOutputChars` — including MCP tools,
     * keyed by their resolved `mcp_<server>_<tool>` name.
     */
    maxToolOutputChars: number;
    maxContextTokens: number;
    temperature: number;
    maxToolRounds: number;
    /**
     * Default sandbox kind for agents that don't set their own. Defaults to "host".
     * Built-ins: "host", "docker", "podman". Plugins may register additional kinds
     * via `registerSandboxFactory`.
     */
    sandbox?: string;
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
   * MCP (Model Context Protocol) servers keyed by id. Each server's tools
   * are discovered at startup and registered into the tool registry as
   * `mcp_<serverId>_<toolName>` — selectable per agent like any other tool.
   * MCP is a protocol-level capability (like `openai_compatible` for
   * providers), so it lives in core rather than a plugin; the SDK is an
   * optional dependency loaded on first use. A server entry is enabled
   * unless it sets `enabled: false` — presence is intent, since unlike
   * channels there are no seeded default entries.
   */
  mcp?: {
    servers: { [serverId: string]: McpServerConfig | undefined };
  };
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
    /**
     * Warn when the injected `<context>` block exceeds this many tokens.
     * 0 disables. Default 4000.
     *
     * It is a smoke alarm, not a limit — nothing truncates context, so growth
     * silently comes out of the history budget instead and shows up as an
     * agent that forgets. A deployment that deliberately runs large, specific
     * context on a long-window model should raise this rather than learn to
     * ignore the warning.
     */
    warnTokens?: number;
  };
  tools: {
    /**
     * Open map: every tool — built-in or plugin — reads its config from
     * `tools.<id>` through this index. Core types only the built-in tools'
     * shapes below; plugin tools (e.g. @tailored-ai/google-tools' `gmail`)
     * define and validate their own config shape at factory time. A missing
     * or `enabled: false` entry disables the tool.
     */
    [toolId: string]: { enabled?: boolean; [key: string]: unknown } | undefined;
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
    edit?: {
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
    ask_user?: {
      enabled: boolean;
      /**
       * File the out-of-autopilot `ask_user` fallback appends questions to,
       * relative to the **base context dir** — one level above `global/`.
       * Default "inbox.md".
       *
       * Deliberately not inside `global/`: that directory is injected into
       * every agent's system prompt, so an inbox there broadcast a queue of
       * questions-for-a-human to all 28 agents, which then reported months-old
       * entries as live outstanding work. It is a queue for a person, not
       * context for agents.
       */
      inboxFile?: string;
    };
    projects?: {
      enabled: boolean;
      directory?: string;
    };
    collections?: {
      enabled: boolean;
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
  /**
   * Outbound notification policy. Applies only to messages the agent sends
   * unprompted (cron deliveries, owner-notifier events, notify_owner from a
   * background tick). Replies to something the user asked for do not pass
   * through here and are never suppressed.
   */
  notifications?: {
    /** Repeat suppression — "don't tell me what I've already heard". */
    dedup?: import("./notifications/dedup.js").NotificationDedupConfig;
  };
  /**
   * Shared rooms: multi-party conversations that several agents and humans
   * take part in. A room is a destination *within* a transport (a Discord
   * channel), which is why this is separate from `channels` — those are the
   * transports themselves.
   *
   * Core owns addressing, membership, subscriptions and wake policy. What an
   * agent actually says in a room is prompt and plugin territory.
   * See docs/rooms.md.
   */
  rooms?: {
    /** Master switch for the watcher. Rooms are readable either way. */
    enabled?: boolean;
    /**
     * Extra participants, beyond the agents in `agents:` (which are added
     * automatically under their own names) and the owner. Usually just a
     * friendlier label for yourself:
     *
     *     identities:
     *       quinton: "107389829628612608"
     *       planner: { agent: planner, avatarUrl: "https://…/planner.png" }
     *
     * `avatarUrl` is used on transports that can post under a display name
     * (Discord webhooks); elsewhere it is ignored.
     */
    identities?: Record<string, import("./rooms/identities.js").RoomIdentityConfig>;
    /** Label for the implicit owner identity. Default "owner". */
    ownerLabel?: string;
    /** Rooms to register at startup. Agents may create more at runtime. */
    rooms?: Array<{
      name: string;
      /** Canonical `<backend>:<id>`, e.g. `discord:1467386788640460822`. */
      ref: string;
      /**
       * What the room is for. Given to every agent woken here, and mirrored to
       * the transport's own description field (Discord's channel topic) so
       * people reading along see the same thing.
       */
      purpose?: string;
      /**
       * Per-room overrides of the deployment-wide brakes. A coordination room
       * where three agents hand work back and forth and an ideas room that sees
       * one message a week want very different numbers, and a single global
       * value has to be wrong for one of them — set low, the busy room goes
       * quiet mid-task; set high, the quiet one is free to chatter.
       *
       * Unset means "use the global value", which is what every room did before
       * these existed.
       */
      maxWakesPerHour?: number;
      maxAgentTurns?: number;
    }>;
    /**
     * Who watches what. `deliver` decides when the agent looks (push on a
     * transport event, or poll on an interval); `wakeOn` decides what makes it
     * run: `named` only when someone writes its name, `addressed` also on loose
     * questions from a person, `all` on everything, `none` never. Both axes are
     * independent — poll+all is a digest, push+named is an instant answer that
     * stays quiet otherwise, and anything+none is a read-only seat.
     */
    subscriptions?: Array<{
      agent: string;
      /** Room name or `<backend>:<id>` ref. */
      room: string;
      deliver?: "push" | "poll";
      wakeOn?: "named" | "addressed" | "all" | "none";
      pollSeconds?: number;
      /**
       * Also wake this agent every N minutes with nothing new said, so it can
       * act on time passing rather than only on being spoken to. Agents can set
       * their own through the `room` tool.
       */
      checkInMinutes?: number;
      /**
       * What this agent is for in this room. The room's `purpose` says what the
       * room is about; this says what one participant's job in it is, so the
       * same agent can behave differently in two rooms. Keep it short — it
       * competes with the purpose for a small prompt budget.
       */
      role?: string;
    }>;
    /** Hourly wake ceiling per (agent, room). The runaway-loop brake. Default 12. */
    maxWakesPerHour?: number;
    /**
     * Consecutive agent-only turns allowed before a room stops waking anyone.
     * Two agents thanking each other is not a loop any single-message rule can
     * see. A human speaking resets the count. Default 6.
     */
    maxAgentTurns?: number;
    /** Most messages handed to an agent in one wake. Default 30. */
    maxBacklog?: number;
    /** Burst-collapsing delay before a wake fires, in seconds. Default 3. */
    batchSeconds?: number;
    /** Interval for `deliver: poll` subscriptions that don't set one. Default 900. */
    defaultPollSeconds?: number;
    /**
     * How long a point stays "already said" per urgency, in hours. Only
     * suppresses repeats — new information is never held back. Defaults:
     * high 0.25, medium 24, low 168.
     */
    urgencyWindowHours?: Partial<Record<import("./rooms/types.js").RoomUrgency, number>>;
    /** Transport used when an agent creates a room without naming one. */
    defaultBackend?: string;
    /**
     * Where an agent's direct messages go, as `agent: room-name`.
     *
     * Without this, `room(action="dm")` opens a room named after the agent —
     * which is right for an agent nobody has set one up for, and wrong when a
     * room for exactly that purpose already exists under another name. Naming
     * it here points the direct line at the room you already have instead of
     * quietly creating a second one.
     */
    desks?: Record<string, string>;
    /**
     * Attach a record of what an agent actually did underneath its message,
     * where the transport can nest (Discord opens a thread).
     *
     * `none` (default) keeps rooms as pure conversation. `mutations` shows only
     * calls that changed something. `all` shows reads too — more noise, but
     * reads are where a wrong answer usually comes from: an agent that read the
     * document contradicting it is only visible if you can see the read.
     */
    toolActivity?: "none" | "mutations" | "all";
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
      /**
       * Soft cap on characters per embedding input. Longer inputs are
       * truncated before the request (and the cap auto-halves and retries on a
       * context-overflow 400) so a big recall query never silently disables
       * semantic search. Default 8000 (~2k tokens).
       */
      maxInputChars?: number;
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
   * Board page widgets. Declarative specs the bundled UI renders via its widget
   * renderer registry (types: status, metric, tasks, list, markdown, links,
   * iframe, …). Entries here are added on top of widgets contributed by plugins
   * (`registerDashboardWidgetProvider`) and the built-in defaults; an entry
   * sharing a built-in/plugin widget's `id` overrides it. Set `defaults: false`
   * to drop the built-in widgets entirely. See docs/dashboard-widgets.md.
   */
  dashboard?: {
    defaults?: boolean;
    widgets?: DashboardWidget[];
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
    /**
     * Cron expression for the daily memory-hygiene sweep (TTL extension on
     * referenced notes, deletion of expired low-importance ones). Set to an
     * empty string to disable the sweep. DEFAULT_CONFIG ships "14 3 * * *".
     */
    memorySweepCron?: string;
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
      // Intentionally empty: there is no universal local model to assume.
      // `tai init` discovers installed models; validateConfig warns until set.
      defaultModel: "",
    },
  },
  agent: {
    defaultProvider: "openai_compatible",
    extraInstructions: "",
    maxHistoryTokens: 2000,
    maxToolOutputChars: DEFAULT_MAX_TOOL_OUTPUT_CHARS,
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
    warnTokens: 4000,
  },
  channels: {},
  mcp: { servers: {} },
  tools: {
    memory: { enabled: true },
    exec: { enabled: true },
    read: { enabled: true },
    write: { enabled: true },
    edit: { enabled: true },
    web_fetch: { enabled: true },
    web_search: { enabled: false, provider: "brave", apiKey: "", maxResults: 5 },
    tasks: { enabled: true },
    facts: { enabled: true },
    recall: { enabled: true, defaultTtlDays: 14 },
    projects: { enabled: true, directory: "./data/projects" },
    collections: { enabled: true },
    room: { enabled: true },
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
    memorySweepCron: "14 3 * * *",
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

/**
 * Every recognized top-level `config.yaml` key. Typed as
 * `Record<keyof AgentConfig, true>` so it can't drift from the interface: add
 * a top-level key to {@link AgentConfig} and this map must gain it too (or the
 * build fails), and a key here that isn't on the interface is a type error.
 * {@link validateConfig} warns on any top-level key absent from this set —
 * catching typos and version skew. Nested bags (`tools.<id>`, `providers.<id>`,
 * `channels.<id>`, plugin config) are intentionally open and never checked.
 */
const KNOWN_TOP_LEVEL_CONFIG_KEY_MAP: Record<keyof AgentConfig, true> = {
  server: true,
  database: true,
  providers: true,
  agent: true,
  notifications: true,
  rooms: true,
  channels: true,
  defaultChannel: true,
  mcp: true,
  plugins: true,
  externalAgents: true,
  cron: true,
  agents: true,
  context: true,
  tools: true,
  taskWatcher: true,
  trustedActions: true,
  webhooks: true,
  custom_tools: true,
  commands: true,
  permissions: true,
  prompts: true,
  tasks: true,
  repo: true,
  security: true,
  sandboxes: true,
  workflows: true,
  exploratory: true,
  memory: true,
  briefing: true,
  suggestions: true,
  autopilot: true,
  dashboard: true,
};

/** Recognized top-level config keys, as a Set for O(1) membership tests. */
export const KNOWN_TOP_LEVEL_CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(KNOWN_TOP_LEVEL_CONFIG_KEY_MAP));

/**
 * Deprecated top-level keys that {@link loadConfig} migrates and warns about
 * itself — recognized, so the unknown-key check stays silent rather than
 * double-warning. (`profiles` → `agents`.)
 */
const DEPRECATED_TOP_LEVEL_CONFIG_KEYS: ReadonlySet<string> = new Set(["profiles"]);

/**
 * Every key an agent block may carry. Keep in sync with {@link AgentDefinition}
 * and with `AGENT_DEFINITION_FIELDS` in resources/agent.ts, which enforces the
 * same list one layer down.
 */
const KNOWN_AGENT_KEYS: ReadonlySet<string> = new Set([
  "description",
  "model",
  "provider",
  "models",
  "instructions",
  "tools",
  "temperature",
  "thinking",
  "maxToolRounds",
  "fileBoundary",
  "roomSessionScope",
  "contextDir",
  "nudgeOnText",
  "nudgeMessage",
  "skipGlobalContext",
  "summarizeOnTrim",
  "worktree",
  "taskPreamble",
  "injectMemory",
  "budgetWarnings",
  "memoryInjectBudgetTokens",
  "memoryInjectLimit",
  "hooks",
  "sandbox",
  "skills",
  "skillLoading",
  "online",
  "systemPrompt",
]);

/**
 * Closest known key by edit distance, for "did you mean". Only offered for a
 * near miss — a wild guess is worse than no guess, because it sends someone to
 * rename a key that was never the problem.
 */
function nearestKey(input: string, candidates: ReadonlySet<string>): string | undefined {
  const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
  const target = normalize(input);
  let best: { key: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    // An abbreviation is a typo shape edit distance cannot see: `temp` is seven
    // edits from `temperature` and obviously means it. Found in the wild — an
    // agent authored `temp: 0.3` into its own config and ran at the default
    // temperature instead, silently. Three characters minimum, so `on` does not
    // match `online`.
    const isPrefix = target.length >= 3 && normalized.startsWith(target);
    const distance = isPrefix ? 1 : editDistance(target, normalized);
    if (distance <= 2 && (!best || distance < best.distance)) best = { key: candidate, distance };
  }
  return best?.key;
}

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

/** Validate config and return warnings. Does not throw — issues are advisory. */
/**
 * Unrecognized top-level keys: a feature configured under a typo'd key, or one
 * a newer doc describes but this installed version predates, is silently
 * ignored otherwise (#252). Top-level only — nested bags are open.
 */
function unknownTopLevelKeys(config: AgentConfig): string[] {
  const supportedList = [...KNOWN_TOP_LEVEL_CONFIG_KEYS].sort().join(", ");
  const found: string[] = [];
  for (const key of Object.keys(config)) {
    if (KNOWN_TOP_LEVEL_CONFIG_KEYS.has(key) || DEPRECATED_TOP_LEVEL_CONFIG_KEYS.has(key)) continue;
    found.push(
      `config.yaml: unknown top-level key "${key}" — it will be ignored. ` +
        `If it's from newer docs your installed version may predate it; otherwise it may be a typo. ` +
        `Supported keys: ${supportedList}`,
    );
  }
  return found;
}

/**
 * An unknown key inside one agent block.
 *
 * Top-level keys have been checked since #252, but the comment there says
 * "nested bags are open" — and an agent block is not a bag, it is a typed
 * record. Four agents in one deployment carried their whole persona under
 * `system_prompt:` instead of `instructions:`. It parsed, it round-tripped
 * into their manifests, and it reached nothing: those agents ran with an
 * empty instructions layer for weeks with no warning anywhere.
 */
function unknownAgentKeysFor(agentName: string, agent: AgentDefinition | undefined): string[] {
  const found: string[] = [];
  for (const key of Object.keys(agent ?? {})) {
    if (KNOWN_AGENT_KEYS.has(key)) continue;
    const suggestion = nearestKey(key, KNOWN_AGENT_KEYS);
    found.push(
      `Agent "${agentName}": unknown key "${key}" — it will be ignored` +
        (suggestion ? `. Did you mean "${suggestion}"?` : ". Keys are camelCase."),
    );
  }
  return found;
}

/**
 * The subset of config problems meaning "this parses but is never read".
 *
 * Split out of {@link validateConfig} because a *write* has to answer a
 * narrower question than startup does. Most of what validateConfig reports can
 * be legitimately transient — a tool whose credential env var isn't exported
 * yet, a provider a plugin registers later — and refusing a write on those
 * would make the config unwritable for reasons unrelated to the write. An
 * unrecognized key is never transient: nothing will ever read it, and the
 * author is right there to fix it.
 *
 * Emits the same strings `validateConfig` does, so a caller can diff against a
 * pre-write snapshot by message identity.
 */
export function findUnknownKeys(config: AgentConfig): string[] {
  const found = unknownTopLevelKeys(config);
  for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
    found.push(...unknownAgentKeysFor(agentName, agent));
  }
  return found;
}

export function validateConfig(config: AgentConfig): string[] {
  const warnings: string[] = [];

  warnings.push(...unknownTopLevelKeys(config));

  // Collect all tool names that would be enabled
  const enabledToolNames = new Set<string>();
  const toolsConfig = config.tools;
  for (const [name, cfg] of Object.entries(toolsConfig)) {
    if (cfg && typeof cfg === "object" && "enabled" in cfg && (cfg as { enabled: boolean }).enabled !== false) {
      enabledToolNames.add(name);
    }
  }
  // `tasks` and `task_query` are created together by the tasks tool factory
  // (builtin.ts) — enabling `tasks` registers both. Reflect that coupling so
  // agents that reference `task_query` don't draw a spurious "not enabled"
  // warning on every startup.
  if (enabledToolNames.has("tasks")) enabledToolNames.add("task_query");
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
  // Plugin tools (gmail, google_calendar, google_drive, …) validate their own
  // config at factory time — core no longer knows their shapes by name.
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
  // Meta tools are always available (list is authoritative in META_TOOL_NAMES)
  for (const name of META_TOOL_NAMES) {
    enabledToolNames.add(name);
  }

  // MCP servers: exactly one transport per entry. Misconfigured servers are
  // skipped at load, so surface that here instead of failing silently.
  const mcpServers = config.mcp?.servers ?? {};
  let hasMcpServers = false;
  for (const [id, server] of Object.entries(mcpServers)) {
    if (!server || server.enabled === false) continue;
    const hasCommand = typeof server.command === "string" && server.command.length > 0;
    const hasUrl = typeof server.url === "string" && server.url.length > 0;
    if (!hasCommand && !hasUrl) {
      warnings.push(`mcp.servers.${id}: needs either "command" (stdio) or "url" (streamable HTTP); will be skipped`);
    } else if (hasCommand && hasUrl) {
      warnings.push(`mcp.servers.${id}: set "command" or "url", not both; will be skipped`);
    } else {
      hasMcpServers = true;
    }
  }

  // Validate agent tool references
  for (const [agentName, agent] of Object.entries(config.agents)) {
    warnings.push(...unknownAgentKeysFor(agentName, agent));

    if (agent.tools) {
      for (const toolName of agent.tools) {
        // MCP tool names (mcp_<server>_<tool>) only exist after async
        // discovery, so static validation can't confirm them — only flag
        // the case where no server could ever provide one.
        if (toolName.startsWith("mcp_")) {
          if (!hasMcpServers) {
            warnings.push(`Agent "${agentName}" references MCP tool "${toolName}" but no mcp.servers are configured`);
          }
          continue;
        }
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
  } else if (typeof providerCfg === "object" && "defaultModel" in providerCfg && !providerCfg.defaultModel) {
    warnings.push(
      `providers.${defaultProvider}.defaultModel is empty — set a model (run \`tai init\` to discover installed models) or set \`model\` per agent`,
    );
  }

  // Task-backend validity is not checked here: the backend id is resolved
  // dynamically through the registry (createTaskBackend throws a helpful
  // "Known: …" error on an unknown name), and backend-specific options are
  // the backend's own concern — core privileges no built-in. A backend that
  // needs missing options (e.g. github without repo/token) throws on
  // construction with a clear message.

  // Sandbox-backend validity is not checked here either: the id is resolved
  // dynamically through the sandbox factory registry (createSandbox throws a
  // helpful "Known: …" error on an unknown kind), and core privileges no
  // built-in. We do keep the "imageName not set" guard for the built-in docker
  // and podman factories because that is a config-time detectable mistake the
  // factory itself cannot surface until runtime.
  const checkSandboxImageName = (kind: string | undefined, context: string) => {
    if (kind === "docker" && !config.sandboxes?.docker?.imageName) {
      warnings.push(`${context} uses sandbox "docker" but sandboxes.docker.imageName is not set`);
    }
    if (kind === "podman" && !config.sandboxes?.podman?.imageName) {
      warnings.push(`${context} uses sandbox "podman" but sandboxes.podman.imageName is not set`);
    }
  };
  checkSandboxImageName(config.agent.sandbox, "agent.sandbox");
  for (const [agentName, agent] of Object.entries(config.agents)) {
    checkSandboxImageName(agent.sandbox, `Agent "${agentName}"`);
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
    const validNoHandler = ["auto", "reject"];
    if (config.permissions.noHandlerAction && !validNoHandler.includes(config.permissions.noHandlerAction)) {
      warnings.push(
        `permissions.noHandlerAction "${config.permissions.noHandlerAction}" is not valid (use "auto" or "reject")`,
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

  // Validate Board widget specs — gives an agent/human authoring a widget a
  // precise startup signal instead of a silent fallback render.
  const dashboardWidgets = config.dashboard?.widgets;
  if (dashboardWidgets) {
    const seenWidgetIds = new Set<string>();
    for (const widget of dashboardWidgets) {
      for (const issue of validateDashboardWidget(widget)) {
        warnings.push(`dashboard.widgets: ${issue}`);
      }
      if (widget?.id) {
        if (seenWidgetIds.has(widget.id)) {
          warnings.push(`dashboard.widgets: duplicate widget id "${widget.id}" (the later entry wins)`);
        }
        seenWidgetIds.add(widget.id);
      }
    }
  }

  // An agent whose `tools` is not a list resolves character by character and
  // dies on the first bracket — but only when something finally invokes it,
  // which can be days after the config was written.
  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    for (const field of ["tools", "skills"] as const) {
      const value = (agent as Record<string, unknown> | undefined)?.[field];
      if (value === undefined || Array.isArray(value)) continue;
      warnings.push(
        `agents.${name}.${field} must be a list of names — got ${typeof value}. ` +
          `Write it as a YAML list, or as JSON like ["read", "memory"].`,
      );
    }
  }

  // Rooms: a subscription naming an agent that doesn't exist, or a ref in the
  // wrong shape, means an agent silently never wakes — the failure mode this
  // codebase keeps hitting (config that parses but is never read).
  const roomsConfig = config.rooms;
  if (roomsConfig) {
    const declaredRoomNames = new Set((roomsConfig.rooms ?? []).map((r) => r?.name).filter(Boolean));
    for (const room of roomsConfig.rooms ?? []) {
      if (!room?.name) {
        warnings.push(`rooms.rooms: an entry is missing "name" and will be skipped`);
        continue;
      }
      if (!room.ref || !/^[^:]+:.+$/.test(room.ref)) {
        warnings.push(
          `rooms.rooms."${room.name}": "ref" must look like <backend>:<id> (e.g. discord:1467386788640460822) — got ${JSON.stringify(room.ref)}`,
        );
      }
    }

    for (const sub of roomsConfig.subscriptions ?? []) {
      const label = `rooms.subscriptions[${sub?.agent ?? "?"} -> ${sub?.room ?? "?"}]`;
      if (!sub?.agent) {
        warnings.push(`${label}: missing "agent"`);
      } else if (config.agents && !config.agents[sub.agent]) {
        warnings.push(`${label}: unknown agent "${sub.agent}" — it will never wake`);
      }
      if (!sub?.room) {
        warnings.push(`${label}: missing "room"`);
      } else if (!declaredRoomNames.has(sub.room) && !/^[^:]+:.+$/.test(sub.room)) {
        warnings.push(`${label}: "${sub.room}" is neither a room declared in rooms.rooms nor a <backend>:<id> ref`);
      }
      if (sub?.deliver && sub.deliver !== "push" && sub.deliver !== "poll") {
        warnings.push(`${label}: deliver must be "push" or "poll" — got ${JSON.stringify(sub.deliver)}`);
      }
      if (sub?.wakeOn && !["named", "addressed", "all", "none"].includes(sub.wakeOn)) {
        warnings.push(
          `${label}: wakeOn must be "named", "addressed", "all" or "none" — got ${JSON.stringify(sub.wakeOn)}`,
        );
      }
      if (sub?.deliver === "poll" && sub.pollSeconds !== undefined && sub.pollSeconds < 30) {
        warnings.push(`${label}: pollSeconds ${sub.pollSeconds} is below the 30s floor and will hammer the transport`);
      }
    }
  }

  return warnings;
}

/**
 * Everything `loadConfig` does after `YAML.parse`: interpolation, the
 * back-compat migrations, and the merge over `DEFAULT_CONFIG`.
 *
 * Exported so a *pending* write can be validated as the config it would
 * become rather than as the raw document. Validating the raw document
 * instead would miss every problem the migrations introduce or hide, and
 * would report defaults as missing.
 */
export function normalizeRawConfig(parsed: Record<string, unknown>): AgentConfig {
  const interpolated = deepInterpolate(parsed ?? {}) as Record<string, unknown>;

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
  coerceAgentStringArrays(interpolated);
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

export function loadConfig(configPath?: string): AgentConfig {
  const path = configPath ?? resolve(process.cwd(), "config.yaml");

  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(path, "utf-8");
  return normalizeRawConfig(YAML.parse(raw) as Record<string, unknown>);
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
 * Tolerate an agent's `tools` / `skills` written as a JSON string.
 *
 * An agent that creates another agent writes JSON, because that is what models
 * emit — `tools: '["read", "memory"]'`. Nothing rejected it, and a string is
 * iterable, so `resolveAgent` walked it character by character and died on
 * `unknown tool "["`. The agent looked created, passed every check, and only
 * failed the first time something tried to run it.
 *
 * Parse it here instead. A string that is not a JSON array is left alone so
 * validateConfig can complain about it by name.
 */
function coerceAgentStringArrays(interpolated: Record<string, unknown>): void {
  const agents = interpolated.agents as Record<string, Record<string, unknown>> | undefined;
  if (!agents || typeof agents !== "object") return;

  for (const [name, agent] of Object.entries(agents)) {
    if (!agent || typeof agent !== "object") continue;
    for (const field of ["tools", "skills"] as const) {
      const value = agent[field];
      if (typeof value !== "string") continue;
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
          agent[field] = parsed;
          console.warn(`[config] agents.${name}.${field} was a JSON string; parsed it into a list.`);
        }
      } catch {
        // Left as-is on purpose: validateConfig names the agent and the field,
        // which is far more use than a parse error from here.
      }
    }
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
      defaultModel: ollama.defaultModel ?? "",
      name: "Ollama",
    };
  }
  delete providers.ollama;

  const agent = interpolated.agent as Record<string, unknown> | undefined;
  if (agent && agent.defaultProvider === "ollama") {
    agent.defaultProvider = "openai_compatible";
  }
}
