import type { OutboundNotifier } from "../../channels/outbound.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import { resolveString } from "../scope.js";
import type { NotifyStep, WorkflowStepDef } from "../types.js";

/**
 * Backend that delivers email notifications. Plumbed through here so the
 * notify executor can stay channel-agnostic — once the EmailBackend bean
 * lands (Tier-S), the CLI wires its instance through `getEmail` and email
 * channels start working without changes to this executor.
 */
export interface EmailSender {
  send(opts: { to: string[]; subject: string; body: string }): Promise<void>;
}

export interface NotifyExecutorOptions {
  /** Resolve the outbound notifier for an optional channel id (default channel when absent). */
  resolveOutbound: (channelId?: string) => OutboundNotifier | undefined;
  /** Returns the configured owner user id for a channel, the default DM target. */
  getOwnerId: (channelId?: string) => string | undefined;
  /** Default email recipients when `to` is omitted on the step. */
  getDefaultEmailRecipients?: () => string[];
  /** Email sender, optional — when absent, email channel surfaces a clear error. */
  getEmail?: () => EmailSender | undefined;
  /** Override for the log channel (defaults to console.log). Useful in tests. */
  log?: (message: string) => void;
}

/**
 * Multi-channel notification dispatcher. `email` goes through the optional
 * EmailSender; `log` just writes to stdout (cheap default + handy for
 * dry-runs); every other channel string resolves an outbound notifier from the
 * runtime's registry and posts/DMs through it.
 */
export class NotifyExecutor implements StepExecutor {
  type = "notify" as const;
  private resolveOutbound: (channelId?: string) => OutboundNotifier | undefined;
  private getOwnerId: (channelId?: string) => string | undefined;
  private getEmail?: () => EmailSender | undefined;
  private getDefaultRecipients?: () => string[];
  private log: (message: string) => void;

  constructor(opts: NotifyExecutorOptions) {
    this.resolveOutbound = opts.resolveOutbound;
    this.getOwnerId = opts.getOwnerId;
    this.getEmail = opts.getEmail;
    this.getDefaultRecipients = opts.getDefaultEmailRecipients;
    this.log = opts.log ?? ((m: string) => console.log(`[notify] ${m}`));
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as NotifyStep;
    const message = String(resolveString(s.message, ctx.scope) ?? "");
    if (ctx.dryRun) {
      this.log(`[dry-run] would send via ${s.channel}: ${message}`);
      return { output: { delivered: "dry-run", channel: s.channel, message } };
    }
    switch (s.channel) {
      case "email":
        return this.dispatchEmail(s, ctx, message);
      case "log":
        this.log(message);
        return { output: { delivered: "log", message } };
      default:
        return this.dispatchChannel(s, ctx, message);
    }
  }

  private async dispatchChannel(s: NotifyStep, ctx: StepContext, message: string): Promise<StepResult> {
    const out = this.resolveOutbound(s.channel);
    if (!out) {
      throw new Error(`notify "${s.name}": channel "${s.channel}" is not connected`);
    }
    if (s.channelId) {
      const channelId = String(resolveString(s.channelId, ctx.scope) ?? "");
      await out.send(channelId, message);
      return { output: { delivered: "channel-post", target: channelId, message } };
    }
    const explicit = s.userId ? String(resolveString(s.userId, ctx.scope) ?? "") : undefined;
    const userId = explicit || this.getOwnerId(s.channel);
    if (!userId) {
      throw new Error(`notify "${s.name}": no channelId or userId provided and no owner configured for "${s.channel}"`);
    }
    await out.sendDM(userId, message);
    return { output: { delivered: "channel-dm", target: userId, message } };
  }

  private async dispatchEmail(s: NotifyStep, ctx: StepContext, message: string): Promise<StepResult> {
    const email = this.getEmail?.();
    if (!email) {
      throw new Error(`notify "${s.name}": email channel selected but no email backend is configured`);
    }
    const toRaw = s.to ? String(resolveString(s.to, ctx.scope) ?? "") : "";
    const explicit = toRaw
      .split(",")
      .map((addr) => addr.trim())
      .filter(Boolean);
    const to = explicit.length > 0 ? explicit : (this.getDefaultRecipients?.() ?? []);
    if (to.length === 0) {
      throw new Error(`notify "${s.name}": email channel requires "to" or a default recipient list`);
    }
    const subject = s.subject ? String(resolveString(s.subject, ctx.scope) ?? "") : "Workflow notification";
    await email.send({ to, subject, body: message });
    return { output: { delivered: "email", target: to.join(","), message } };
  }
}
