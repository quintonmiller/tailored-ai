#!/usr/bin/env node

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { initDatabase } from './db/schema.js';
import { OllamaProvider } from './providers/ollama.js';
import { ExecTool } from './tools/exec.js';
import { ReadTool } from './tools/read.js';
import { WriteTool } from './tools/write.js';
import { WebFetchTool } from './tools/web-fetch.js';
import { WebSearchTool } from './tools/web-search.js';
import { TrelloTool } from './tools/trello.js';
import { GmailTool } from './tools/gmail.js';
import { GoogleCalendarTool } from './tools/google-calendar.js';
import { ClaudeCodeTool } from './tools/claude-code.js';
import { MemoryTool } from './tools/memory.js';
import { DelegateTool } from './tools/delegate.js';
import { ensureContextDir } from './context.js';
import { runAgentLoop } from './agent/loop.js';
import { resolveProfile } from './agent/profiles.js';
import { newSession, loadSession } from './agent/session.js';
import { DiscordChannel } from './channels/discord.js';
import { CronScheduler } from './cron/scheduler.js';
import { createServer } from './server.js';
import type { AIProvider } from './providers/interface.js';
import type { Tool } from './tools/interface.js';

const USAGE = `
Usage: agent [options]

Modes:
  (default)               Interactive REPL
  --message <text>        Send a single message and exit
  --serve                 Start as a service (Discord bot, etc.)

Options:
  -c, --config <path>     Path to config.yaml (default: ./config.yaml)
  -m, --message <text>    Send a single message and exit (non-interactive mode)
  -s, --session <id>      Resume an existing session by ID
  -p, --profile <name>    Use a named agent profile
  -j, --json              Output response as JSON (useful for scripting)
      --serve             Run as a service with configured channels
  -h, --help              Show this help message
`.trim();

function createProvider(config: ReturnType<typeof loadConfig>): { provider: AIProvider; model: string } {
  if (config.agent.defaultProvider === 'ollama' && config.providers.ollama) {
    return {
      provider: new OllamaProvider(config.providers.ollama.baseUrl),
      model: config.providers.ollama.defaultModel,
    };
  }
  throw new Error(
    `No supported provider configured for "${config.agent.defaultProvider}". Currently only Ollama is supported.`
  );
}

function createTools(config: ReturnType<typeof loadConfig>, contextDir: string): Tool[] {
  const tools: Tool[] = [];
  if (config.tools.memory?.enabled !== false) {
    tools.push(new MemoryTool(contextDir));
  }
  if (config.tools.exec?.enabled !== false) {
    tools.push(new ExecTool(config.tools.exec?.allowedCommands));
  }
  if (config.tools.read?.enabled !== false) {
    tools.push(new ReadTool(config.tools.read?.allowedPaths));
  }
  if (config.tools.write?.enabled !== false) {
    tools.push(new WriteTool(config.tools.write?.allowedPaths));
  }
  if (config.tools.web_fetch?.enabled !== false) {
    tools.push(new WebFetchTool());
  }
  if (config.tools.web_search?.enabled && config.tools.web_search.apiKey) {
    tools.push(new WebSearchTool(config.tools.web_search.apiKey, config.tools.web_search.maxResults));
  }
  if (config.tools.trello?.enabled && config.tools.trello.apiKey && config.tools.trello.token) {
    tools.push(new TrelloTool(config.tools.trello.apiKey, config.tools.trello.token));
  }
  const gogPassword = process.env.GOG_KEYRING_PASSWORD ?? '';
  if (config.tools.gmail?.enabled && config.tools.gmail.account) {
    tools.push(new GmailTool(config.tools.gmail.account, gogPassword));
  }
  if (config.tools.google_calendar?.enabled && config.tools.google_calendar.account) {
    tools.push(new GoogleCalendarTool(config.tools.google_calendar.account, gogPassword));
  }
  if (config.tools.claude_code?.enabled) {
    tools.push(new ClaudeCodeTool(config.tools.claude_code));
  }
  return tools;
}

async function runServe(config: ReturnType<typeof loadConfig>, configPath: string, db: ReturnType<typeof initDatabase>, provider: AIProvider, model: string, tools: Tool[], contextDir: string) {
  const channels: { name: string; disconnect: () => Promise<void> }[] = [];

  // Always start the HTTP server
  const { start } = createServer({ config, configPath, db, provider, model, tools, contextDir });
  const httpServer = start();
  channels.push({
    name: `http(:${config.server.port})`,
    disconnect: () => new Promise<void>((res) => httpServer.close(() => res())),
  });

  let discord: DiscordChannel | undefined;
  if (config.channels.discord?.enabled) {
    discord = new DiscordChannel({ config, db, provider, model, tools, contextDir });
    await discord.connect();
    channels.push({ name: 'discord', disconnect: () => discord!.disconnect() });
  }

  let scheduler: CronScheduler | undefined;
  if (config.cron.enabled && config.cron.jobs.length) {
    scheduler = new CronScheduler({ config, db, provider, model, tools, contextDir, discord });
    scheduler.start();
  }

  console.log(`autonomous-agent v0.1.0 (service mode)`);
  console.log(`Provider: ${provider.name} | Model: ${model}`);
  console.log(`Tools: ${tools.map((t) => t.name).join(', ')}`);
  console.log(`Channels: ${channels.map((c) => c.name).join(', ')}`);
  console.log(`Listening for messages...`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    scheduler?.stop();
    for (const ch of channels) {
      await ch.disconnect();
    }
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      message: { type: 'string', short: 'm' },
      session: { type: 'string', short: 's' },
      profile: { type: 'string', short: 'p' },
      json: { type: 'boolean', short: 'j', default: false },
      serve: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const configPath = resolve(process.cwd(), values.config ?? 'config.yaml');
  const config = loadConfig(values.config);
  const dbPath = resolve(process.cwd(), config.database.path);
  const db = initDatabase(dbPath);

  const contextDir = await ensureContextDir(resolve(process.cwd(), config.context.directory));

  const { provider, model } = createProvider(config);
  const allTools = createTools(config, contextDir);

  const delegateTool = new DelegateTool({ config, db, provider, allTools, contextDir });

  // Service mode
  if (values.serve) {
    const serveTools = [...allTools, delegateTool];
    await runServe(config, configPath, db, provider, model, serveTools, contextDir);
    return;
  }

  const resolved = resolveProfile(values.profile, config, allTools);
  const tools = [...resolved.tools, delegateTool];

  const session = values.session
    ? loadSession(db, values.session) ?? (() => { throw new Error(`Session "${values.session}" not found`); })()
    : newSession(db, resolved.model, resolved.provider);

  const loopOpts = {
    provider,
    session,
    db,
    tools,
    extraInstructions: resolved.instructions,
    maxToolRounds: resolved.maxToolRounds,
    maxHistoryTokens: config.agent.maxHistoryTokens,
    temperature: resolved.temperature,
    contextDir,
  };

  // Non-interactive mode: send one message and exit
  if (values.message) {
    try {
      const response = await runAgentLoop(values.message, {
        ...loopOpts,
        onToolCall: values.json
          ? undefined
          : (name, args) => {
              process.stderr.write(`  [tool] ${name}(${JSON.stringify(args)})\n`);
            },
        onToolResult: values.json
          ? undefined
          : (name, result) => {
              const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
              process.stderr.write(`  [result] ${name}: ${preview}\n`);
            },
      });

      if (values.json) {
        console.log(JSON.stringify({ sessionId: session.id, response }));
      } else {
        console.log(response);
      }
    } catch (err) {
      if (values.json) {
        console.log(JSON.stringify({ sessionId: session.id, error: (err as Error).message }));
        process.exit(1);
      }
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      db.close();
    }
    return;
  }

  // Interactive mode
  console.log(`autonomous-agent v0.1.0`);
  console.log(`Provider: ${provider.name} | Model: ${model}`);
  console.log(`Tools: ${tools.map((t) => t.name).join(', ')}`);
  console.log(`Session: ${session.id}`);
  console.log(`Type your message (Ctrl+C to quit)\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    try {
      const response = await runAgentLoop(input, {
        ...loopOpts,
        onToolCall: (name, args) => {
          console.log(`  [tool] ${name}(${JSON.stringify(args)})`);
        },
        onToolResult: (name, result) => {
          const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
          console.log(`  [result] ${name}: ${preview}`);
        },
      });

      console.log(`\n${response}\n`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
