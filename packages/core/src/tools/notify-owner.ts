import type { OutboundNotifier } from "../channels/outbound.js";
import { type NotificationGateLike, resolveGate } from "../notifications/dedup.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Outbound owner DM through the default communication channel. Lets an
 * online/background agent push a message to the configured owner without
 * going through email. Pairs naturally with `gmail send` for online ticks
 * that need to escalate something the user isn't actively chatting about.
 *
 * Sends to the owner by default (no recipient required). A `user_id`
 * override is accepted but currently unconstrained; a `channel` override
 * selects a non-default outbound channel.
 */
export class NotifyOwnerTool implements Tool {
  name = "notify_owner";
  description = "Send a direct message to the owner through the default channel. Use to push an unsolicited update.";
  parameters = {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message body. Markdown allowed. Long messages are auto-split.",
      },
      user_id: {
        type: "string",
        description: "Optional recipient id on the channel. Defaults to the configured owner.",
      },
      channel: {
        type: "string",
        description: "Optional outbound channel id override. Defaults to the default channel.",
      },
    },
    required: ["message"],
  };

  constructor(
    private resolveOutbound: (channelId?: string) => OutboundNotifier | undefined,
    private getOwnerId: (channelId?: string) => string | undefined,
    /** Repeat gate. Omitted in tests / embeddings where no db is available. */
    private getGate?: () => NotificationGateLike | undefined,
  ) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const message = args.message as string | undefined;
    if (!message || typeof message !== "string") {
      return { success: false, output: "", error: "message is required and must be a string." };
    }

    const channel = args.channel as string | undefined;
    const out = this.resolveOutbound(channel);
    if (!out) {
      return {
        success: false,
        output: "",
        error: "no outbound channel is connected.",
      };
    }

    const target = (args.user_id as string | undefined) ?? this.getOwnerId(channel);
    if (!target) {
      return {
        success: false,
        output: "",
        error: `no owner is configured for channel ${out.id}. Pass user_id or set channels.${out.id}.owner in config.`,
      };
    }

    // Repeat-gate only the unprompted case. A background tick or autopilot run
    // is the agent deciding on its own that the user should hear something, and
    // that is what repeats. When the user is present and asked for something,
    // send it however many times they ask.
    const proactive = Boolean(context.exploratoryRunId || context.autopilotTaskId);
    const gate = proactive ? resolveGate(this.getGate) : undefined;

    try {
      if (gate) {
        const decision = await gate.deliver(
          {
            source: `tool:notify_owner:${context.agentName ?? "unknown"}`,
            channel: out.id,
            target,
            content: message,
          },
          () => out.sendDM(target, message),
          (msg) => console.log(msg),
        );
        if (!decision.send) {
          return {
            success: true,
            output:
              `Not sent — the owner already received this ${decision.firstSentAt ? `on ${decision.firstSentAt}` : "recently"}. ` +
              `Say something new, or leave it for the next digest.`,
          };
        }
        return { success: true, output: `Sent DM to ${target} (${message.length} chars).` };
      }
      await out.sendDM(target, message);
      return { success: true, output: `Sent DM to ${target} (${message.length} chars).` };
    } catch (err) {
      return { success: false, output: "", error: `sendDM failed: ${(err as Error).message}` };
    }
  }
}
