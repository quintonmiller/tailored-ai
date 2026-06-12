/**
 * Default owner notifier — the delivery seam for direct owner-DM
 * notifications that core used to send inline. Subscribes to the typed
 * runtime events `task.needs_human`, `digest.ready`, `question.asked`, and
 * `form.completed`, and delivers each to the deployment owner via the
 * primary channel — exactly what the autopilot worker, `ask_user` tool, and
 * `channel_message` workflow executor did by hand before.
 *
 * Why extract it:
 *
 * 1. Core stops *deciding* who to notify and how. The call sites now emit a
 *    structured "this needs the user" event; this plugin owns the channel /
 *    recipient resolution and the quiet-hours policy.
 * 2. A user who wants to ship somewhere else (Slack, Telegram, email, a
 *    pager) disables this plugin (`{ module: "builtin:owner-notifier",
 *    enabled: false }`) and writes their own subscriber against the same
 *    events. Same plugin shape an external author would use.
 *
 * Delivery target: the deployment's primary channel, resolved live at
 * delivery time from the runtime's outbound registry
 * (`runtime.resolveOutbound()` + `runtime.getOwnerId()`), so connect /
 * disconnect / config-reload swaps are picked up without rebuilding the
 * subscriber. When no channel is connected or no owner is configured,
 * delivery is a no-op (logged) — behavior-identical to the inline code.
 *
 * Quiet hours: the autopilot events (`task.needs_human`, and the autopilot
 * variant of `question.asked` — the one carrying a `taskId`) are suppressed
 * during autopilot quiet hours. The plugin reads
 * `getAutopilotSettings(runtime.db)` itself rather than trusting a flag on
 * the payload, keeping the policy in one place. Digests and out-of-autopilot
 * questions are never suppressed.
 */

import { getAutopilotSettings, isInQuietHours } from "../db/autopilot-queries.js";
import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";

export interface OwnerNotifierOptions {
  runtime: AgentRuntime;
}

export class OwnerNotifier {
  private runtime: AgentRuntime;
  private subscriptions: Subscription[] = [];

  constructor(opts: OwnerNotifierOptions) {
    this.runtime = opts.runtime;
    const events = this.runtime.events;
    this.subscriptions.push(
      events.on("task.needs_human", (e) => this.onNeedsHuman(e)),
      events.on("digest.ready", (e) => this.onDigest(e)),
      events.on("question.asked", (e) => this.onQuestion(e)),
      events.on("form.completed", (e) => this.onForm(e)),
    );
  }

  stop(): void {
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions = [];
  }

  private async onNeedsHuman(e: RuntimeEventPayload<"task.needs_human">): Promise<void> {
    if (this.isQuietHours()) {
      console.log(`[owner-notifier] Suppressing notification during quiet hours: ${e.message.slice(0, 80)}`);
      return;
    }
    await this.dmOwner(e.message, "[owner-notifier] Notify DM failed:");
  }

  private async onDigest(e: RuntimeEventPayload<"digest.ready">): Promise<void> {
    const out = this.runtime.resolveOutbound();
    const ownerId = this.runtime.getOwnerId();
    if (out && ownerId) {
      try {
        await out.sendDM(ownerId, e.content);
        console.log(`[owner-notifier] ${e.periodLabel} digest delivered via ${out.id} DM`);
      } catch (err) {
        console.error("[owner-notifier] Digest DM failed:", (err as Error).message);
      }
    } else {
      console.log(`[owner-notifier] ${e.periodLabel} digest (no delivery target):\n${e.content}`);
    }
  }

  private async onQuestion(e: RuntimeEventPayload<"question.asked">): Promise<void> {
    // Autopilot question: the task is already blocked on `question`. Suppress
    // during quiet hours, best-effort delivery (don't surface DM failures).
    if (e.taskId) {
      if (this.isQuietHours()) {
        console.log(`[owner-notifier] Suppressing task question during quiet hours: ${e.question.slice(0, 80)}`);
        return;
      }
      const out = this.runtime.resolveOutbound();
      const ownerId = this.runtime.getOwnerId();
      if (out && ownerId) {
        try {
          await out.sendDM(ownerId, `Task ${e.taskId} is blocked — agent needs input:\n${e.question}`);
        } catch {
          // Best-effort notification; the question is already recorded as a comment.
        }
      }
      return;
    }

    // Out-of-autopilot question: always deliver (the inbox file already has it).
    const out = this.runtime.resolveOutbound();
    const ownerId = this.runtime.getOwnerId();
    if (out && ownerId) {
      try {
        await out.sendDM(ownerId, `Question from autonomous agent:\n${e.question}`);
      } catch (err) {
        console.error("[owner-notifier] Question DM failed:", (err as Error).message);
      }
    }
  }

  private async onForm(e: RuntimeEventPayload<"form.completed">): Promise<void> {
    const out = this.runtime.resolveOutbound();
    const ownerId = this.runtime.getOwnerId();
    if (!out) {
      console.log(`[owner-notifier] form message — no outbound channel connected; would have sent: ${e.message}`);
      return;
    }
    if (!ownerId) {
      console.log(`[owner-notifier] form message — no owner configured; would have sent: ${e.message}`);
      return;
    }
    await out.sendDM(ownerId, e.message);
  }

  private isQuietHours(): boolean {
    const settings = getAutopilotSettings(this.runtime.db);
    return isInQuietHours(settings);
  }

  private async dmOwner(message: string, errPrefix: string): Promise<void> {
    const out = this.runtime.resolveOutbound();
    const ownerId = this.runtime.getOwnerId();
    if (!out || !ownerId) return;
    try {
      await out.sendDM(ownerId, message);
    } catch (err) {
      console.error(errPrefix, (err as Error).message);
    }
  }
}

/**
 * Default-plugin entry point — loaded via `config.plugins:
 * builtin:owner-notifier`. Constructs an {@link OwnerNotifier} bound to the
 * live runtime and returns a disposer so the loader tears down its
 * subscriptions on shutdown / reload.
 *
 * `ctx.config` is intentionally unused: delivery resolves through the
 * runtime's primary channel + owner at delivery time, with no separate
 * per-plugin knob.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const notifier = new OwnerNotifier({ runtime: ctx.runtime });
  return () => notifier.stop();
};
export const meta: PluginMeta = {
  name: "Owner notifier",
  description:
    "Delivers task.needs_human, digest.ready, question.asked, and form.completed events to the deployment owner.",
  registers: [{ kind: "eventSubscriber", id: "owner-notifier" }],
};

export default plugin;
