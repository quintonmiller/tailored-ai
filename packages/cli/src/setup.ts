import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import type {
  DraftConfig,
  ProviderDraft,
  ProviderKind,
  ResolvedPlugin,
  SlotChoice,
  ToolsDraft,
} from "./editor/types.js";
import { defaultDraft } from "./editor/types.js";
import { ensureHomeStructure, resolveHomePaths } from "./home.js";

interface SetupResult {
  homeDir: string;
  configPath: string;
}

interface EditorPlan {
  source: "new" | "existing";
  homeDir: string;
  configPath: string;
  envPath: string;
  /** New mode: full config file. Edit mode: serialized yaml.Document. */
  configContent: string;
  /** Edit mode only: original content for diff display. */
  originalContent?: string;
  /** Human-readable change list for edit mode. */
  changes: string[];
  envLines: string[];
  plugins: ResolvedPlugin[];
}

export type SetupMode = "init" | "edit";

// ─── Pure helpers: hydrate / render / patch ───────────────────────────────────

/** Read a config.yaml into a DraftConfig. Comments + formatting are not preserved
 * — patchExistingYaml is what writes back to disk while keeping them. */
export function hydrateFromYaml(text: string, homeDir: string): DraftConfig {
  const doc = parseDocument(text);
  const get = <T = unknown>(path: (string | number)[], fallback: T): T => {
    const v = doc.getIn(path);
    if (v === undefined || v === null) return fallback;
    return v as T;
  };

  const providerKind = get<string>(["agent", "defaultProvider"], "openai_compatible") as ProviderKind;
  const providerDefaultModel = get<string>(["providers", providerKind, "defaultModel"], "");
  const providerBaseUrl = get<string | undefined>(["providers", providerKind, "baseUrl"], undefined);

  return {
    homeDir,
    provider: {
      kind: providerKind,
      defaultModel: providerDefaultModel,
      baseUrl: providerBaseUrl,
    },
    tools: {
      memory: Boolean(get(["tools", "memory", "enabled"], true)),
      exec: Boolean(get(["tools", "exec", "enabled"], true)),
      read: Boolean(get(["tools", "read", "enabled"], true)),
      write: Boolean(get(["tools", "write", "enabled"], true)),
      web_fetch: Boolean(get(["tools", "web_fetch", "enabled"], true)),
      web_search: Boolean(get(["tools", "web_search", "enabled"], false)),
    },
    channels: hydrateChannels(doc),
    plugins: ((doc.toJS()?.plugins ?? []) as Array<string | { module: string }>).map((entry) => ({
      uri: typeof entry === "string" ? entry : entry.module,
    })),
    externalAgents: ((doc.toJS()?.externalAgents ?? []) as string[]).map((uri) => ({ uri })),
    // server.ui.enabled is the kill-switch; server.ui.provider selects a
    // registered factory ("builtin" by default). memory.backend.provider
    // works the same way. taskBackend stays at "builtin" — it has its own
    // registry but the editor doesn't write `tasks.backend` yet.
    ui: hydrateUi(doc),
    memory: hydrateMemory(doc),
    taskBackend: "builtin",
    systemPromptBaseFile: hydrateSystemPromptBaseFile(doc),
    envLines: [],
  };
}

/**
 * Read the `channels:` map into `{ <id>: enabled }`. No channel is privileged
 * — every config block contributes a row. `discord` (the built-in example) is
 * always seeded so it shows in the editor even when absent from config.
 */
function hydrateChannels(doc: ReturnType<typeof parseDocument>): Record<string, boolean> {
  const channels: Record<string, boolean> = { discord: false };
  const block = doc.toJS()?.channels as Record<string, { enabled?: unknown } | undefined> | undefined;
  for (const [id, cfg] of Object.entries(block ?? {})) {
    channels[id] = Boolean(cfg?.enabled);
  }
  return channels;
}

function hydrateSystemPromptBaseFile(doc: ReturnType<typeof parseDocument>): string | undefined {
  const v = doc.getIn(["agent", "systemPrompt", "baseFile"]);
  return typeof v === "string" && v.trim() ? v : undefined;
}

function describeSystemPromptBaseFile(v: string | undefined): string {
  return v ? `baseFile ${v}` : "built-in default";
}

function applySystemPromptBaseFile(doc: ReturnType<typeof parseDocument>, baseFile: string | undefined): void {
  doc.deleteIn(["agent", "systemPrompt", "baseFile"]);
  if (baseFile) {
    doc.setIn(["agent", "systemPrompt", "baseFile"], baseFile);
    return;
  }
  const sp = doc.getIn(["agent", "systemPrompt"]);
  if (sp && typeof sp === "object" && !Array.isArray(sp) && (sp as { items?: unknown[] }).items?.length === 0) {
    doc.deleteIn(["agent", "systemPrompt"]);
  }
}

function hydrateUi(doc: ReturnType<typeof parseDocument>): SlotChoice {
  if (doc.getIn(["server", "ui", "enabled"]) === false) return "disabled";
  const provider = doc.getIn(["server", "ui", "provider"]);
  if (typeof provider === "string" && provider !== "builtin") {
    return { customUri: provider };
  }
  return "builtin";
}

function slotEquals(a: SlotChoice, b: SlotChoice): boolean {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object") return a.customUri === b.customUri;
  return false;
}

function describeUi(s: SlotChoice): string {
  if (s === "disabled") return "disabled";
  if (s === "builtin") return "builtin";
  return `provider: ${s.customUri}`;
}

function applyUiSlot(doc: ReturnType<typeof parseDocument>, slot: SlotChoice): void {
  // Clear both fields first so transitions don't leave stale keys behind.
  doc.deleteIn(["server", "ui", "enabled"]);
  doc.deleteIn(["server", "ui", "provider"]);
  if (slot === "disabled") {
    doc.setIn(["server", "ui", "enabled"], false);
    return;
  }
  if (typeof slot === "object") {
    doc.setIn(["server", "ui", "provider"], slot.customUri);
    return;
  }
  // builtin — leave server.ui empty; clean up an empty map if present.
  const ui = doc.getIn(["server", "ui"]);
  if (ui && typeof ui === "object" && !Array.isArray(ui) && (ui as { items?: unknown[] }).items?.length === 0) {
    doc.deleteIn(["server", "ui"]);
  }
}

function hydrateMemory(doc: ReturnType<typeof parseDocument>): SlotChoice {
  const provider = doc.getIn(["memory", "backend", "provider"]);
  if (typeof provider === "string" && provider !== "builtin") {
    return { customUri: provider };
  }
  return "builtin";
}

function describeMemory(s: SlotChoice): string {
  if (s === "builtin") return "builtin";
  if (s === "disabled") return "disabled";
  return `provider: ${s.customUri}`;
}

function applyMemorySlot(doc: ReturnType<typeof parseDocument>, slot: SlotChoice): void {
  doc.deleteIn(["memory", "backend", "provider"]);
  if (typeof slot === "object") {
    doc.setIn(["memory", "backend", "provider"], slot.customUri);
    return;
  }
  // builtin — drop empty memory.backend / memory blocks left behind.
  const backend = doc.getIn(["memory", "backend"]);
  if (
    backend &&
    typeof backend === "object" &&
    !Array.isArray(backend) &&
    (backend as { items?: unknown[] }).items?.length === 0
  ) {
    doc.deleteIn(["memory", "backend"]);
  }
  const memory = doc.getIn(["memory"]);
  if (
    memory &&
    typeof memory === "object" &&
    !Array.isArray(memory) &&
    (memory as { items?: unknown[] }).items?.length === 0
  ) {
    doc.deleteIn(["memory"]);
  }
}

function renderProviderBlock(d: ProviderDraft): string {
  if (d.kind === "openai_compatible") {
    const lines = [
      "providers:",
      "  openai_compatible:",
      `    baseUrl: ${d.baseUrl ?? "http://localhost:11434/v1"}`,
      `    defaultModel: ${d.defaultModel}`,
    ];
    if (d.presetName) lines.push(`    name: ${d.presetName}`);
    if (d.apiKey) lines.push("    apiKey: ${OPENAI_COMPATIBLE_API_KEY}");
    return lines.join("\n");
  }
  // Any other kind (plugin-registered: openai, anthropic, openrouter,
  // bedrock, …): a generic block — the provider owns its config shape, the
  // editor only seeds the universal fields.
  const envVar = `${d.kind.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  const lines = ["providers:", `  ${d.kind}:`, `    apiKey: \${${envVar}}`, `    defaultModel: ${d.defaultModel}`];
  if (d.baseUrl) lines.push(`    baseUrl: ${d.baseUrl}`);
  return lines.join("\n");
}

function renderToolsBlock(t: ToolsDraft): string {
  const lines = ["tools:"];
  const indent = "  ";
  lines.push(`${indent}memory:`, `${indent}  enabled: ${t.memory}`);
  lines.push(`${indent}exec:`, `${indent}  enabled: ${t.exec}`);
  if (t.exec) {
    lines.push(`${indent}  allowedCommands:`, `${indent}    - ls`, `${indent}    - cat`, `${indent}    - git`);
  }
  lines.push(`${indent}read:`, `${indent}  enabled: ${t.read}`);
  lines.push(`${indent}write:`, `${indent}  enabled: ${t.write}`);
  lines.push(`${indent}web_fetch:`, `${indent}  enabled: ${t.web_fetch}`);
  lines.push(`${indent}web_search:`, `${indent}  enabled: ${t.web_search}`);
  return lines.join("\n");
}

function renderPluginsBlock(plugins: ResolvedPlugin[]): string {
  if (plugins.length === 0) return "plugins: []";
  const lines = ["plugins:"];
  for (const pl of plugins) {
    const note = pl.manifestId ? ` # ${pl.manifestId}@${pl.version ?? "?"}` : "";
    lines.push(`  - "${pl.uri}"${note}`);
  }
  return lines.join("\n");
}

function renderExternalAgentsBlock(agents: ResolvedPlugin[]): string {
  if (agents.length === 0) return "";
  const lines = ["externalAgents:"];
  for (const a of agents) {
    const note = a.manifestId ? ` # ${a.manifestId}@${a.version ?? "?"}` : "";
    lines.push(`  - "${a.uri}"${note}`);
  }
  return `\n${lines.join("\n")}\n`;
}

/**
 * Same three hosts core's `validateConfig` treats as loopback. Kept in sync
 * deliberately: this decides whether headless init mints an auth token, and
 * core decides whether to warn that one is missing. If the two lists drifted,
 * one of them would be wrong about the same config.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Server block overrides for {@link renderNewConfig}.
 *
 * The Ink wizard never sets these — a wizard run happens on a machine with a
 * terminal, where loopback is the right default. The headless path
 * (`tai init --non-interactive`, which is what a container's first boot runs)
 * does, because a server bound to 127.0.0.1 inside a container is reachable
 * only from inside that container.
 */
export interface ServerRenderOptions {
  host?: string;
  port?: number;
  /**
   * Emit `authToken: ${<name>}` referencing this env var. The token itself is
   * never written into config.yaml — config.yaml is the file people paste into
   * issues, and it is the one most likely to end up committed.
   */
  authTokenEnvVar?: string;
}

export function renderNewConfig(d: DraftConfig, server: ServerRenderOptions = {}): string {
  const providerBlock = renderProviderBlock(d.provider);
  const toolsBlock = renderToolsBlock(d.tools);
  const pluginsBlock = renderPluginsBlock(d.plugins);
  const externalAgentsBlock = renderExternalAgentsBlock(d.externalAgents);
  const discordEnabled = d.channels.discord ? "true" : "false";
  // The researcher sample only claims web_search when web_search is actually
  // on. It used to list it unconditionally while the tool defaults to off,
  // so every fresh install booted with `Agent "researcher" references tool
  // "web_search" which is not enabled` — a warning on a file TAI itself just
  // wrote, which teaches people that startup warnings are noise. They are not:
  // the network-exposure warning prints through the same channel.
  const researcherSearchTool = d.tools.web_search
    ? "\n      - web_search"
    : "\n      # - web_search   # add once tools.web_search.enabled is true";
  const host = server.host ?? "127.0.0.1";
  const port = server.port ?? 3000;
  const authTokenLine = server.authTokenEnvVar ? `\n  authToken: \${${server.authTokenEnvVar}}` : "";
  // The loopback default carries a warning about unbinding it. Once the host
  // IS unbound that warning is stale advice, so swap in the note that applies.
  const hostComment = isLoopbackHost(host)
    ? `  # Loopback by default — the dashboard and HTTP API are unauthenticated unless
  # server.authToken or server.proxyAuth is set. To expose beyond localhost,
  # set host: 0.0.0.0 AND configure auth.\n`
    : `  # Bound beyond loopback, so every route is gated by server.authToken.
  # Put this behind a reverse proxy with TLS before exposing it to the internet.\n`;
  const uiBlock =
    d.ui === "disabled"
      ? "\n  ui:\n    enabled: false"
      : typeof d.ui === "object"
        ? `\n  ui:\n    provider: ${d.ui.customUri}`
        : "";
  const memoryBlock =
    typeof d.memory === "object" ? `\nmemory:\n  backend:\n    provider: ${d.memory.customUri}\n` : "";
  const systemPromptLine = d.systemPromptBaseFile ? `\n  systemPrompt:\n    baseFile: ${d.systemPromptBaseFile}` : "";
  return `# Tailored AI configuration
# Docs: https://github.com/quintonmiller/tailored-ai

server:
  port: ${port}
${hostComment}  host: ${host}${authTokenLine}${uiBlock}

database:
  path: ./agent.db

${providerBlock}

agent:
  defaultProvider: ${d.provider.kind}
  extraInstructions: ""
  temperature: 0.7
  maxToolRounds: 100
  maxHistoryTokens: 20000${systemPromptLine}

${toolsBlock}

channels:
  # Discord is the built-in channel. Plugin channels (Slack, Telegram, …) add
  # their own blocks under channels: keyed by id.
  discord:
    enabled: ${discordEnabled}
    token: \${DISCORD_BOT_TOKEN}
    owner: \${DISCORD_OWNER_ID}
    respondToDMs: true
    respondToMentions: true
${memoryBlock}
${pluginsBlock}
${externalAgentsBlock}
agents:
  researcher:
    instructions: >-
      You are a research assistant. Search the web, fetch pages,
      and summarize findings concisely.
    tools:${researcherSearchTool}
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

cron:
  enabled: false
  jobs: []

custom_tools: {}

webhooks:
  enabled: false

commands: {}
`;
}

/** Apply draft changes to the existing YAML document while preserving comments
 * and formatting. Returns both the new text and a human-readable list of
 * changes for dry-run display. */
export function patchExistingYaml(
  currentText: string,
  original: DraftConfig,
  edited: DraftConfig,
): { text: string; changes: string[] } {
  const doc = parseDocument(currentText);
  const changes: string[] = [];

  if (edited.provider.kind !== original.provider.kind) {
    doc.setIn(["agent", "defaultProvider"], edited.provider.kind);
    changes.push(`agent.defaultProvider: ${original.provider.kind} → ${edited.provider.kind}`);
  }
  if (edited.provider.defaultModel !== original.provider.defaultModel) {
    doc.setIn(["providers", edited.provider.kind, "defaultModel"], edited.provider.defaultModel);
    changes.push(
      `providers.${edited.provider.kind}.defaultModel: ${original.provider.defaultModel} → ${edited.provider.defaultModel}`,
    );
  }
  if (edited.provider.baseUrl && edited.provider.baseUrl !== original.provider.baseUrl) {
    doc.setIn(["providers", edited.provider.kind, "baseUrl"], edited.provider.baseUrl);
    changes.push(
      `providers.${edited.provider.kind}.baseUrl: ${original.provider.baseUrl ?? "(unset)"} → ${edited.provider.baseUrl}`,
    );
  }

  for (const key of Object.keys(edited.tools) as (keyof ToolsDraft)[]) {
    if (edited.tools[key] !== original.tools[key]) {
      doc.setIn(["tools", key, "enabled"], edited.tools[key]);
      changes.push(`tools.${key}.enabled: ${original.tools[key]} → ${edited.tools[key]}`);
    }
  }

  // Channels write through the generic `channels.<id>.enabled` map — no id is
  // special-cased. Union the keys so a newly-toggled channel still gets written.
  for (const id of new Set([...Object.keys(original.channels), ...Object.keys(edited.channels)])) {
    const was = Boolean(original.channels[id]);
    const now = Boolean(edited.channels[id]);
    if (now !== was) {
      doc.setIn(["channels", id, "enabled"], now);
      changes.push(`channels.${id}.enabled: ${was} → ${now}`);
    }
  }

  if (!slotEquals(edited.ui, original.ui)) {
    applyUiSlot(doc, edited.ui);
    changes.push(`server.ui: ${describeUi(original.ui)} → ${describeUi(edited.ui)}`);
  }

  if (!slotEquals(edited.memory, original.memory)) {
    applyMemorySlot(doc, edited.memory);
    changes.push(`memory.backend: ${describeMemory(original.memory)} → ${describeMemory(edited.memory)}`);
  }

  if (edited.systemPromptBaseFile !== original.systemPromptBaseFile) {
    applySystemPromptBaseFile(doc, edited.systemPromptBaseFile);
    changes.push(
      `agent.systemPrompt: ${describeSystemPromptBaseFile(original.systemPromptBaseFile)} → ${describeSystemPromptBaseFile(edited.systemPromptBaseFile)}`,
    );
  }

  const origPlugins = original.plugins.map((p) => p.uri);
  const newPlugins = edited.plugins.map((p) => p.uri);
  if (origPlugins.join("|") !== newPlugins.join("|")) {
    doc.setIn(["plugins"], newPlugins);
    changes.push(`plugins: [${origPlugins.join(", ")}] → [${newPlugins.join(", ")}]`);
  }

  const origAgents = original.externalAgents.map((p) => p.uri);
  const newAgents = edited.externalAgents.map((p) => p.uri);
  if (origAgents.join("|") !== newAgents.join("|")) {
    if (newAgents.length === 0) {
      doc.deleteIn(["externalAgents"]);
    } else {
      doc.setIn(["externalAgents"], newAgents);
    }
    changes.push(`externalAgents: [${origAgents.join(", ")}] → [${newAgents.join(", ")}]`);
  }

  return { text: doc.toString(), changes };
}

// ─── Dry-run output ───────────────────────────────────────────────────────────

function printDryRunPlan(plan: EditorPlan): void {
  console.log(`\n── Dry run — no files written ──`);
  if (plan.source === "new") {
    console.log(`Home directory: ${plan.homeDir}`);
    console.log(`\nconfig.yaml (${plan.configPath}):\n`);
    console.log(plan.configContent);
  } else {
    console.log(`Editing ${plan.configPath}`);
    if (plan.changes.length === 0) {
      console.log("\nNo changes.");
    } else {
      console.log("\nChanges:");
      for (const c of plan.changes) console.log(`  ${c}`);
    }
  }
  if (plan.envLines.length > 0) {
    console.log(`\n.env additions (${plan.envPath}):`);
    console.log(plan.envLines.join("\n"));
  }
  if (plan.plugins.length > 0) {
    console.log(`\nplugins:`);
    for (const pl of plan.plugins) {
      console.log(
        pl.resolveError
          ? `  ! ${pl.uri} — ${pl.resolveError}`
          : `  + ${pl.uri} (${pl.manifestId ?? "?"}@${pl.version ?? "?"})`,
      );
    }
  }
  console.log(`\nRe-run without --dry-run to apply.`);
}

// ─── Apply ────────────────────────────────────────────────────────────────────

function appendEnv(envPath: string, lines: string[]): void {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(envPath, `${existing}${sep}${lines.join("\n")}\n`, "utf-8");
}

// ─── Public entry: orchestrates Ink + apply ───────────────────────────────────

export async function runSetupWizard(
  defaultHomeDir: string,
  opts: { mode?: SetupMode; dryRun?: boolean; existingConfigPath?: string } = {},
): Promise<SetupResult> {
  const mode: SetupMode = opts.mode ?? "init";
  if (mode === "edit" && !opts.existingConfigPath) {
    throw new Error("runSetupWizard: mode=edit requires existingConfigPath");
  }

  // Dynamic import so Ink/React are only loaded when the editor actually runs
  // (e.g. `tai serve` shouldn't pay for them).
  const { runEditorApp } = await import("./editor/runEditorApp.js");
  const result = await runEditorApp({
    mode,
    defaultHomeDir,
    existingConfigPath: opts.existingConfigPath,
  });
  if (!result) {
    console.log("Cancelled.");
    process.exit(0);
  }

  const homeDir = result.draft.homeDir;
  const paths = resolveHomePaths(homeDir);
  const configPath = result.configPath ?? paths.configPath;
  const isExisting = Boolean(result.originalText);

  let configContent: string;
  let changes: string[] = [];
  if (isExisting && result.originalText) {
    const original = hydrateFromYaml(result.originalText, homeDir);
    const patch = patchExistingYaml(result.originalText, original, result.draft);
    configContent = patch.text;
    changes = patch.changes;
  } else {
    configContent = renderNewConfig(result.draft);
  }

  const plan: EditorPlan = {
    source: isExisting ? "existing" : "new",
    homeDir,
    configPath,
    envPath: paths.envPath,
    configContent,
    originalContent: result.originalText,
    changes,
    envLines: result.draft.envLines,
    plugins: result.draft.plugins,
  };

  if (opts.dryRun) {
    printDryRunPlan(plan);
    return { homeDir, configPath };
  }

  if (!isExisting) {
    await ensureHomeStructure(homeDir);
  }
  writeFileSync(configPath, configContent, "utf-8");
  if (plan.envLines.length > 0) {
    appendEnv(paths.envPath, plan.envLines);
  }
  console.log(isExisting ? "Edits applied." : `Setup complete! Data directory: ${homeDir}`);

  return { homeDir, configPath };
}

// Re-export for callers that need to resolve the home dir without invoking the
// editor (the CLI uses this for the `--init` flag handling).
export { resolve as resolvePath };
