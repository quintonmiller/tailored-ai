import type { OutboundNotifier } from "../../channels/outbound.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import { resolveString } from "../scope.js";
import type { ChannelMessageStep, WorkflowStepDef } from "../types.js";

export interface ChannelMessageExecutorOptions {
  /**
   * Resolve the outbound notifier for an optional channel id, falling back to
   * the default channel when none is given. Returns undefined when no channel
   * is connected.
   */
  resolveOutbound: (channelId?: string) => OutboundNotifier | undefined;
  /** Returns the configured owner user id for a channel, the default DM target. */
  getOwnerId: (channelId?: string) => string | undefined;
}

/**
 * Sends a message through a communication channel. Target precedence: explicit
 * channelId → explicit userId DM → owner DM. Skips with a clear error when no
 * channel is connected, so workflows that branch on channel availability stay
 * debuggable.
 */
export class ChannelMessageExecutor implements StepExecutor {
  type = "channel_message" as const;
  private resolveOutbound: (channelId?: string) => OutboundNotifier | undefined;
  private getOwnerId: (channelId?: string) => string | undefined;

  constructor(opts: ChannelMessageExecutorOptions) {
    this.resolveOutbound = opts.resolveOutbound;
    this.getOwnerId = opts.getOwnerId;
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as ChannelMessageStep;
    const message = String(resolveString(s.message, ctx.scope) ?? "");

    if (ctx.dryRun) {
      console.log(`[dry-run] channel_message "${s.name}": ${message}`);
      return { output: { delivered: "dry-run", message } };
    }

    const out = this.resolveOutbound(s.channel);
    if (!out) {
      throw new Error(`channel_message "${s.name}": no outbound channel is connected`);
    }

    if (s.channelId) {
      const channelId = String(resolveString(s.channelId, ctx.scope) ?? "");
      await out.send(channelId, message);
      return { output: { delivered: "channel", target: channelId, message } };
    }

    const explicitUser = s.userId ? String(resolveString(s.userId, ctx.scope) ?? "") : undefined;
    const userId = explicitUser || this.getOwnerId(s.channel);
    if (!userId) {
      throw new Error(`channel_message "${s.name}": no channelId or userId provided and no owner configured`);
    }
    await out.sendDM(userId, message);
    return { output: { delivered: "dm", target: userId, message } };
  }
}
