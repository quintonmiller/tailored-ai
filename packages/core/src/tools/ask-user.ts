import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiscordChannel } from "../channels/discord.js";
import { ensureContextDir } from "../context.js";
import { getAutopilotSettings, isInQuietHours } from "../db/autopilot-queries.js";
import { addTaskComment, updateProjectTask } from "../db/task-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface AskUserToolOptions {
  contextDir: string;
  getDiscord: () => DiscordChannel | undefined;
  getOwnerId: () => string | undefined;
}

export class AskUserTool implements Tool {
  name = "ask_user";
  description = "Ask the user a question. Records in inbox.md and sends a Discord DM.";
  parameters = {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user.",
      },
    },
    required: ["question"],
  };

  private contextDir: string;
  private getDiscord: () => DiscordChannel | undefined;
  private getOwnerId: () => string | undefined;

  constructor(opts: AskUserToolOptions) {
    this.contextDir = opts.contextDir;
    this.getDiscord = opts.getDiscord;
    this.getOwnerId = opts.getOwnerId;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const question = args.question as string;
    if (!question) {
      return { success: false, output: "", error: "question is required." };
    }

    // Autopilot path: block the task, record the question as a comment, stop.
    if (context.autopilotTaskId && context.db) {
      try {
        addTaskComment(context.db, context.autopilotTaskId, {
          author: context.agentName ?? "agent",
          content: `**Question for user:** ${question}`,
        });
        updateProjectTask(context.db, context.autopilotTaskId, {
          status: "blocked",
          blocked_reason: "question",
        });
      } catch (err) {
        return { success: false, output: "", error: `Failed to block task: ${(err as Error).message}` };
      }

      const discord = this.getDiscord();
      const ownerId = this.getOwnerId();
      const settings = getAutopilotSettings(context.db);
      const quiet = isInQuietHours(settings);
      if (discord && ownerId && !quiet) {
        try {
          await discord.sendDM(ownerId, `Task ${context.autopilotTaskId} is blocked — agent needs input:\n${question}`);
        } catch {
          // Best-effort notification; don't fail the tool on DM failure.
        }
      }

      return {
        success: true,
        output: `Task ${context.autopilotTaskId} set to blocked(question). Stop working on this task now — the user will answer and resume it.`,
      };
    }

    const channels: string[] = [];
    const globalDir = resolve(this.contextDir, "global");
    await ensureContextDir(globalDir);

    // Append to inbox.md
    const inboxPath = resolve(globalDir, "inbox.md");
    const timestamp = new Date().toISOString();
    const entry = `\n[QUESTION] ${timestamp}\n${question}\n`;
    try {
      let existing = "";
      try {
        existing = await readFile(inboxPath, "utf-8");
      } catch {
        /* new file */
      }
      await writeFile(inboxPath, existing + entry, "utf-8");
      channels.push("inbox.md");
    } catch (err) {
      return { success: false, output: "", error: `Failed to write inbox: ${(err as Error).message}` };
    }

    // Send Discord DM if available
    const discord = this.getDiscord();
    const ownerId = this.getOwnerId();
    if (discord && ownerId) {
      try {
        await discord.sendDM(ownerId, `Question from autonomous agent:\n${question}`);
        channels.push("discord DM");
      } catch (err) {
        channels.push(`discord DM failed: ${(err as Error).message}`);
      }
    }

    return { success: true, output: `Question recorded via: ${channels.join(", ")}` };
  }
}
