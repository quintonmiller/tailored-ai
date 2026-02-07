#!/usr/bin/env node

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { initDatabase } from './db/schema.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';
import { ExecTool } from './tools/exec.js';
import { ReadTool } from './tools/read.js';
import { WriteTool } from './tools/write.js';
import { WebFetchTool } from './tools/web-fetch.js';
import { WebSearchTool } from './tools/web-search.js';
import { TrelloTool } from './tools/trello.js';
import { GmailTool } from './tools/gmail.js';
import { GoogleCalendarTool } from './tools/google-calendar.js';
import { ClaudeCodeTool } from './tools/claude-code.js';
import { BrowserTool } from './tools/browser.js';
import { MdToPdfTool } from './tools/md-to-pdf.js';
import { GoogleDriveTool } from './tools/google-drive.js';
import { AskUserTool } from './tools/ask-user.js';
import { MemoryTool } from './tools/memory.js';
import { DelegateTool } from './tools/delegate.js';
import { TaskStatusTool } from './tools/task-status.js';
import { AdminTool } from './tools/admin.js';
import { createCustomTools } from './tools/custom.js';
import { ensureContextDir, migrateContextDir } from './context.js';
import { runAgentLoop } from './agent/loop.js';
import { resolveProfile } from './agent/profiles.js';
import { newSession, loadSession, resetSession } from './agent/session.js';
import { isCommand, executeCommand } from './commands.js';
import { DiscordChannel } from './channels/discord.js';
import { CronScheduler } from './cron/scheduler.js';
import { createServer } from './server.js';
import { AgentRuntime } from './runtime.js';
import type { AIProvider } from './providers/interface.js';
import type { AgentConfig } from './config.js';
import type { Tool } from './tools/interface.js';

let _discordChannel: DiscordChannel | undefined;

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

function createProvider(config: AgentConfig): { provider: AIProvider; model: string } {
  if (config.agent.defaultProvider === 'ollama' && config.providers.ollama) {
    return {
      provider: new OllamaProvider(config.providers.ollama.baseUrl),
      model: config.providers.ollama.defaultModel,
    };
  }
  if (config.agent.defaultProvider === 'openai' && config.providers.openai) {
    return {
      provider: new OpenAIProvider(config.providers.openai.apiKey, config.providers.openai.baseUrl),
      model: config.providers.openai.defaultModel,
    };
  }
  throw new Error(
    `No supported provider configured for "${config.agent.defaultProvider}".`
  );
}

function createTools(config: AgentConfig, contextDir: string, configPath?: string): Tool[] {
  const globalDir = resolve(contextDir, 'global');
  const tools: Tool[] = [];
  if (config.tools.memory?.enabled !== false) {
    tools.push(new MemoryTool(globalDir));
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
  if (config.tools.browser?.enabled) {
    tools.push(new BrowserTool(config.tools.browser));
  }
  if (config.tools.md_to_pdf?.enabled) {
    tools.push(new MdToPdfTool());
  }
  if (config.tools.google_drive?.enabled && config.tools.google_drive.account) {
    tools.push(new GoogleDriveTool(
      config.tools.google_drive.account,
      gogPassword,
      config.tools.google_drive.folder_name,
      config.tools.google_drive.folder_id,
      configPath,
    ));
  }
  if (config.tools.ask_user?.enabled !== false) {
    tools.push(new AskUserTool({
      contextDir,
      getDiscord: () => _discordChannel,
      getOwnerId: () => config.channels.discord?.owner,
    }));
  }
  if (config.custom_tools) {
    tools.push(...createCustomTools(config.custom_tools));
  }
  return tools;
}

async function runServe(runtime: AgentRuntime) {
  const channels: { name: string; disconnect: () => Promise<void> }[] = [];

  let discord: DiscordChannel | undefined;
  if (runtime.getConfig().channels.discord?.enabled) {
    discord = new DiscordChannel({ runtime });
    await discord.connect();
    _discordChannel = discord;
    channels.push({ name: 'discord', disconnect: () => discord!.disconnect() });
  }

  const scheduler = new CronScheduler({ runtime, discord });
  if (runtime.getConfig().cron.enabled) {
    scheduler.start();
  }
  runtime.onReload(() => scheduler.restart());

  // Start the HTTP server (after scheduler so it can trigger jobs)
  const { start } = createServer({ runtime, scheduler });
  const httpServer = start();
  channels.push({
    name: `http(:${runtime.getConfig().server.port})`,
    disconnect: () => new Promise<void>((res) => httpServer.close(() => res())),
  });

  const model = runtime.getModel();
  const tools = runtime.getTools();
  console.log(`autonomous-agent v0.1.0 (service mode)`);
  console.log(`Provider: ${runtime.getProvider().name} | Model: ${model}`);
  console.log(`Tools: ${tools.map((t) => t.name).join(', ')}`);
  console.log(`Channels: ${channels.map((c) => c.name).join(', ')}`);
  console.log(`Listening for messages...`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    runtime.stopWatching();
    scheduler.stop();
    for (const ch of channels) {
      await ch.disconnect();
    }
    runtime.db.close();
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
  const config = loadConfig(configPath);
  const dbPath = resolve(process.cwd(), config.database.path);
  const db = initDatabase(dbPath);

  const contextDir = await ensureContextDir(resolve(process.cwd(), config.context.directory));
  await migrateContextDir(contextDir);
  await ensureContextDir(resolve(contextDir, 'global'));

  const runtime = new AgentRuntime(
    { configPath, db, contextDir, createTools, createProvider },
    (path) => loadConfig(path),
    config,
  );

  const delegateTool = new DelegateTool({
    getConfig: () => runtime.getConfig(),
    db,
    getProvider: () => runtime.getProvider(),
    getTools: () => runtime.getTools(),
    contextDir,
  });
  const taskStatusTool = new TaskStatusTool();
  const adminTool = new AdminTool(runtime);

  // Service mode
  if (values.serve) {
    runtime.startWatching();
    await runServe(runtime);
    return;
  }

  const metaTools = [delegateTool, taskStatusTool, adminTool];

  const makeGetTools = (profileName?: string) => {
    if (profileName) {
      return () => {
        const resolved = resolveProfile(profileName, runtime.getConfig(), runtime.getTools(), undefined, contextDir);
        return [...resolved.tools, ...metaTools];
      };
    }
    return () => [...runtime.getTools(), ...metaTools];
  };

  const resolved = resolveProfile(values.profile, runtime.getConfig(), runtime.getTools(), undefined, contextDir);
  const tools = [...resolved.tools, ...metaTools];

  let session = values.session
    ? loadSession(db, values.session) ?? (() => { throw new Error(`Session "${values.session}" not found`); })()
    : newSession(db, resolved.model, resolved.provider);

  const loopOpts = {
    provider: runtime.getProvider(),
    session,
    db,
    tools,
    extraInstructions: resolved.instructions,
    maxToolRounds: resolved.maxToolRounds,
    maxHistoryTokens: runtime.getConfig().agent.maxHistoryTokens,
    temperature: resolved.temperature,
    contextDir,
    profileContextDir: resolved.contextDir,
    getTools: makeGetTools(values.profile),
    getProvider: () => runtime.getProvider(),
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
  runtime.startWatching();

  let activeProfile = values.profile as string | undefined;

  console.log(`autonomous-agent v0.1.0`);
  console.log(`Provider: ${runtime.getProvider().name} | Model: ${runtime.getModel()}`);
  console.log(`Tools: ${tools.map((t) => t.name).join(', ')}`);
  console.log(`Session: ${session.id}`);
  console.log(`Type your message (Ctrl+C to quit)\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  const runAgentMessage = async (message: string) => {
    const response = await runAgentLoop(message, {
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
  };

  const applyProfile = (profileName: string | undefined) => {
    activeProfile = profileName;
    const r = resolveProfile(profileName, runtime.getConfig(), runtime.getTools(), undefined, contextDir);
    loopOpts.tools = [...r.tools, ...metaTools];
    loopOpts.extraInstructions = r.instructions;
    loopOpts.temperature = r.temperature;
    loopOpts.maxToolRounds = r.maxToolRounds;
    loopOpts.contextDir = contextDir;
    loopOpts.profileContextDir = r.contextDir;
    loopOpts.getTools = makeGetTools(profileName);
  };

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (isCommand(input)) {
      const result = await executeCommand(input, {
        config: runtime.getConfig(),
        currentProfile: activeProfile,
      });

      switch (result.type) {
        case 'new_session': {
          session = newSession(db, resolved.model, resolved.provider);
          loopOpts.session = session;
          console.log(`\nStarted new session: ${session.id}\n`);
          break;
        }
        case 'switch_profile': {
          try {
            applyProfile(result.profile);
            session = newSession(db, resolved.model, resolved.provider);
            loopOpts.session = session;
            console.log(`\nSwitched to profile "${result.profile}" (new session: ${session.id})\n`);
          } catch (err) {
            console.error(`Error: ${(err as Error).message}`);
          }
          break;
        }
        case 'help': {
          console.log(`\n${result.text}\n`);
          break;
        }
        case 'shell_output': {
          console.log(`\n${result.output}\n`);
          break;
        }
        case 'agent_prompt':
        case 'shell_then_prompt': {
          try {
            const prevProfile = activeProfile;
            if (result.profile) applyProfile(result.profile);
            if (result.newSession) {
              session = newSession(db, resolved.model, resolved.provider);
              loopOpts.session = session;
            }
            await runAgentMessage(result.prompt);
            if (result.profile && result.profile !== prevProfile) applyProfile(prevProfile);
          } catch (err) {
            console.error(`Error: ${(err as Error).message}`);
          }
          break;
        }
        case 'error': {
          console.error(`\n${result.message}\n`);
          break;
        }
        case 'unknown_command': {
          console.error(`\nUnknown command "/${result.name}". Type /help for available commands.\n`);
          break;
        }
      }

      rl.prompt();
      return;
    }

    try {
      await runAgentMessage(input);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    runtime.stopWatching();
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
