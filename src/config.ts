import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

export interface AgentConfig {
  server: {
    port: number;
    host: string;
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
    };
  };
  agent: {
    defaultProvider: string;
    systemPrompt: string;
    maxHistoryTokens: number;
    temperature: number;
    maxToolRounds: number;
  };
  channels: {
    discord?: {
      enabled: boolean;
      token: string;
      allowedGuilds?: string[];
      respondToDMs: boolean;
      respondToMentions: boolean;
    };
  };
  tools: {
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
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  server: {
    port: 3000,
    host: '127.0.0.1',
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
    systemPrompt:
      'You are a helpful assistant with access to tools. Use them when you need real information. After getting results, summarize for the user.',
    maxHistoryTokens: 2000,
    temperature: 0.3,
    maxToolRounds: 10,
  },
  channels: {},
  tools: {
    exec: { enabled: true },
    read: { enabled: true },
    write: { enabled: true },
  },
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
