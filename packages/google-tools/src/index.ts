/**
 * @tailored-ai/google-tools
 *
 * Gmail / Google Calendar / Google Drive as TAI tools, packaged as a
 * register(ctx) plugin (#47). Users add the package to their config:
 *
 *   plugins:
 *     - "@tailored-ai/google-tools"
 *
 * On runtime construction the host invokes the plugin's `default(ctx)`
 * which registers the three tool factories into the runtime's tool registry.
 * Config blocks (`tools.gmail.enabled`, etc.) still gate whether each tool
 * actually instantiates.
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
