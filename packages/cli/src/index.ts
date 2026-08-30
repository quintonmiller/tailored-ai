#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AgentRuntime,
  AutopilotWorker,
  ChannelLifecycleManager,
  CronScheduler,
  collectTurnMedia,
  createEmbedder,
  createMetaTools,
  createPluginContext,
  createProvider,
  createTools,
  createWorkflowEngine,
  ExploratoryWorker,
  ensureContextDir,
  executeHooks,
  initDatabase,
  latestMessageId,
  listSessions,
  loadConfig,
  loadExternalAgents,
  loadPlugins,
  loadSession,
  McpManager,
  migrateContextDir,
  newSession,
  type ProjectContext,
  type Room,
  RoomWatcher,
  registerScriptHookHandler,
  registerUiProviderFactory,
  resolveAgent,
  resolveProjectFromCwd,
  resolveUiProvider,
  runAgentLoop,
  runLifecycleHooks,
  ScheduleRunner,
  TaskWatcher,
  TypedEventBus,
  validateConfig,
} from "@tailored-ai/core";
import { checkPortAvailable, createServer, portInUseMessage } from "@tailored-ai/server";
import dotenv from "dotenv";
import { CliApprovalHandler } from "./approval.js";
import { runPluginCommand } from "./commands/plugin.js";
import { runProjectCommand } from "./commands/project.js";
import { runResourcesCommand } from "./commands/resources.js";
import { shutdownReason } from "./commands/service.js";
import { runVaultCommand } from "./commands/vault.js";
import { adoptHomeDir, isSetupDone, resolveHomeDir, resolveHomePaths } from "./home.js";
import { printMediaForTerminal } from "./media-render.js";
import { syncOutboundRegistry } from "./outbound-sync.js";
import { PluginManager } from "./plugins/manager.js";
import { runSetupWizard, type SetupMode } from "./setup.js";

const USAGE = `
Usage: tai [options]

Modes:
  (default)               Start server (HTTP + UI + channels + cron)
  -m, --message <text>    Send a single message and exit
  init                    Create a new config (run \`tai init --help\`)
                          Add --non-interactive to set up without a terminal
  edit                    Edit an existing config (run \`tai edit --help\`)
  project <cmd>           Manage registered projects (run \`tai project help\`)
  deploy <cmd>            Deploy this instance somewhere (run \`tai deploy help\`)

Options:
  -c, --config <path>     Path to config.yaml (uses its directory as home)
  -m, --message <text>    Send a single message and exit (non-interactive mode)
  -s, --session <id>      Resume an existing session by ID
  -a, --agent <name>      Use a named agent
  -j, --json              Output response as JSON (useful for scripting)
      --project <id>      Run scoped to a specific project (overrides cwd resolution)
      --global            Force global mode even inside a registered project
      --port <number>     Override server port
      --init              Alias for \`tai init\` (deprecated — prefer the subcommand)
      --dry-run           With --init: run prompts and print the plan without writing
      --list-agents       List available agents
      --list-sessions     List recent sessions (use --project <id> or --global to filter)
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

// Register the bundled web UI as the "builtin" provider. Custom providers
// register themselves via the plugin loader, which runs before runServer
// resolves the active provider.
registerUiProviderFactory("builtin", () => {
  const staticDir = resolveUiDistPath();
  if (!staticDir) return undefined;
  return { id: "builtin", staticDir };
});

/**
 * Module-scoped reference to the TaskWatcher. main() captures it in
 * the toolFactory closure (so the tasks tool can re-trigger routing on
 * mutations); runServer() assigns it after constructing the watcher
 * (Phase 6 — multi-agent task handoffs).
 */
let _taskWatcherRef:
  | { notifyById: (action: "created" | "updated" | "commented", id: string, projectId?: string) => void }
  | undefined;

async function runServer(
  runtime: AgentRuntime,
  loadRuntimePlugins: () => Promise<import("@tailored-ai/core").LoadedPlugin[]>,
  mcpManager: McpManager,
) {
  // Load the runtime-context plugins (the `builtin:*` default set: agent
  // notifier, scope-creep flagger, stall guard, coder/reviewer project
  // guard). They subscribe to the runtime's event bus on register and
  // return disposers we hold for shutdown + reload. Previously these were
  // hardcoded `new …()` constructions here; #142 routes them through
  // config.plugins so they're user-toggleable (`enabled: false`).
  // Claim the port before anything with side effects starts.
  //
  // The Discord gateway login, cron and autopilot all come up well before the
  // HTTP bind below, so a second instance started by mistake logs a second bot
  // into the guild and fires cron for several seconds before the port
  // collision kills it. The port is deliberately shared between instances —
  // it is the lock that keeps only one running — so the collision is expected
  // and has to be legible rather than a raw stack trace.
  {
    const { host, port } = runtime.getConfig().server;
    const probe = await checkPortAvailable(host, port);
    if (!probe.ok) {
      console.error(
        probe.code === "EADDRINUSE"
          ? portInUseMessage(host, port)
          : `[server] cannot bind ${host}:${port} (${probe.code})`,
      );
      process.exit(1);
    }
  }

  let runtimePlugins = await loadRuntimePlugins();
  const disposeRuntimePlugins = async () => {
    for (const p of runtimePlugins) {
      if (!p.stop) continue;
      try {
        await p.stop();
      } catch (err) {
        console.error(`[plugins] dispose error for ${p.module}:`, (err as Error).message);
      }
    }
  };

  // Every registered channel — Discord (built-in) plus plugin channels
  // (Slack, Telegram, …) — comes up through the lifecycle manager. The
  // manager reconciles desired vs running on each reload so we never
  // restart already-running channels or leak duplicate listeners (#58).
  const channelManager = new ChannelLifecycleManager();
  await channelManager.reconcile(runtime);

  // Local shutdownables: pollers and the HTTP server. Channel-registry
  // channels are owned by channelManager — `shutdown` stops it explicitly.
  const channels: { name: string; disconnect: () => Promise<void> }[] = [];

  // Publish every connected outbound-capable channel into the runtime's
  // outbound registry so channel-id consumers (cron, autopilot, notifier,
  // workflows) resolve them by id instead of constructor injection (#66). The
  // set tracks which ids we've registered so reloads can reconcile them.
  const registeredOutbound = new Set<string>();
  syncOutboundRegistry(runtime, channelManager, registeredOutbound);

  const scheduler = new CronScheduler({ runtime });
  if (runtime.getConfig().cron.enabled) {
    scheduler.start();
  }

  const taskWatcher = new TaskWatcher({ runtime });
  // Hook up the lazy reference so the tasks tool can re-trigger routing
  // on mutations (Phase 6 — coder→reviewer→coder handoffs).
  _taskWatcherRef = taskWatcher;

  // The agent notifier, scope-creep flagger, stall guard, and coder/
  // reviewer project guard used to be constructed here as hardcoded
  // `new …()` instances. #142 moves them to `config.plugins` (the
  // `builtin:*` default set), loaded above via loadRuntimePlugins().

  const autopilot = new AutopilotWorker({
    runtime,
    // Notifier + operator resolve from the runtime's outbound registry and
    // getOwnerId (#66) — no channel-specific injection here anymore.
    getTaskWatcher: () => taskWatcher,
  });
  autopilot.start();

  const exploratory = new ExploratoryWorker({ runtime });
  exploratory.start();

  // Rooms: reconcile the declared subscription set, then arm the watcher.
  // Ordering matters — the watcher reads subscriptions when it starts, and
  // push subscriptions bind to whichever room backends are registered by
  // then, which is why this sits after channelManager.reconcile().
  const roomWatcher = new RoomWatcher({ runtime, store: runtime.getRoomStore() });
  const startRooms = () => {
    try {
      // Let /room status reach the watcher. Re-pointed on every reconcile
      // because the lifecycle manager may have replaced the channel object.
      const discord = channelManager.get("discord")?.channel as
        | { roomStatusRequester?: (room: Room, askedBy: string) => Promise<number> }
        | undefined;
      if (discord) {
        discord.roomStatusRequester = (room, askedBy) => roomWatcher.requestStatusUpdate(room, askedBy);
      }
      // Skip reconcile entirely when rooms are off. Writing subscription rows
      // that nothing services would still make Discord stand its mention
      // handler down for those channels — the bot would go quiet with no
      // visible cause.
      if (runtime.getConfig().rooms?.enabled === false) {
        roomWatcher.stop();
        return;
      }
      runtime.reconcileRooms();
      roomWatcher.start();
    } catch (err) {
      console.error("[rooms] Startup error:", (err as Error).message);
    }
  };
  startRooms();

  // Wakes agents booked for themselves. Started after rooms because a room
  // wake needs the watcher, and resolved lazily for the same reason
  // AutopilotWorker resolves the task watcher lazily: a reload replaces
  // neither object, but the ordering guarantee is not worth relying on.
  const schedules = new ScheduleRunner({ runtime, getRoomWatcher: () => roomWatcher });
  schedules.start();

  // Hot-reload: the lifecycle manager reconciles the channel set against
  // the new config. The outbound registry then re-syncs off whatever the
  // manager produced — for every channel, not just Discord.
  runtime.onReload(async () => {
    scheduler.restart();
    // Picks up a changed tickSeconds, and the `enabled` kill-switch.
    schedules.restart();

    // runtime.reload() calls events.clear(), which drops the builtin
    // plugins' subscriptions (a latent pre-#142 bug — the hardcoded
    // notifier/guards went silent until process restart). onReload runs
    // AFTER the clear, so dispose the stale instances and re-load against
    // the fresh config to re-arm subscriptions (and pick up plugin toggles).
    await disposeRuntimePlugins();
    runtimePlugins = await loadRuntimePlugins();

    try {
      await channelManager.reconcile(runtime);
    } catch (err) {
      console.error("[channels] Reconcile error after reload:", (err as Error).message);
    }

    // MCP servers reconcile via the onReload hook main() registered at
    // manager construction — before the first possible reload, so the
    // fresh tool registry always gets the tools re-registered.

    // Re-sync the outbound registry against the live channel set: register
    // newly-connected outbound channels, unregister ones that went away (#66).
    syncOutboundRegistry(runtime, channelManager, registeredOutbound);

    // Re-arm rooms last: start() tears down every listener and timer first,
    // so a reload cannot leave a second watcher running against the old
    // subscription set.
    startRooms();
  });

  // The CLI registers "builtin" above (top-level side-effect); plugin
  // providers register on plugin import. `server.ui.enabled: false` is the
  // kill-switch — resolveUiProvider returns undefined in that case.
  const uiProvider = await resolveUiProvider(runtime);
  // The engine resolves the outbound sink + owner from the runtime's outbound
  // registry (#66), so the host no longer injects any channel here.
  const workflowEngine = createWorkflowEngine({
    runtime,
    db: runtime.db,
  });
  runtime.setWorkflowEngine(workflowEngine);
  runtime.startWatchingWorkflows();
  scheduler.setWorkflowEngine(workflowEngine);

  // Async triggers (file_drop, email, calendar, rss, geofence, weather,
  // sensor, finance, home_assistant) go through WorkflowTriggerCoordinator
  // — it reconciles registrations against the workflow registry on every
  // change so hot-edits to workflow YAML actually pick up (closes #65).
  const {
    FileDropWatcher,
    EmailPoller,
    CalendarPoller,
    RssPoller,
    GeofencePoller,
    WeatherPoller,
    SensorPoller,
    FinancePoller,
    HomeAssistantPoller,
    WorkflowTriggerCoordinator,
  } = await import("@tailored-ai/core");
  const fileDropWatcher = new FileDropWatcher({ workflowEngine });
  const emailPoller = new EmailPoller({
    workflowEngine,
    getTools: () => runtime.getTools(),
  });
  const calendarPoller = new CalendarPoller({
    workflowEngine,
    getTools: () => runtime.getTools(),
  });
  const rssPoller = new RssPoller({ workflowEngine });
  const geofencePoller = new GeofencePoller({ workflowEngine });
  const weatherPoller = new WeatherPoller({ workflowEngine });
  const sensorPoller = new SensorPoller({ workflowEngine });
  const financePoller = new FinancePoller({ workflowEngine });
  const homeAssistantPoller = new HomeAssistantPoller({ workflowEngine });
  const triggerCoordinator = new WorkflowTriggerCoordinator({
    fileDrop: fileDropWatcher,
    email: emailPoller,
    calendar: calendarPoller,
    rss: rssPoller,
    geofence: geofencePoller,
    weather: weatherPoller,
    sensor: sensorPoller,
    finance: financePoller,
    homeAssistant: homeAssistantPoller,
  });
  triggerCoordinator.start(runtime.getWorkflows());
  channels.push({
    name: "trigger_coordinator",
    disconnect: async () => triggerCoordinator.stopAll(),
  });
  channels.push({
    name: "file_drop",
    disconnect: async () => fileDropWatcher.stop(),
  });
  channels.push({
    name: "email_poll",
    disconnect: async () => emailPoller.stop(),
  });
  channels.push({
    name: "calendar_poll",
    disconnect: async () => calendarPoller.stop(),
  });
  channels.push({
    name: "rss_poll",
    disconnect: async () => rssPoller.stop(),
  });
  channels.push({
    name: "geofence_poll",
    disconnect: async () => geofencePoller.stop(),
  });
  channels.push({
    name: "weather_poll",
    disconnect: async () => weatherPoller.stop(),
  });
  channels.push({
    name: "sensor_poll",
    disconnect: async () => sensorPoller.stop(),
  });
  channels.push({
    name: "finance_poll",
    disconnect: async () => financePoller.stop(),
  });
  channels.push({
    name: "home_assistant_poll",
    disconnect: async () => homeAssistantPoller.stop(),
  });
  const { start } = createServer({
    runtime,
    scheduler,
    taskWatcher,
    autopilot,
    exploratory,
    workflowEngine,
    uiProvider,
    mcpStatus: () => mcpManager.list(),
  });
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
  console.log(`Channels: ${[...channelManager.list().map((c) => c.name), ...channels.map((c) => c.name)].join(", ")}`);
  // MCP servers connect asynchronously and aren't in the one-shot Tools: line
  // above, so surface them explicitly (#249). Silent when none are configured.
  const mcpServers = mcpManager.list();
  if (mcpServers.length > 0) {
    console.log(`MCP: ${mcpServers.map((s) => `${s.serverId} (${s.tools.length})`).join(", ")}`);
  }
  if (uiProvider) {
    const label = uiProvider.id === "builtin" ? "UI" : `UI (${uiProvider.id})`;
    console.log(`${label}: http://${runtime.getConfig().server.host}:${runtime.getConfig().server.port}`);
  }
  console.log("Listening for messages...");

  // `tai:init:end` — channels are connected and a turn can run, so this means
  // *ready* rather than *spawned*. Firing it when the process existed but
  // nothing was listening would race the thing it is meant to follow. The
  // runtime is up, so a hook here may invoke a tool.
  {
    const verdict = await runLifecycleHooks({
      event: "tai:init:end",
      config: runtime.getConfig(),
      tools: await runtime.getTools(),
    });
    if (verdict.deny) {
      // Cannot refuse — the runtime is already serving, so this would be a stop
      // wearing a refusal's clothes. Reported so a hook that tried is visible.
      console.warn(`[lifecycle] tai:init:end returned a refusal, which this phase ignores: ${verdict.deny}`);
    }
  }

  const shutdown = async () => {
    console.log("\nShutting down...");
    // `tai:shutdown:start` — teardown has not begun, so the runtime is still up
    // and a hook here can still call a tool. Failures are reported and never
    // fatal: a hook that could veto a stop would make the instance
    // unstoppable, which is worse than whatever it was protecting.
    try {
      await runLifecycleHooks({
        event: "tai:shutdown:start",
        config: runtime.getConfig(),
        tools: await runtime.getTools(),
        payload: { reason: shutdownReason(resolveHomeDir()) },
      });
    } catch (err) {
      console.error(`[lifecycle] tai:shutdown:start failed: ${(err as Error).message}`);
    }
    runtime.initiateShutdown();
    runtime.stopWatching();
    scheduler.stop();
    taskWatcher.stop();
    await disposeRuntimePlugins();
    autopilot.stop();
    exploratory.stop();
    roomWatcher.stop();
    await channelManager.stopAll();
    await mcpManager.stopAll(runtime);
    for (const ch of channels) {
      await ch.disconnect();
    }
    await new Promise((r) => setTimeout(r, 500));
    // `tai:shutdown:end` — teardown is done and the runtime is gone, but the
    // process is still here, which is what makes this runnable at all. Script
    // tier only. This is where a deployment releases something it acquired at
    // `tai:init:start`.
    try {
      await runLifecycleHooks({
        event: "tai:shutdown:end",
        config: runtime.getConfig(),
        payload: { reason: shutdownReason(resolveHomeDir()) },
      });
    } catch (err) {
      console.error(`[lifecycle] tai:shutdown:end failed: ${(err as Error).message}`);
    }
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

  // Only `scope: all` blocks a person at a terminal. Said plainly and exited
  // non-zero so a script that shells out to `tai -m` fails loudly rather than
  // reading an empty response as an answer.
  if (runtime.isAgentsPaused("human")) {
    const state = runtime.getPauseState();
    const detail = `Agents are paused (scope: ${state.pause_scope ?? "all"})${state.paused_at ? ` since ${state.paused_at}` : ""}.`;
    if (json) {
      console.log(JSON.stringify({ error: detail, paused: true, scope: state.pause_scope }));
    } else {
      console.error(`${detail} Nothing ran. Use /resume in Discord to lift it.`);
    }
    process.exitCode = 1;
    return;
  }

  const contextDir = runtime.contextDir;

  const resolved = resolveAgent(agentName, runtime.getConfig(), runtime.getResolvableTools(), undefined, contextDir);

  const projectId = runtime.getActiveProject()?.id ?? null;
  const session = opts.sessionId
    ? (loadSession(runtime.db, opts.sessionId) ??
      (() => {
        throw new Error(`Session "${opts.sessionId}" not found`);
      })())
    : newSession(runtime.db, resolved.model, resolved.provider, undefined, projectId);

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

    // See `collectTurnMedia`: the watermark separates what this turn produced
    // from what the session already held.
    const watermark = latestMessageId(runtime.db, session.id);

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

    const produced = collectTurnMedia(runtime.db, session.id, watermark);

    if (json) {
      // Refs, not bytes. A script consuming this can fetch what it wants from
      // the store; inlining base64 here would make every screenshot a
      // megabyte of stdout nobody asked for.
      console.log(JSON.stringify({ sessionId: session.id, response, media: produced }));
    } else {
      console.log(response);
      printMediaForTerminal(produced, runtime.getMediaStore());
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

const INIT_HEADLESS_USAGE = `Usage: tai init --non-interactive [options]

Write config.yaml without a terminal. This is what a container entrypoint,
cloud-init script, or CI fixture runs — the interactive wizard needs a TTY
and cannot complete unattended.

Options (each falls back to the env var in brackets):
  --provider <id>     Provider factory id            [TAI_PROVIDER]      (openai_compatible)
  --model <name>      Default model  (required)      [TAI_MODEL]
  --base-url <url>    Provider base URL              [TAI_BASE_URL]
  --api-key <key>     Provider API key -> .env       [TAI_API_KEY]
  --host <addr>       Bind address                   [TAI_SERVER_HOST]   (127.0.0.1)
  --port <n>          Bind port                      [TAI_SERVER_PORT]   (3000)
  --auth-token <tok>  API bearer token -> .env       [TAI_AUTH_TOKEN]
  --no-auth-token     Skip token generation entirely
  --no-ui             Set server.ui.enabled: false (headless deployments)
  --force             Overwrite an existing config.yaml
  --dry-run           Print the plan and write nothing

Binding beyond loopback with no token supplied generates one and prints it
once. Pass --no-auth-token only when something in front of TAI authenticates.`;

async function runSetupCommand(mode: SetupMode, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string", short: "c" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      // Headless init (`tai init --non-interactive`). Accepted in `edit` mode
      // too so a typo there fails on the mode check below with a useful
      // message rather than on strict parseArgs with "unknown option".
      "non-interactive": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "auth-token": { type: "string" },
      "no-auth-token": { type: "boolean", default: false },
      "no-ui": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    strict: true,
  });

  const headless = values["non-interactive"] || values.yes;

  if (values.help) {
    const usage =
      mode === "init"
        ? `Usage: tai init [-c <config>] [--dry-run]\n\nCreate a new config.yaml. Prompts before overwriting an existing one.\n\n${INIT_HEADLESS_USAGE}`
        : "Usage: tai edit [-c <config>] [--dry-run]\n\nOpen the settings editor against an existing config.yaml.";
    console.log(usage);
    return;
  }

  if (headless && mode !== "init") {
    console.error("--non-interactive is only supported by `tai init`.");
    process.exit(1);
  }

  const homeDir = adoptHomeDir(values.config);
  const configPath = values.config ? resolve(values.config) : resolve(homeDir, "config.yaml");
  const configExists = isSetupDone(homeDir);

  if (mode === "edit" && !configExists) {
    console.error(`No config found at ${configPath}. Run \`tai init\` first.`);
    process.exit(1);
  }

  if (headless) {
    const { runHeadlessInit } = await import("./setup-headless.js");
    try {
      await runHeadlessInit({
        homeDir,
        provider: values.provider,
        model: values.model,
        baseUrl: values["base-url"],
        apiKey: values["api-key"],
        host: values.host,
        port: values.port === undefined ? undefined : Number.parseInt(values.port, 10),
        authToken: values["no-auth-token"] ? false : values["auth-token"],
        ui: values["no-ui"] ? false : undefined,
        force: values.force,
        dryRun: values["dry-run"],
      });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  try {
    await runSetupWizard(homeDir, {
      mode,
      dryRun: values["dry-run"],
      existingConfigPath: configExists ? configPath : undefined,
    });
  } catch (err) {
    // TTYError + other expected runEditorApp failures should print cleanly.
    if ((err as { name?: string }).name === "TTYError") {
      console.error((err as Error).message);
      process.exit(1);
    }
    throw err;
  }
}

async function main() {
  // Subcommand routing — peel off any leading positional verbs (e.g. `tai project ...`)
  // before parseArgs, which is strict and rejects positionals.
  // Drop a leading `--` that pnpm/npm/yarn often inject when forwarding args
  // through nested run scripts (e.g. `pnpm run dev -- --init --dry-run` lands
  // here as argv `["--", "--init", "--dry-run"]`).
  let argv = process.argv.slice(2);
  if (argv[0] === "--") argv = argv.slice(1);
  if (argv[0] === "project") {
    await runProjectCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "resources" || argv[0] === "resource") {
    await runResourcesCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "vault") {
    await runVaultCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "plugin" || argv[0] === "plugins") {
    await runPluginCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "start" || argv[0] === "stop" || argv[0] === "restart" || argv[0] === "status") {
    const { cmdRestart, cmdStart, cmdStatus, cmdStop } = await import("./commands/service.js");
    const rest = argv.slice(1);
    const cfgIdx = rest.findIndex((a) => a === "-c" || a === "--config");
    const home = adoptHomeDir(cfgIdx >= 0 ? rest[cfgIdx + 1] : undefined);
    // The serve argv the child is spawned with: everything after the verb, so
    // `-c` and friends carry through to the process that actually runs.
    const serveArgv = rest;
    const code =
      argv[0] === "start"
        ? await cmdStart(home, serveArgv)
        : argv[0] === "stop"
          ? await cmdStop(home)
          : argv[0] === "restart"
            ? await cmdRestart(home, serveArgv)
            : await cmdStatus(home);
    process.exit(code);
  }
  if (argv[0] === "deploy") {
    const { runDeployCommand } = await import("./commands/deploy.js");
    await runDeployCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "init" || argv[0] === "edit") {
    await runSetupCommand(argv[0], argv.slice(1));
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c" },
      message: { type: "string", short: "m" },
      session: { type: "string", short: "s" },
      agent: { type: "string", short: "a" },
      profile: { type: "string", short: "p" }, // deprecated alias for --agent
      json: { type: "boolean", short: "j", default: false },
      project: { type: "string" },
      global: { type: "boolean", default: false },
      port: { type: "string" },
      init: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
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
  let homeDir = adoptHomeDir(values.config);
  let configPath = values.config ? resolve(values.config) : resolve(homeDir, "config.yaml");

  // --- List agents (works before full init, just needs config) ---
  if (values["list-agents"] || values["list-profiles"]) {
    if (!existsSync(configPath)) {
      console.error("No config.yaml found. Run `tai --init` to set up.");
      process.exit(1);
    }
    const config = loadConfig(configPath);
    // Merge config-yaml agents + authored-resources agents (registry takes
    // precedence). Mirrors what `resolveAgent` does at runtime.
    const contextDirForList = resolve(homeDir, "context");
    const authoredAgents: Record<string, import("@tailored-ai/core").AgentDefinition> = {};
    try {
      const { AgentRegistry, populateAgentsFromDisk } = await import("@tailored-ai/core");
      const reg = new AgentRegistry();
      populateAgentsFromDisk(reg, contextDirForList);
      for (const { id, definition } of reg.list()) authoredAgents[id] = definition;
    } catch {
      // Best-effort — fall back to config-only if anything goes wrong.
    }
    const merged: Record<string, { def: import("@tailored-ai/core").AgentDefinition; source: string }> = {};
    for (const [id, def] of Object.entries(config.agents ?? {})) merged[id] = { def, source: "config.yaml" };
    for (const [id, def] of Object.entries(authoredAgents)) merged[id] = { def, source: "authored-resources" };
    const names = Object.keys(merged);
    if (names.length === 0) {
      console.log("No agents configured. Add one via the UI's Resources page or under `agents:` in config.yaml.");
    } else {
      console.log("Available agents:\n");
      for (const name of names) {
        const { def: agentDef, source } = merged[name];
        const model = agentDef.model ? ` (model: ${agentDef.model})` : "";
        const tools = agentDef.tools?.length ? ` [${agentDef.tools.join(", ")}]` : "";
        const desc = agentDef.description ? ` — ${agentDef.description}` : "";
        console.log(`  ${name}${model}${tools}${desc}  [${source}]`);
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
    const filter = values.global ? "global" : values.project;
    const sessions = listSessions(db, filter ? { projectId: filter as string | "global" } : undefined);
    db.close();
    if (sessions.length === 0) {
      console.log("No sessions found.");
    } else {
      const scope = filter === "global" ? " (global only)" : filter ? ` (project ${filter})` : "";
      console.log(`Recent sessions${scope}:\n`);
      const shown = sessions.slice(0, 20);
      for (const s of shown) {
        const key = s.key ? ` (${s.key})` : "";
        const proj = s.project_id ? ` [proj:${s.project_id}]` : "";
        console.log(`  ${s.id}${key}${proj}`);
        console.log(`    ${s.provider}/${s.model} | updated: ${s.updated_at}`);
      }
      if (sessions.length > 20) {
        console.log(`\n  ... and ${sessions.length - 20} more`);
      }
      console.log('\nResume a session: tai -s <id> -m "your message"');
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

    // Without a terminal the Ink wizard throws TTYError from deep inside
    // React, which surfaces as a stack trace that says nothing about what the
    // operator should do. Any unattended first run lands here — a container,
    // a systemd unit, `nohup tai &` — so answer with the command that works.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        `No config found at ${configPath}, and there is no terminal to run the setup wizard in.\n\n` +
          `Create one non-interactively:\n` +
          `  tai init --non-interactive --model <name> [--base-url <url>]\n\n` +
          `Run \`tai init --help\` for the full option list. Every flag also reads\n` +
          `an env var (TAI_MODEL, TAI_BASE_URL, TAI_SERVER_HOST, …), so a container\n` +
          `can be configured entirely through its environment.`,
      );
      process.exit(1);
    }

    // With --init on an existing install, mode=init makes the wizard ask
    // whether to edit or replace before clobbering the file.
    const existingConfigPath = isSetupDone(homeDir) ? configPath : undefined;
    const result = await runSetupWizard(homeDir, {
      mode: "init",
      dryRun: values["dry-run"],
      existingConfigPath,
    });
    if (values["dry-run"]) {
      process.exit(0);
    }
    homeDir = result.homeDir;
    configPath = result.configPath;
  }

  // --- Load .env from home dir ---
  const paths = resolveHomePaths(homeDir);
  dotenv.config({ path: paths.envPath });

  // --- Load config and initialize ---
  const config = loadConfig(configPath);

  // The `script` handler must exist before the first lifecycle hook runs, and
  // `tai:init:start` is the first thing after this. It cannot be a plugin:
  // plugins load later, and a handler that arrives after its event is a hook
  // that silently never ran. Config is the gate instead — see
  // `hooks.allowScripts`.
  if (config.hooks?.allowScripts) {
    registerScriptHookHandler();
  }

  // Validate config and print warnings
  const configWarnings = validateConfig(config);
  for (const warning of configWarnings) {
    console.warn(`[config] Warning: ${warning}`);
  }

  // `tai:init:start` — the process is up, config has been read, and nothing
  // else exists yet. The only phase whose hooks can refuse, and the refusal is
  // the point: a TAI that starts against a dependency that is not there comes
  // up looking healthy and fails on its first turn with an error that points
  // somewhere other than the cause.
  {
    const verdict = await runLifecycleHooks({ event: "tai:init:start", config });
    if (verdict.deny) {
      console.error(`\n[lifecycle] tai:init:start refused the start: ${verdict.deny}`);
      process.exit(1);
    }
  }

  // Load declarative plugins. Plugins are resolved from the TAI-owned plugin
  // home at <homeDir>/plugins/ (third parties, installed via `tai plugin
  // install`) or from @tailored-ai/core's `./plugins/*` subpath export
  // (the `builtin:` prefix — the four default plugins). Workspace / global-
  // npm fallback is intentionally absent so the install path stays single
  // and unambiguous. See #43.
  const pluginManager = new PluginManager(homeDir);
  const importer = pluginManager.buildImporter();
  // The event bus is constructed up-front so plugins and the runtime share
  // one instance — plugin subscriptions land on the same bus the runtime
  // emits to.
  const events = new TypedEventBus();

  // Loading is split into two passes by entry shape (see PR #142 body):
  //   1. Registry-shaped plugins (third-party: tools, channels, providers)
  //      must register BEFORE runtime construction, because the runtime's
  //      constructor runs createTools/createProvider against the registries.
  //      These load now, with no `ctx.runtime` (identical to prior behavior).
  //   2. Runtime-context plugins (the `builtin:*` default set) need the live
  //      runtime to subscribe to its event bus, so they load AFTER the
  //      runtime exists (see loadRuntimePlugins below).
  // The `builtin:` prefix is a load-ordering signal, not a privilege: a
  // builtin loads through the same loadPlugins path as any third party.
  //
  // `@tailored-ai/trusted-actions/plugin` is also a runtime-context plugin —
  // it registers `/api/trusted-actions/*` HTTP routes through core's seam and
  // needs `ctx.runtime` for live config + the session DB (#206). It loads in
  // pass 2 alongside the builtins.
  const TRUSTED_ACTIONS_PLUGIN = "@tailored-ai/trusted-actions/plugin";
  const isRuntimePlugin = (entry: import("@tailored-ai/core").PluginEntry): boolean => {
    const module = typeof entry === "string" ? entry : entry.module;
    return typeof module === "string" && (module.startsWith("builtin:") || module === TRUSTED_ACTIONS_PLUGIN);
  };
  const registryEntries = (config.plugins ?? []).filter((e) => !isRuntimePlugin(e));
  const registryPlugins = await loadPlugins({ ...config, plugins: registryEntries }, importer, {
    context: createPluginContext({ events }),
  });

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
      // resolveOutbound/getOwnerId now come from the runtime's outbound
      // registry (#66) — the runtime wires resolveOutbound(id)/getOwnerId(id)
      // into runtimeOpts, so we no longer inject them here.
      // Module-scoped _taskWatcherRef gets assigned by runServer().
      // Reads lazily at tool-call time, so it's fine if undefined here.
      notifyTaskEvent: (action, id, projectId) => _taskWatcherRef?.notifyById(action, id, projectId),
    });

  const runtime = new AgentRuntime(
    { configPath, db, contextDir, kbDir, createTools: toolFactory, createProvider, createEmbedder, events },
    (path) => loadConfig(path),
    config,
  );
  runtime.recordLoadedPlugins(registryPlugins);

  // Pass-2 loader for runtime-context (`builtin:*`) plugins. Re-reads the
  // entries from the runtime's CURRENT config each call so a reload picks up
  // toggles (enabled: false) and config-bag edits. Returns the LoadedPlugins
  // so the caller can capture their `stop` disposers. runServer() invokes
  // this once at startup and again on every reload (see the onReload hook),
  // which also re-arms subscriptions after runtime.reload() clears the bus.
  const loadRuntimePlugins = async () => {
    const cfg = runtime.getConfig();
    const entries = (cfg.plugins ?? []).filter(isRuntimePlugin);
    // Auto-load the trusted-actions route plugin when the executor is enabled
    // and the user hasn't declared it explicitly. Preserves the old "routes
    // always present when configured" behavior without forcing a config edit.
    // The importer resolves this module from the CLI's own deps (it's an
    // optional dependency), not the plugin home — see buildImporter.
    const taEnabled = !!cfg.trustedActions?.enabled;
    const hasTaEntry = entries.some((e) => (typeof e === "string" ? e : e.module) === TRUSTED_ACTIONS_PLUGIN);
    if (taEnabled && !hasTaEntry) entries.push(TRUSTED_ACTIONS_PLUGIN);
    const loaded = await loadPlugins({ ...cfg, plugins: entries }, importer, {
      context: createPluginContext({ runtime, events }),
    });
    runtime.recordLoadedPlugins(loaded);
    // These plugins load *after* the runtime built its tool set, so a
    // `ctx.tools.register` call from one of them missed the single walk
    // `createTools()` does in the constructor. Without this its tools would
    // first appear on a reload — a registration that silently does nothing
    // until something unrelated happens.
    const added = runtime.applyPendingToolFactories();
    if (added.length > 0) {
      console.log(`[plugins] registered tools from runtime plugins: ${added.join(", ")}`);
    }
    return loaded;
  };

  // Pull in any externalAgents declared in config.yaml. Same source list the
  // editor's SlotEditor uses for plugins, so file/https/git/npm/tai-registry
  // URIs all work.
  if (config.externalAgents?.length) {
    const { buildExternalAgentLoader } = await import("./external-agent-loader.js");
    await loadExternalAgents(config, runtime, buildExternalAgentLoader());
  }

  const metaTools = createMetaTools(runtime, contextDir, kbDir);
  runtime.setMetaTools(metaTools);

  // Connect configured MCP servers and register their discovered tools.
  // Lives up here (not in runServer) so single-message runs get MCP tools
  // too. Connection failures log per-server and never block startup.
  //
  // The reload hook MUST be registered before any reload can fire: every
  // runtime.reload() swaps in a fresh ToolRegistry, dropping MCP tools
  // until the next reconcile re-registers them — and setActiveProject()
  // below triggers exactly such a reload when a project overlay activates.
  // Registering the hook only in runServer left a window where startup
  // lost the tools silently.
  const mcpManager = new McpManager();
  runtime.onReload(() => {
    mcpManager.reconcile(runtime).catch((err) => {
      console.error("[mcp] Reconcile error after reload:", (err as Error).message);
    });
  });
  if (Object.values(runtime.getConfig().mcp?.servers ?? {}).some((s) => s && s.enabled !== false)) {
    await mcpManager.reconcile(runtime);
  }

  // --- Resolve active project from cwd unless --global / --project overrides ---
  let activeProject: ProjectContext | null = null;
  if (values.global) {
    // Forced global mode — leave activeProject null
  } else if (values.project) {
    const ctx = resolveProjectFromCwd(db, { cwd: process.cwd(), warn: () => {} });
    if (ctx && ctx.id === values.project) {
      activeProject = ctx;
    } else {
      // Look up the project by id directly so --project works from any cwd
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(values.project) as
        | { id: string; title: string; path: string | null }
        | undefined;
      if (!row) {
        console.error(`Project not found: ${values.project}`);
        process.exit(1);
      }
      if (!row.path) {
        console.error(`Project ${values.project} has no registered path; cannot scope to it.`);
        process.exit(1);
      }
      activeProject = {
        id: row.id,
        name: row.title,
        path: row.path,
        overlayPath: "",
        overlay: {},
      };
    }
  } else {
    activeProject = resolveProjectFromCwd(db, { cwd: process.cwd() });
  }
  if (activeProject) {
    runtime.setActiveProject(activeProject);
    console.log(`[project] active: ${activeProject.id} (${activeProject.name}) at ${activeProject.path}`);
  }

  // --- Single message mode ---
  if (values.message) {
    try {
      await runSingleMessage(runtime, values.message, {
        agent: values.agent ?? values.profile,
        sessionId: values.session,
        json: values.json!,
      });
    } finally {
      await mcpManager.stopAll(runtime);
      db.close();
    }
    return;
  }

  // --- Server mode (default) ---
  runtime.startWatching();
  await runServer(runtime, loadRuntimePlugins, mcpManager);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
