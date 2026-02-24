import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { ensureHomeStructure, resolveHomePaths } from "./home.js";

interface SetupResult {
  homeDir: string;
  configPath: string;
}

interface ProviderAnswers {
  provider: string;
  providerBlock: string;
  envLines: string[];
}

/** Fetch available models from an Ollama instance and return as select options. */
async function fetchOllamaModels(baseUrl: string): Promise<{ value: string; label: string }[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: { name: string; size: number }[] };
    if (!data.models?.length) return null;
    return data.models.map((m) => ({
      value: m.name,
      label: m.name,
    }));
  } catch {
    return null;
  }
}

/** Test connectivity to a provider. Returns null on success, error message on failure. */
async function testProviderConnection(
  provider: string,
  opts: { baseUrl?: string; apiKey?: string },
): Promise<string | null> {
  const s = p.spinner();
  s.start("Testing connection...");

  try {
    if (provider === "ollama") {
      const url = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        s.stop("Connection failed");
        return `Ollama returned HTTP ${res.status}. Is it running at ${url}?`;
      }
      s.stop("Connected to Ollama");
      return null;
    }

    if (provider === "openai") {
      const url = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
      const res = await fetch(`${url}/models`, {
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        s.stop("Connection failed");
        return `OpenAI API returned HTTP ${res.status}. Check your API key and base URL.`;
      }
      s.stop("Connected to OpenAI");
      return null;
    }

    if (provider === "anthropic") {
      // Use a minimal messages request that will fail with a clear auth error if key is bad
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey ?? "",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) {
        s.stop("Connection failed");
        return "Invalid API key. Check your Anthropic API key.";
      }
      // Any non-401 response means auth is valid (even 400/429 means key works)
      s.stop("Connected to Anthropic");
      return null;
    }

    s.stop("Skipped");
    return null;
  } catch (err) {
    s.stop("Connection failed");
    const msg = (err as Error).message;
    if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
      return `Could not reach ${provider}. Is it running?`;
    }
    if (msg.includes("timed out") || msg.includes("TimeoutError")) {
      return `Connection timed out. Check the URL and try again.`;
    }
    return `Connection error: ${msg}`;
  }
}

async function askProvider(): Promise<ProviderAnswers> {
  const provider = await p.select({
    message: "Which AI provider will you use?",
    options: [
      { value: "ollama", label: "Ollama", hint: "local, free" },
      { value: "openai", label: "OpenAI", hint: "GPT-4o, etc." },
      { value: "anthropic", label: "Anthropic", hint: "Claude" },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const envLines: string[] = [];

  if (provider === "ollama") {
    const baseUrl = await p.text({
      message: "Ollama URL:",
      initialValue: "http://localhost:11434",
    });
    if (p.isCancel(baseUrl)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    // Test connectivity
    const connError = await testProviderConnection("ollama", { baseUrl });
    if (connError) {
      p.log.warn(connError);
      const proceed = await p.confirm({ message: "Continue anyway?" });
      if (p.isCancel(proceed) || !proceed) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
    }

    // Try to fetch available models for selection
    let model: string;
    const models = connError ? null : await fetchOllamaModels(baseUrl);
    if (models && models.length > 0) {
      const selected = await p.select({
        message: "Select a model:",
        options: [
          ...models,
          { value: "__custom__", label: "Enter a custom model name..." },
        ],
      });
      if (p.isCancel(selected)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
      if (selected === "__custom__") {
        const custom = await p.text({
          message: "Model name:",
          initialValue: "devstral-small-2:latest",
        });
        if (p.isCancel(custom)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        model = custom;
      } else {
        model = selected as string;
      }
    } else {
      const entered = await p.text({
        message: "Default model:",
        initialValue: "devstral-small-2:latest",
      });
      if (p.isCancel(entered)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
      model = entered;
    }

    const block = [
      "providers:",
      "  ollama:",
      `    baseUrl: ${baseUrl}`,
      `    defaultModel: ${model}`,
      "  # openai:",
      "  #   apiKey: ${OPENAI_API_KEY}",
      "  #   defaultModel: gpt-4o",
      "  #   baseUrl: https://api.openai.com/v1   # optional, for OpenAI-compatible APIs",
      "  # anthropic:",
      "  #   apiKey: ${ANTHROPIC_API_KEY}",
      "  #   defaultModel: claude-sonnet-4-5-20250929",
    ].join("\n");

    return { provider, providerBlock: block, envLines };
  }

  if (provider === "openai") {
    const apiKey = await p.text({
      message: "OpenAI API key:",
      validate: (v) => (v.trim() ? undefined : "API key is required"),
    });
    if (p.isCancel(apiKey)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const baseUrl = await p.text({
      message: "Base URL (leave default for OpenAI):",
      initialValue: "https://api.openai.com/v1",
    });
    if (p.isCancel(baseUrl)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    // Test connectivity
    const connError = await testProviderConnection("openai", { apiKey, baseUrl });
    if (connError) {
      p.log.warn(connError);
      const proceed = await p.confirm({ message: "Continue anyway?" });
      if (p.isCancel(proceed) || !proceed) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
    }

    const model = await p.select({
      message: "Select a model:",
      options: [
        { value: "gpt-4o", label: "gpt-4o", hint: "recommended" },
        { value: "gpt-4o-mini", label: "gpt-4o-mini", hint: "faster, cheaper" },
        { value: "gpt-4-turbo", label: "gpt-4-turbo" },
        { value: "__custom__", label: "Enter a custom model name..." },
      ],
    });
    if (p.isCancel(model)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    let modelName: string;
    if (model === "__custom__") {
      const custom = await p.text({ message: "Model name:", initialValue: "gpt-4o" });
      if (p.isCancel(custom)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
      modelName = custom;
    } else {
      modelName = model as string;
    }

    envLines.push(`OPENAI_API_KEY=${apiKey}`);
    const block = [
      "providers:",
      "  openai:",
      "    apiKey: ${OPENAI_API_KEY}",
      `    defaultModel: ${modelName}`,
      `    baseUrl: ${baseUrl}`,
      "  # ollama:",
      "  #   baseUrl: http://localhost:11434",
      "  #   defaultModel: devstral-small-2:latest",
      "  # anthropic:",
      "  #   apiKey: ${ANTHROPIC_API_KEY}",
      "  #   defaultModel: claude-sonnet-4-5-20250929",
    ].join("\n");

    return { provider, providerBlock: block, envLines };
  }

  // anthropic
  const apiKey = await p.text({
    message: "Anthropic API key:",
    validate: (v) => (v.trim() ? undefined : "API key is required"),
  });
  if (p.isCancel(apiKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // Test connectivity
  const connError = await testProviderConnection("anthropic", { apiKey });
  if (connError) {
    p.log.warn(connError);
    const proceed = await p.confirm({ message: "Continue anyway?" });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
  }

  const model = await p.select({
    message: "Select a model:",
    options: [
      { value: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929", hint: "recommended" },
      { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001", hint: "faster, cheaper" },
      { value: "claude-opus-4-5-20250514", label: "claude-opus-4-5-20250514", hint: "most capable" },
      { value: "__custom__", label: "Enter a custom model name..." },
    ],
  });
  if (p.isCancel(model)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  let modelName: string;
  if (model === "__custom__") {
    const custom = await p.text({ message: "Model name:", initialValue: "claude-sonnet-4-5-20250929" });
    if (p.isCancel(custom)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    modelName = custom;
  } else {
    modelName = model as string;
  }

  envLines.push(`ANTHROPIC_API_KEY=${apiKey}`);
  const block = [
    "providers:",
    "  anthropic:",
    "    apiKey: ${ANTHROPIC_API_KEY}",
    `    defaultModel: ${modelName}`,
    "  # ollama:",
    "  #   baseUrl: http://localhost:11434",
    "  #   defaultModel: devstral-small-2:latest",
    "  # openai:",
    "  #   apiKey: ${OPENAI_API_KEY}",
    "  #   defaultModel: gpt-4o",
    "  #   baseUrl: https://api.openai.com/v1",
  ].join("\n");

  return { provider, providerBlock: block, envLines };
}

function generateConfig(provider: string, providerBlock: string): string {
  return `# Tailored AI configuration
# Docs: https://github.com/quintushr/autonomous-agent

# --- Server ---
server:
  port: 3000
  host: 0.0.0.0
  # apiKey: "secret"          # protect mutating API endpoints (optional)

# --- Database ---
database:
  path: ./agent.db

# --- Providers ---
# Uncomment additional providers to enable them. API keys are read from .env.
${providerBlock}

# --- Agent defaults ---
agent:
  defaultProvider: ${provider}
  extraInstructions: ""        # appended to every system prompt
  temperature: 0.7
  maxToolRounds: 100
  maxHistoryTokens: 20000

# --- Tools ---
# Enable or disable individual tools. Disabled tools are hidden from the model.
tools:
  exec:
    enabled: true
    allowedCommands:
      - ls
      - cat
      - git
  read:
    enabled: true
  write:
    enabled: true
  web_fetch:
    enabled: true
  web_search:
    enabled: false
    # provider: brave
    # apiKey: \${BRAVE_API_KEY}
    # maxResults: 5
  # browser:
  #   enabled: false
  #   headless: true
  # claude_code:
  #   enabled: false

# --- Channels ---
channels:
  discord:
    enabled: false
    token: \${DISCORD_BOT_TOKEN}
    owner: \${DISCORD_OWNER_ID}
    respondToDMs: true
    respondToMentions: true

# --- Profiles ---
# Named agent configurations. Use with: tai -m "query" -p researcher
profiles:
  researcher:
    instructions: >-
      You are a research assistant. Search the web, fetch pages,
      and summarize findings concisely.
    tools:
      - web_search
      - web_fetch
      - memory
    temperature: 0.5
    maxToolRounds: 8
  writer:
    instructions: >-
      You are a writing assistant. Read files for context, then
      draft or edit content. Save results with the write tool.
    tools:
      - read
      - write
      - memory
    temperature: 0.7
    maxToolRounds: 10

# --- Cron jobs ---
# Scheduled tasks. Requires running tai in server mode (the default).
cron:
  enabled: false
  jobs: []
  # jobs:
  #   - name: daily-research
  #     schedule: "0 9 * * *"
  #     prompt: "Research today's AI news"
  #     profile: researcher

# --- Custom tools ---
# Shell command templates exposed as tools. {{param}} is interpolated.
custom_tools: {}
  # weather:
  #   command: curl -s wttr.in/{{city}}?format=3
  #   description: Get weather for a city
  #   parameters:
  #     city:
  #       type: string
  #       description: City name

# --- Webhooks ---
webhooks:
  enabled: false
  # secret: "webhook-secret"
  # routes:
  #   - path: /deploy
  #     action: agent
  #     messageTemplate: "Deploy triggered: {{repo}} by {{user}}"

# --- Custom commands ---
# Slash commands for the web UI and CLI. Supports shell + agent prompts.
commands: {}
  # summarize:
  #   description: Summarize the current conversation
  #   prompt: "Summarize our conversation so far in 3 bullet points."
`;
}

export async function runSetupWizard(defaultHomeDir: string): Promise<SetupResult> {
  p.intro("Welcome to Tailored AI");

  const location = await p.select({
    message: "Where should tai store its data?",
    options: [
      { value: "home", label: defaultHomeDir, hint: "recommended" },
      { value: "cwd", label: process.cwd(), hint: "current directory" },
      { value: "custom", label: "Custom path" },
    ],
  });

  if (p.isCancel(location)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  let homeDir = defaultHomeDir;
  if (location === "cwd") {
    homeDir = process.cwd();
  } else if (location === "custom") {
    const custom = await p.text({
      message: "Enter the path:",
      validate: (v) => (v.trim() ? undefined : "Path is required"),
    });
    if (p.isCancel(custom)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    homeDir = resolve(custom);
  }

  const { provider, providerBlock, envLines } = await askProvider();

  const s = p.spinner();
  s.start("Creating directory structure");

  await ensureHomeStructure(homeDir);
  const paths = resolveHomePaths(homeDir);

  writeFileSync(paths.configPath, generateConfig(provider, providerBlock), "utf-8");

  if (envLines.length > 0) {
    writeFileSync(paths.envPath, `${envLines.join("\n")}\n`, "utf-8");
  }

  s.stop("Configuration saved");

  p.outro(`Setup complete! Data directory: ${homeDir}`);

  return { homeDir, configPath: paths.configPath };
}
