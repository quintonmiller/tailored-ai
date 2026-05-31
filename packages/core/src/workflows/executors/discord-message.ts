import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import { resolveString } from "../scope.js";
import type { DiscordMessageStep, WorkflowStepDef } from "../types.js";

/**
 * Subset of DiscordChannel surface this executor depends on. Aliased to
 * `OutboundNotifier` so any notifier registered through the channel registry
 * (Slack, Telegram, …) satisfies this contract too. The `id` field on the
 * full interface is unused here so we relax it to optional.
 */
export type DiscordSender = Pick<import("../../channels/outbound.js").OutboundNotifier, "send" | "sendDM">;

export interface DiscordMessageExecutorOptions {
  /** Returns the active DiscordChannel, or undefined when Discord isn't connected. */
  getDiscord: () => DiscordSender | undefined;
  /** Returns the configured owner user id, used as the default DM target. */
  getOwnerId: () => string | undefined;
}

/**
 * Sends a Discord message. Target precedence: explicit channelId → explicit
 * userId DM → owner DM. Skips with a clear error when Discord isn't connected,
 * so workflows that branch on Discord availability stay debuggable.
 */
export class DiscordMessageExecutor implements StepExecutor {
  type = "discord_message" as const;
  private getDiscord: () => DiscordSender | undefined;
  private getOwnerId: () => string | undefined;

  constructor(opts: DiscordMessageExecutorOptions) {
    this.getDiscord = opts.getDiscord;
    this.getOwnerId = opts.getOwnerId;
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as DiscordMessageStep;
    const message = String(resolveString(s.message, ctx.scope) ?? "");

    if (ctx.dryRun) {
      console.log(`[dry-run] discord_message "${s.name}": ${message}`);
      return { output: { delivered: "dry-run", message } };
    }

    const discord = this.getDiscord();
    if (!discord) {
      throw new Error(`discord_message "${s.name}": Discord channel is not connected`);
    }

    if (s.channelId) {
      const channelId = String(resolveString(s.channelId, ctx.scope) ?? "");
      await discord.send(channelId, message);
      return { output: { delivered: "channel", target: channelId, message } };
    }

    const explicitUser = s.userId ? String(resolveString(s.userId, ctx.scope) ?? "") : undefined;
    const userId = explicitUser || this.getOwnerId();
    if (!userId) {
      throw new Error(`discord_message "${s.name}": no channelId or userId provided and no owner configured`);
    }
    await discord.sendDM(userId, message);
    return { output: { delivered: "dm", target: userId, message } };
  }
}
