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
  createEmbedder,
  createMetaTools,
  createPluginContext,
  createProvider,
  createTools,
  createWorkflowEngine,
  type DiscordChannel,
  ExploratoryWorker,
  ensureContextDir,
  executeHooks,
  initDatabase,
  listSessions,
  loadConfig,
  loadExternalAgents,
  loadPlugins,
  loadSession,
  migrateContextDir,
  newSession,
  type ProjectContext,
  registerUiProviderFactory,
  resolveAgent,
  resolveProjectFromCwd,
  resolveUiProvider,
  runAgentLoop,
  TaskWatcher,
  TypedEventBus,
  validateConfig,
} from "@tailored-ai/core";
import { createServer } from "@tailored-ai/server";
import dotenv from "dotenv";
import { CliApprovalHandler } from "./approval.js";
import { runPluginCommand } from "./commands/plugin.js";
import { runProjectCommand } from "./commands/project.js";
import { runResourcesCommand } from "./commands/resources.js";
import { runVaultCommand } from "./commands/vault.js";
import { isSetupDone, resolveHomeDir, resolveHomePaths } from "./home.js";
import { PluginManager } from "./plugins/manager.js";
import { runSetupWizard, type SetupMode } from "./setup.js";

let _discordChannel: import("@tailored-ai/core").DiscordChannel | undefined;

const USAGE = `
Usage: tai [options]

Modes:
  (default)               Start server (HTTP + UI + Discord + cron)
  -m, --message <text>    Send a single message and exit
  init                    Create a new config (run \`tai init --help\`)
  edit                    Edit an existing config (run \`tai edit --help\`)
  project <cmd>           Manage registered projects (run \`tai project help\`)

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
) {
  // Load the runtime-context plugins (the `builtin:*` default set: Discord
  // notifier, scope-creep flagger, stall guard, coder/reviewer project
  // guard). They subscribe to the runtime's event bus on register and
  // return disposers we hold for shutdown + reload. Previously these were
  // hardcoded `new …()` constructions here; #142 routes them through
  // config.plugins so they're user-toggleable (`enabled: false`).
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

  _discordChannel = channelManager.get("discord")?.channel as DiscordChannel | undefined;
  // Publish the live Discord sink into the runtime's outbound registry so
  // channel-id consumers (cron, autopilot, notifier, workflows) resolve it by
  // id instead of constructor injection (#66).
  if (_discordChannel) runtime.registerOutbound(_discordChannel);

  const scheduler = new CronScheduler({ runtime });
  if (runtime.getConfig().cron.enabled) {
    scheduler.start();
  }

  const taskWatcher = new TaskWatcher({ runtime });
  // Hook up the lazy reference so the tasks tool can re-trigger routing
  // on mutations (Phase 6 — coder→reviewer→coder handoffs).
  _taskWatcherRef = taskWatcher;

  // The Discord notifier, scope-creep flagger, stall guard, and coder/
  // reviewer project guard used to be constructed here as hardcoded
  // `new …()` instances. #142 moves them to `config.plugins` (the
  // `builtin:*` default set), loaded above via loadRuntimePlugins().

  const autopilot = new AutopilotWorker({
    runtime,
    // Notifier + operator resolve from the runtime's outbound registry and
    // getOwnerId (#66) — no Discord-specific injection here anymore.
    getTaskWatcher: () => taskWatcher,
  });
  autopilot.start();

  const exploratory = new ExploratoryWorker({ runtime });
  exploratory.start();

  // Hot-reload: the lifecycle manager reconciles the channel set against
  // the new config. The Discord-specific notifier wiring then re-syncs
  // off whatever the manager produced.
  runtime.onReload(async () => {
    scheduler.restart();

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

    const next = channelManager.get("discord")?.channel as DiscordChannel | undefined;
    if (next !== _discordChannel) {
      _discordChannel = next;
      // Keep the outbound registry in sync with the live connection. All
      // consumers (cron, autopilot, DiscordNotifier, workflows) resolve the
      // Discord sink through the registry at use time (#66).
      if (next) runtime.registerOutbound(next);
      else runtime.unregisterOutbound("discord");
      if (next) console.log("[discord] Connected after config reload");
      else console.log("[discord] Disconnected after config reload");
    }
  });

  // The CLI registers "builtin" above (top-level side-effect); plugin
  // providers register on plugin import. `server.ui.enabled: false` is the
  // kill-switch — resolveUiProvider returns undefined in that case.
  const uiProvider = await resolveUiProvider(runtime);
  // getDiscord/getOwnerId default to the runtime's outbound registry (#66),
  // so the host no longer injects the Discord channel here.
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
  if (uiProvider) {
    const label = uiProvider.id === "builtin" ? "UI" : `UI (${uiProvider.id})`;
    console.log(`${label}: http://${runtime.getConfig().server.host}:${runtime.getConfig().server.port}`);
  }
  console.log("Listening for messages...");

  const shutdown = async () => {
    console.log("\nShutting down...");
    runtime.initiateShutdown();
    runtime.stopWatching();
    scheduler.stop();
    taskWatcher.stop();
    await disposeRuntimePlugins();
    autopilot.stop();
    exploratory.stop();
    await channelManager.stopAll();
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

async function runSetupCommand(mode: SetupMode, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string", short: "c" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    const usage =
      mode === "init"
        ? "Usage: tai init [-c <config>] [--dry-run]\n\nCreate a new config.yaml. Prompts before overwriting an existing one."
        : "Usage: tai edit [-c <config>] [--dry-run]\n\nOpen the settings editor against an existing config.yaml.";
    console.log(usage);
    return;
  }

  const homeDir = resolveHomeDir(values.config);
  const configPath = values.config ? resolve(values.config) : resolve(homeDir, "config.yaml");
  const configExists = isSetupDone(homeDir);

  if (mode === "edit" && !configExists) {
    console.error(`No config found at ${configPath}. Run \`tai init\` first.`);
    process.exit(1);
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
  let homeDir = resolveHomeDir(values.config);
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

  // Validate config and print warnings
  const configWarnings = validateConfig(config);
  for (const warning of configWarnings) {
    console.warn(`[config] Warning: ${warning}`);
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
  const isRuntimePlugin = (entry: import("@tailored-ai/core").PluginEntry): boolean => {
    const module = typeof entry === "string" ? entry : entry.module;
    return typeof module === "string" && module.startsWith("builtin:");
  };
  const registryEntries = (config.plugins ?? []).filter((e) => !isRuntimePlugin(e));
  await loadPlugins({ ...config, plugins: registryEntries }, importer, {
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
      // getDiscord/getOwnerId now come from the runtime's outbound registry
      // (#66) — the runtime wires getOutbound("discord")/getOwnerId("discord")
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

  // Pass-2 loader for runtime-context (`builtin:*`) plugins. Re-reads the
  // entries from the runtime's CURRENT config each call so a reload picks up
  // toggles (enabled: false) and config-bag edits. Returns the LoadedPlugins
  // so the caller can capture their `stop` disposers. runServer() invokes
  // this once at startup and again on every reload (see the onReload hook),
  // which also re-arms subscriptions after runtime.reload() clears the bus.
  const loadRuntimePlugins = () => {
    const entries = (runtime.getConfig().plugins ?? []).filter(isRuntimePlugin);
    return loadPlugins({ ...runtime.getConfig(), plugins: entries }, importer, {
      context: createPluginContext({ runtime, events }),
    });
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
      db.close();
    }
    return;
  }

  // --- Server mode (default) ---
  runtime.startWatching();
  await runServer(runtime, loadRuntimePlugins);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
