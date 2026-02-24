import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiscordChannel } from "../channels/discord.js";
import { ensureContextDir } from "../context.js";
import type { Tool, ToolResult } from "./interface.js";

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

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const question = args.question as string;
    if (!question) {
      return { success: false, output: "", error: "question is required." };
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
