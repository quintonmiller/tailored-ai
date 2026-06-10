import type { OutboundNotifier } from "../channels/outbound.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Outbound Discord DM. Lets an online/background agent push a message to
 * the configured owner without going through email. Pairs naturally with
 * `gmail send` for online ticks that need to escalate something the user
 * isn't actively chatting about.
 *
 * Sends to the owner by default (no recipient required). A `user_id`
 * override is accepted but currently unconstrained — config-level
 * restriction can be layered on later if needed.
 */
export class DiscordDmTool implements Tool {
  name = "discord_dm";
  description = "Send a Discord DM to the owner. Use to push an unsolicited update without email.";
  parameters = {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message body. Markdown allowed. Long messages are auto-split.",
      },
      user_id: {
        type: "string",
        description: "Optional recipient Discord user id. Defaults to the configured owner.",
      },
    },
    required: ["message"],
  };

  constructor(
    private getDiscord: () => OutboundNotifier | undefined,
    private getOwnerId: () => string | undefined,
  ) {}

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const message = args.message as string | undefined;
    if (!message || typeof message !== "string") {
      return { success: false, output: "", error: "message is required and must be a string." };
    }

    const discord = this.getDiscord();
    if (!discord) {
      return {
        success: false,
        output: "",
        error: "Discord channel is not connected. Enable channels.discord in config.",
      };
    }

    const target = (args.user_id as string | undefined) ?? this.getOwnerId();
    if (!target) {
      return {
        success: false,
        output: "",
        error: "No recipient: pass user_id or set channels.discord.owner in config.",
      };
    }

    try {
      await discord.sendDM(target, message);
      return { success: true, output: `Sent DM to ${target} (${message.length} chars).` };
    } catch (err) {
      return { success: false, output: "", error: `sendDM failed: ${(err as Error).message}` };
    }
  }
}
