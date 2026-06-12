/**
 * @tailored-ai/google-tools
 *
 * Packaged as a `register(ctx)` plugin (#47). The host invokes the default
 * export with a {@link PluginContext} during runtime construction; the plugin
 * registers Gmail / GoogleCalendar / GoogleDrive into `ctx.tools`. Config
 * blocks (`tools.gmail.enabled`, etc.) gate whether each tool actually
 * instantiates per agent. The shapes are owned here — core's `tools` config
 * is an open map and knows nothing about these ids.
 *
 * Add to `config.yaml`:
 *
 *     plugins:
 *       - "@tailored-ai/google-tools"
 *     tools:
 *       gmail:
 *         enabled: true
 *         account: you@example.com
 *
 * The tools shell out to the `gog` CLI (https://github.com/quintonmiller/gog)
 * for OAuth + transport. `GOG_KEYRING_PASSWORD` from the environment unlocks
 * stored credentials.
 */
import type { AgentConfig, Plugin, PluginMeta } from "@tailored-ai/core";
import type Database from "better-sqlite3";
import { GmailTool } from "./gmail.js";
import { GoogleCalendarTool } from "./google-calendar.js";
import { GoogleDriveTool } from "./google-drive.js";

export { GmailTool, GoogleCalendarTool, GoogleDriveTool };

function gogPassword(): string {
  return process.env.GOG_KEYRING_PASSWORD ?? "";
}

/** Config shape this plugin reads from `tools.gmail` / `tools.google_calendar` / `tools.google_drive`. */
interface GoogleToolConfig {
  enabled?: boolean;
  account?: string;
  folder_name?: string;
  folder_id?: string;
}

const plugin: Plugin = (ctx) => {
  ctx.tools.register("gmail", (config, toolCtx) => {
    const cfg = config.tools.gmail as GoogleToolConfig | undefined;
    if (!cfg?.enabled) return [];
    if (!cfg.account) {
      console.warn("[google-tools:gmail] tools.gmail.enabled is true but account is empty; skipping");
      return [];
    }
    return [new GmailTool(cfg.account, gogPassword(), toolCtx.db as Database.Database | undefined)];
  });

  ctx.tools.register("google_calendar", (config) => {
    const cfg = config.tools.google_calendar as GoogleToolConfig | undefined;
    if (!cfg?.enabled) return [];
    if (!cfg.account) {
      console.warn(
        "[google-tools:google_calendar] tools.google_calendar.enabled is true but account is empty; skipping",
      );
      return [];
    }
    return [new GoogleCalendarTool(cfg.account, gogPassword())];
  });

  ctx.tools.register("google_drive", (config, toolCtx) => {
    const cfg = config.tools.google_drive as GoogleToolConfig | undefined;
    if (!cfg?.enabled) return [];
    if (!cfg.account) {
      console.warn("[google-tools:google_drive] tools.google_drive.enabled is true but account is empty; skipping");
      return [];
    }
    return [
      new GoogleDriveTool(
        cfg.account,
        gogPassword(),
        cfg.folder_name,
        cfg.folder_id,
        toolCtx.configPath as string | undefined,
      ),
    ];
  });
};

export const meta: PluginMeta = {
  name: "Google tools",
  description: "Gmail, Google Calendar, and Google Drive tools via the gog CLI.",
  registers: [
    { kind: "tool", id: "gmail", configKey: "tools.gmail" },
    { kind: "tool", id: "google_calendar", configKey: "tools.google_calendar" },
    { kind: "tool", id: "google_drive", configKey: "tools.google_drive" },
  ],
};

const GOOGLE_TOOL_IDS = ["gmail", "google_calendar", "google_drive"] as const;

/** Plugin-owned config checks — the shapes live here, not in core (#229). */
export function validateConfig(config: AgentConfig): string[] {
  const warnings: string[] = [];
  let anyEnabled = false;
  for (const id of GOOGLE_TOOL_IDS) {
    const cfg = config.tools[id] as GoogleToolConfig | undefined;
    if (!cfg?.enabled) continue;
    anyEnabled = true;
    if (!cfg.account) {
      warnings.push(`tools.${id}.enabled is true but account is empty — the tool will be skipped`);
    }
  }
  if (anyEnabled && !process.env.GOG_KEYRING_PASSWORD) {
    warnings.push("GOG_KEYRING_PASSWORD is not set — gog CLI calls will fail to unlock stored credentials");
  }
  return warnings;
}

export default plugin;
