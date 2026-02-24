#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import {
  executeHooks,
  runAgentLoop,
  resolveAgent,
  loadSession,
  newSession,
  DiscordChannel,
  loadConfig,
  ensureContextDir,
  migrateContextDir,
  CronScheduler,
  TaskWatcher,
  initDatabase,
  AgentRuntime,
  createTools,
  createProvider,
  createMetaTools,
  listSessions,
  validateConfig,
} from "@agent/core";
import { createServer } from "@agent/server";
import { CliApprovalHandler } from "./approval.js";
import { resolveHomeDir, isSetupDone, resolveHomePaths, ensureHomeStructure } from "./home.js";
import { runSetupWizard } from "./setup.js";

let _discordChannel: DiscordChannel | undefined;

const USAGE = `
Usage: tai [options]

Modes:
  (default)               Start server (HTTP + UI + Discord + cron)
  -m, --message <text>    Send a single message and exit

Options:
  -c, --config <path>     Path to config.yaml (uses its directory as home)
  -m, --message <text>    Send a single message and exit (non-interactive mode)
  -s, --session <id>      Resume an existing session by ID
  -a, --agent <name>      Use a named agent
  -j, --json              Output response as JSON (useful for scripting)
      --port <number>     Override server port
      --init              Re-run the setup wizard
      --list-agents       List available agents
      --list-sessions     List recent sessions
  -h, --help              Show this help message
`.trim();

/**
 * Resolve the path to the pre-built UI dist directory.
 * 1. Installed package: <pkg>/ui-dist/
 * 2. Monorepo dev: <repo>/packages/ui/dist/
 */
function resolveUiDistPath(): string | undefined {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Installed package layout: dist/index.js -> ../ui-dist/
  const installed = resolve(__dirname, "..", "ui-dist");
  if (existsSync(installed)) return installed;

  // Monorepo dev layout: packages/cli/src/index.ts -> ../../ui/dist/
  const monorepo = resolve(__dirname, "..", "..", "ui", "dist");
  if (existsSync(monorepo)) return monorepo;

  return undefined;
}

async function connectDiscord(runtime: AgentRuntime): Promise<DiscordChannel | undefined> {
  try {
    const dc = new DiscordChannel({ runtime });
    await dc.connect();
    return dc;
  } catch (err) {
    console.warn(`[discord] Failed to connect: ${(err as Error).message} — running without Discord`);
    return undefined;
  }
}

async function runServer(runtime: AgentRuntime) {
  const channels: { name: string; disconnect: () => Promise<void> }[] = [];

  let discord: DiscordChannel | undefined;
  if (runtime.getConfig().channels.discord?.enabled) {
    discord = await connectDiscord(runtime);
    if (discord) {
      _discordChannel = discord;
      channels.push({ name: "discord", disconnect: () => discord!.disconnect() });
    }
  }

  const scheduler = new CronScheduler({ runtime, discord });
  if (runtime.getConfig().cron.enabled) {
    scheduler.start();
  }

  const taskWatcher = new TaskWatcher({ runtime, discord });

  // Reconnect/disconnect Discord when config changes
  runtime.onReload(() => {
    scheduler.restart();

    const wantsDiscord = runtime.getConfig().channels.discord?.enabled === true;
    const hasDiscord = discord !== undefined;

    if (wantsDiscord && !hasDiscord) {
      connectDiscord(runtime)
        .then((dc) => {
          if (dc) {
            discord = dc;
            _discordChannel = dc;
            scheduler.setDiscord(dc);
            taskWatcher.setDiscord(dc);
            channels.push({ name: "discord", disconnect: () => dc.disconnect() });
            console.log("[discord] Connected after config reload");
          }
        })
        .catch((err) => {
          console.error("[discord] Error connecting after reload:", (err as Error).message);
        });
    } else if (!wantsDiscord && hasDiscord) {
      const old = discord!;
      discord = undefined;
      _discordChannel = undefined;
      scheduler.setDiscord(undefined);
      taskWatcher.setDiscord(undefined);
      const idx = channels.findIndex((c) => c.name === "discord");
      if (idx !== -1) channels.splice(idx, 1);
      old.disconnect().catch((err) => {
        console.error("[discord] Error disconnecting after reload:", (err as Error).message);
      });
    }
  });

  const uiDistPath = resolveUiDistPath();
  const { start } = createServer({ runtime, scheduler, taskWatcher, uiDistPath });
  const httpServer = start();
  channels.push({
    name: `http(:${runtime.getConfig().server.port})`,
    disconnect: () => new Promise<void>((res) => httpServer.close(() => res())),
  });

  const model = runtime.getModel();
  const tools = runtime.getTools();
  console.log("tailored-ai v0.1.0");
  console.log(`Provider: ${runtime.getProvider().name} | Model: ${model}`);
  console.log(`Tools: ${tools.map((t) => t.name).join(", ")}`);
  console.log(`Channels: ${channels.map((c) => c.name).join(", ")}`);
  if (uiDistPath) {
    console.log(`UI: http://${runtime.getConfig().server.host}:${runtime.getConfig().server.port}`);
  }
  console.log("Listening for messages...");

  const shutdown = async () => {
    console.log("\nShutting down...");
    runtime.initiateShutdown();
    runtime.stopWatching();
    scheduler.stop();
    taskWatcher.stop();
    for (const ch of channels) {
      await ch.disconnect();
    }
    await new Promise((r) => setTimeout(r, 500));
    runtime.db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runSingleMessage(
  runtime: AgentRuntime,
  message: string,
  opts: { agent?: string; sessionId?: string; json: boolean },
) {
  const { agent: agentName, json } = opts;
  const contextDir = runtime.contextDir;

  const resolved = resolveAgent(agentName, runtime.getConfig(), runtime.getTools(), undefined, contextDir);

  const session = opts.sessionId
    ? (loadSession(runtime.db, opts.sessionId) ??
      (() => {
        throw new Error(`Session "${opts.sessionId}" not found`);
      })())
    : newSession(runtime.db, resolved.model, resolved.provider);

  const loopOpts = runtime.buildLoopOptions({ session, agentName });
  const cliHooks = runtime.resolveHooks({ agentName });

  try {
    if (cliHooks.beforeRun.length > 0) {
      const { skipped } = await executeHooks(cliHooks.beforeRun, runtime.getTools(), {}, session.id, "[cli]");
      if (skipped) {
        if (json) {
          console.log(JSON.stringify({ sessionId: session.id, response: null, skipped: true }));
        } else {
          console.log("(skipped by beforeRun hook)");
        }
        return;
      }
    }

    // Only create approval handler when permissions require it and stdin is available
    const approvalHandler = loopOpts.permissions ? new CliApprovalHandler() : undefined;

    const response = await runAgentLoop(message, {
      ...loopOpts,
      approvalHandler,
      onToolCall: json
        ? undefined
        : (name, args) => {
            process.stderr.write(`  [tool] ${name}(${JSON.stringify(args)})\n`);
          },
      onToolResult: json
        ? undefined
        : (name, result) => {
            const preview = result.length > 200 ? `${result.slice(0, 200)}...` : result;
            process.stderr.write(`  [result] ${name}: ${preview}\n`);
          },
    });

    if (cliHooks.afterRun.length > 0) {
      await executeHooks(cliHooks.afterRun, runtime.getTools(), { response: response ?? "" }, session.id, "[cli]");
    }

    if (json) {
      console.log(JSON.stringify({ sessionId: session.id, response }));
    } else {
      console.log(response);
    }
  } catch (err) {
    if (json) {
      console.log(JSON.stringify({ sessionId: session.id, error: (err as Error).message }));
      process.exit(1);
    }
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      message: { type: "string", short: "m" },
      session: { type: "string", short: "s" },
      agent: { type: "string", short: "a" },
      profile: { type: "string", short: "p" }, // deprecated alias for --agent
      json: { type: "boolean", short: "j", default: false },
      port: { type: "string" },
      init: { type: "boolean", default: false },
      "list-agents": { type: "boolean", default: false },
      "list-profiles": { type: "boolean", default: false }, // deprecated alias
      "list-sessions": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // --- Resolve home directory ---
  let homeDir = resolveHomeDir(values.config);
  let configPath = values.config ? resolve(values.config) : resolve(homeDir, "config.yaml");

  // --- List agents (works before full init, just needs config) ---
  if (values["list-agents"] || values["list-profiles"]) {
    if (!existsSync(configPath)) {
      console.error("No config.yaml found. Run `tai --init` to set up.");
      process.exit(1);
    }
    const config = loadConfig(configPath);
    const agents = config.agents ?? {};
    const names = Object.keys(agents);
    if (names.length === 0) {
      console.log("No agents configured. Add agents to config.yaml under `agents:`.");
    } else {
      console.log("Available agents:\n");
      for (const name of names) {
        const agentDef = agents[name];
        const model = agentDef.model ? ` (model: ${agentDef.model})` : "";
        const tools = agentDef.tools?.length ? ` [${agentDef.tools.join(", ")}]` : "";
        const desc = agentDef.description ? ` — ${agentDef.description}` : "";
        console.log(`  ${name}${model}${tools}${desc}`);
        if (agentDef.instructions && !agentDef.description) {
          const preview =
            agentDef.instructions.length > 80 ? `${agentDef.instructions.slice(0, 80)}...` : agentDef.instructions;
          console.log(`    ${preview}`);
        }
      }
    }
    process.exit(0);
  }

  // --- List sessions (needs DB) ---
  if (values["list-sessions"]) {
    if (!existsSync(configPath)) {
      console.error("No config.yaml found. Run `tai --init` to set up.");
      process.exit(1);
    }
    const config = loadConfig(configPath);
    const dbPath = resolve(homeDir, config.database.path);
    if (!existsSync(dbPath)) {
      console.log("No sessions found (database does not exist yet).");
      process.exit(0);
    }
    const db = initDatabase(dbPath);
    const sessions = listSessions(db);
    db.close();
    if (sessions.length === 0) {
      console.log("No sessions found.");
    } else {
      console.log("Recent sessions:\n");
      const shown = sessions.slice(0, 20);
      for (const s of shown) {
        const key = s.key ? ` (${s.key})` : "";
        console.log(`  ${s.id}${key}`);
        console.log(`    ${s.provider}/${s.model} | updated: ${s.updated_at}`);
      }
      if (sessions.length > 20) {
        console.log(`\n  ... and ${sessions.length - 20} more`);
      }
      console.log("\nResume a session: tai -s <id> -m \"your message\"");
    }
    process.exit(0);
  }

  // --- Setup wizard ---
  if (values.init || !isSetupDone(homeDir)) {
    // If config.yaml exists in CWD but not in home dir, hint about -c
    if (!values.config && !isSetupDone(homeDir) && existsSync(resolve(process.cwd(), "config.yaml"))) {
      console.log("Found config.yaml in current directory.");
      console.log("  To use it: tai -c ./config.yaml");
      console.log("  To set up a new home directory: tai --init");
      console.log();
    }

    const result = await runSetupWizard(homeDir);
    homeDir = result.homeDir;
    configPath = result.configPath;
  }

  // --- Load .env from home dir ---
  const paths = resolveHomePaths(homeDir);
  dotenv.config({ path: paths.envPath });

  // --- Load config and initialize ---
  const config = loadConfig(configPath);

  // Validate config and print warnings
  const configWarnings = validateConfig(config);
  for (const warning of configWarnings) {
    console.warn(`[config] Warning: ${warning}`);
  }

  // Override port from CLI flag
  if (values.port) {
    config.server.port = Number.parseInt(values.port, 10);
  }

  const dbPath = resolve(homeDir, config.database.path);
  const db = initDatabase(dbPath);

  const contextDir = await ensureContextDir(resolve(homeDir, config.context.directory));
  await migrateContextDir(contextDir);
  await ensureContextDir(resolve(contextDir, "global"));

  const kbDir = await ensureContextDir(resolve(homeDir, config.context.kbDirectory));
  await ensureContextDir(resolve(kbDir, "global"));

  const toolFactory = (cfg: typeof config, ctxDir: string, cfgPath?: string, runtimeOpts?: Record<string, unknown>) =>
    createTools(cfg, ctxDir, cfgPath, {
      ...runtimeOpts,
      getDiscord: () => _discordChannel,
      getOwnerId: () => cfg.channels.discord?.owner,
    });

  const runtime = new AgentRuntime(
    { configPath, db, contextDir, kbDir, createTools: toolFactory, createProvider },
    (path) => loadConfig(path),
    config,
  );

  const metaTools = createMetaTools(runtime, contextDir, kbDir);
  runtime.setMetaTools(metaTools);

  // --- Single message mode ---
  if (values.message) {
    try {
      await runSingleMessage(runtime, values.message, {
        agent: values.agent ?? values.profile,
        sessionId: values.session,
        json: values.json!,
      });
    } finally {
      db.close();
    }
    return;
  }

  // --- Server mode (default) ---
  runtime.startWatching();
  await runServer(runtime);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
