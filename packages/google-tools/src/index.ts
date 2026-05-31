/**
 * @tailored-ai/google-tools
 *
 * Imports register Gmail / GoogleCalendar / GoogleDrive into
 * @tailored-ai/core's tool-factory registry. The user opts in by adding the
 * package to their dependencies and importing it once before runtime
 * construction:
 *
 *   import "@tailored-ai/google-tools";
 *   const runtime = new AgentRuntime({ ... });
 *
 * Config blocks (`tools.gmail.enabled`, etc.) still gate whether each tool
 * actually instantiates. The factories register unconditionally; they only
 * produce tools when the user opts in.
 *
 * The tools shell out to the `gog` CLI (https://github.com/quintonmiller/gog)
 * for OAuth + transport. `GOG_KEYRING_PASSWORD` from the environment unlocks
 * stored credentials.
 */
import { registerToolFactory } from "@tailored-ai/core";
import type Database from "better-sqlite3";
import { GmailTool } from "./gmail.js";
import { GoogleCalendarTool } from "./google-calendar.js";
import { GoogleDriveTool } from "./google-drive.js";

export { GmailTool, GoogleCalendarTool, GoogleDriveTool };

function gogPassword(): string {
  return process.env.GOG_KEYRING_PASSWORD ?? "";
}

registerToolFactory("gmail", (config, ctx) => {
  const cfg = config.tools.gmail;
  if (!cfg?.enabled) return [];
  if (!cfg.account) {
    console.warn("[google-tools:gmail] tools.gmail.enabled is true but account is empty; skipping");
    return [];
  }
  return [new GmailTool(cfg.account, gogPassword(), ctx.db as Database.Database | undefined)];
});

registerToolFactory("google_calendar", (config) => {
  const cfg = config.tools.google_calendar;
  if (!cfg?.enabled) return [];
  if (!cfg.account) {
    console.warn("[google-tools:google_calendar] tools.google_calendar.enabled is true but account is empty; skipping");
    return [];
  }
  return [new GoogleCalendarTool(cfg.account, gogPassword())];
});

registerToolFactory("google_drive", (config, ctx) => {
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
      ctx.configPath as string | undefined,
    ),
  ];
});
