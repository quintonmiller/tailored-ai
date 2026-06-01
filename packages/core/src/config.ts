import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { PermissionsConfig } from "./approval.js";

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
  delivery?: {
    channel: "log" | "discord" | "discord-dm";
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
  delivery?: {
    channel: "log" | "discord" | "discord-dm";
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
}

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
  providers: {
    /**
     * Generic OpenAI-compatible HTTP provider. Use for vLLM, Ollama's /v1
     * endpoint, LM Studio, text-generation-webui, llama.cpp server, etc.
     * `apiKey` is optional — when omitted, no Authorization header is sent.
     */
    openai_compatible?: {
      baseUrl: string;
      defaultModel: string;
      apiKey?: string;
      /** Optional human-friendly label shown in logs/UI. Defaults to "OpenAI-compatible". */
      name?: string;
    };
    openai?: {
      apiKey: string;
      defaultModel: string;
      baseUrl?: string;
    };
    anthropic?: {
      apiKey: string;
      defaultModel: string;
      baseUrl?: string;
    };
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
  };
  channels: {
    discord?: {
      enabled: boolean;
      token: string;
      owner?: string;
      allowedGuilds?: string[];
      respondToDMs: boolean;
      respondToMentions: boolean;
      /**
       * Route messages to a specific project based on channel id or DM origin.
       * Each entry may set `channel: <id>` to bind a guild channel, or `dm: true`
       * to bind direct messages. The first matching entry wins. Unmapped messages
       * fall back to global mode.
       */
      projectMappings?: Array<({ channel: string } | { dm: true }) & { project: string }>;
    };
    /**
     * Additional channels supplied by plugins (e.g. slack, telegram, imessage).
     * Each plugin registers a factory via `registerChannelFactory(id, ...)` and
     * reads its own config slice. Channels with `enabled: true` are started by
     * `startRegisteredChannels` on CLI startup.
     */
    [channelId: string]: { enabled?: boolean; [key: string]: unknown } | undefined;
  };
  /**
   * Third-party plugin modules to load at startup. Each entry is either a
   * package specifier (`"@some-author/tai-plugin-x"`) or an object with
   * `module` and optional `config`. Loading happens before runtime
   * construction; the plugin's import side-effects register tools, channels,
   * providers, task backends, step executors, etc. into the matching
   * registries.
   *
   * Per-plugin `config` is currently ignored by the loader — plugins read
   * their configuration from the normal `tools.*`, `channels.*`, etc. blocks
   * in this config file. The field is reserved for future routing.
   */
  plugins?: Array<string | { module: string; config?: Record<string, unknown> }>;
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
    discord_dm?: {
      enabled: boolean;
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
    /** Which task backend to use for project tasks and autopilot. Default "native". */
    backend?: "native" | "github" | "beans" | "beads";
    /** Backend-specific options keyed by backend name. */
    github?: { repo?: string; token?: string };
    beans?: { path?: string };
    beads?: { path?: string };
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
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  server: {
    port: 3000,
    host: "0.0.0.0",
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
  return deepMerge(base as unknown as Record<string, unknown>, overlay) as unknown as AgentConfig;
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

  // Validate tasks block
  if (config.tasks) {
    const validBackends = ["native", "github", "beans", "beads"];
    const backend = config.tasks.backend;
    if (backend && !validBackends.includes(backend)) {
      warnings.push(`tasks.backend "${backend}" is not valid (use ${validBackends.map((b) => `"${b}"`).join(", ")})`);
    }
    if (backend === "github") {
      const gh = config.tasks.github;
      if (!gh?.repo) {
        warnings.push(`tasks.backend is "github" but tasks.github.repo is not set`);
      } else if (!/^[^/\s]+\/[^/\s]+$/.test(gh.repo)) {
        warnings.push(`tasks.github.repo "${gh.repo}" is not in "owner/repo" format`);
      }
      if (!gh?.token) {
        warnings.push(`tasks.backend is "github" but tasks.github.token is not set`);
      }
    }
  }

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

  // Network exposure check. The default host is "0.0.0.0" so the dashboard
  // is reachable from anywhere on the LAN. If no auth is configured, every
  // session, chat history, and tool output is readable by anyone who can
  // route to the port. Flag loud at startup.
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
  coerceCronJobs(interpolated);

  return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, interpolated) as unknown as AgentConfig;
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
