/**
 * @tailored-ai/google-tools
 *
 * Packaged as a `register(ctx)` plugin (#47). The host invokes the default
 * export with a {@link PluginContext} during runtime construction; the plugin
 * registers Gmail / GoogleCalendar / GoogleDrive into `ctx.tools`. Config
 * blocks (`tools.gmail.enabled`, etc.) gate whether each tool actually
 * instantiates per agent.
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
import type { Plugin } from "@tailored-ai/core";
import type Database from "better-sqlite3";
import { GmailTool } from "./gmail.js";
import { GoogleCalendarTool } from "./google-calendar.js";
import { GoogleDriveTool } from "./google-drive.js";

export { GmailTool, GoogleCalendarTool, GoogleDriveTool };

function gogPassword(): string {
  return process.env.GOG_KEYRING_PASSWORD ?? "";
}

const plugin: Plugin = (ctx) => {
  ctx.tools.register("gmail", (config, toolCtx) => {
    const cfg = config.tools.gmail;
    if (!cfg?.enabled) return [];
    if (!cfg.account) {
      console.warn("[google-tools:gmail] tools.gmail.enabled is true but account is empty; skipping");
      return [];
    }
    return [new GmailTool(cfg.account, gogPassword(), toolCtx.db as Database.Database | undefined)];
  });

  ctx.tools.register("google_calendar", (config) => {
    const cfg = config.tools.google_calendar;
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
    const cfg = config.tools.google_drive;
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

export default plugin;
