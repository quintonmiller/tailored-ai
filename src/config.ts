import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

export interface AgentProfile {
  model?: string;
  provider?: string;
  instructions?: string;
  tools?: string[];
  temperature?: number;
  maxToolRounds?: number;
  contextDir?: string;
}

export interface CronJobConfig {
  name: string;
  schedule: string;
  prompt: string;
  sessionKey?: string;
  model?: string;
  profile?: string;
  enabled?: boolean;
  delivery?: {
    channel: 'log' | 'discord' | 'discord-dm';
    target?: string;
  };
  wakeAgent?: boolean;
}

export interface CustomToolConfig {
  description: string;
  parameters: Record<string, { type: string; description: string }>;
  command: string;
  timeout_ms?: number;
}

export interface CommandConfig {
  description: string;
  command?: string;       // Shell command template ({{input}} interpolated)
  prompt?: string;        // Prompt template sent through agent loop ({{input}}, {{output}})
  profile?: string;       // Named profile to use
  new_session?: boolean;  // Start fresh session (default: false)
  timeout_ms?: number;    // Shell timeout (default: 30s)
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
  };
  agent: {
    defaultProvider: string;
    extraInstructions: string;
    maxHistoryTokens: number;
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
  profiles: Record<string, AgentProfile>;
  context: {
    directory: string;
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
    trello?: {
      enabled: boolean;
      apiKey: string;
      token: string;
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
  };
  custom_tools: Record<string, CustomToolConfig>;
  commands: Record<string, CommandConfig>;
}

const DEFAULT_CONFIG: AgentConfig = {
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  database: {
    path: './agent.db',
  },
  providers: {
    ollama: {
      baseUrl: 'http://localhost:11434',
      defaultModel: 'devstral-small-2:latest',
    },
  },
  agent: {
    defaultProvider: 'ollama',
    extraInstructions: '',
    maxHistoryTokens: 2000,
    temperature: 0.3,
    maxToolRounds: 10,
  },
  profiles: {},
  cron: {
    enabled: false,
    jobs: [],
  },
  context: {
    directory: './data/context',
  },
  channels: {},
  tools: {
    memory: { enabled: true },
    exec: { enabled: true },
    read: { enabled: true },
    write: { enabled: true },
    web_fetch: { enabled: true },
    web_search: { enabled: false, provider: 'brave', apiKey: '', maxResults: 5 },
  },
  custom_tools: {},
  commands: {},
};

function interpolateEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
}

function deepInterpolate(obj: unknown): unknown {
  if (typeof obj === 'string') return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(deepInterpolate);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepInterpolate(v);
    }
    return result;
  }
  return obj;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(configPath?: string): AgentConfig {
  const path = configPath ?? resolve(process.cwd(), 'config.yaml');

  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = YAML.parse(raw) as Record<string, unknown>;
  const interpolated = deepInterpolate(parsed) as Record<string, unknown>;

  return deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    interpolated
  ) as unknown as AgentConfig;
}
