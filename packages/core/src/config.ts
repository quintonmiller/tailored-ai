import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { PermissionsConfig } from "./approval.js";

export interface ModelEntry {
  provider: string;
  model: string;
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
  /** Hooks to run before/after the agent loop when using this agent. */
  hooks?: {
    beforeRun?: AgentHook | AgentHook[];
    afterRun?: AgentHook | AgentHook[];
  };
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
}

export interface WebhookRouteConfig {
  path: string;
  action: "agent" | "log";
  messageTemplate: string;
  agent?: string;
  /** @deprecated Use agent instead. */
  profile?: string;
  sessionKey?: string;
  newSession?: boolean;
}

export interface AgentConfig {
  server: {
    port: number;
    host: string;
    apiKey?: string;
  };
  database: {
    path: string;
  };
  providers: {
    ollama?: {
      baseUrl: string;
      defaultModel: string;
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
  };
  channels: {
    discord?: {
      enabled: boolean;
      token: string;
      owner?: string;
      allowedGuilds?: string[];
      respondToDMs: boolean;
      respondToMentions: boolean;
    };
  };
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
    browser?: {
      enabled: boolean;
      headless?: boolean;
      screenshotDir?: string;
      timeoutMs?: number;
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
  };
  taskWatcher: TaskWatcherConfig;
  webhooks: {
    enabled: boolean;
    secret?: string;
    routes: WebhookRouteConfig[];
  };
  custom_tools: Record<string, CustomToolConfig>;
  commands: Record<string, CommandConfig>;
  permissions?: PermissionsConfig;
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
    ollama: {
      baseUrl: "http://localhost:11434",
      defaultModel: "devstral-small-2:latest",
    },
  },
  agent: {
    defaultProvider: "ollama",
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
    projects: { enabled: true, directory: "./data/projects" },
    documents: { enabled: true },
  },
  taskWatcher: {
    enabled: false,
    prompt: "Task {{action}}: {{task_title}} ({{task_id}}), status: {{task_status}}. {{task_description}}",
    debounceMs: 5000,
    triggers: ["created", "updated"],
  },
  webhooks: {
    enabled: false,
    routes: [],
  },
  custom_tools: {},
  commands: {},
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
  // Custom tools are always available when defined
  for (const name of Object.keys(config.custom_tools ?? {})) {
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

  // Validate permissions config
  if (config.permissions) {
    const validModes = ["auto", "approve"];
    if (config.permissions.defaultMode && !validModes.includes(config.permissions.defaultMode)) {
      warnings.push(`permissions.defaultMode "${config.permissions.defaultMode}" is not valid (use "auto" or "approve")`);
    }
    const validTimeoutActions = ["reject", "auto_approve"];
    if (config.permissions.timeoutAction && !validTimeoutActions.includes(config.permissions.timeoutAction)) {
      warnings.push(`permissions.timeoutAction "${config.permissions.timeoutAction}" is not valid (use "reject" or "auto_approve")`);
    }
    if (config.permissions.tools) {
      for (const toolName of Object.keys(config.permissions.tools)) {
        if (!enabledToolNames.has(toolName)) {
          warnings.push(`permissions.tools references tool "${toolName}" which is not enabled`);
        }
      }
    }
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

  return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, interpolated) as unknown as AgentConfig;
}
