import type { AgentRuntime, ChannelLifecycleManager, OutboundNotifier } from "@tailored-ai/core";

/**
 * Structural check for the outbound surface (id + send + sendDM). Any connected
 * channel that satisfies it — Discord, Slack, Telegram, … — gets published into
 * the runtime's outbound registry so channel-id consumers (cron, autopilot,
 * agent-notifier, workflows) resolve it by id at use time (#66). No channel id
 * is special-cased.
 */
export function isOutboundNotifier(ch: unknown): ch is OutboundNotifier {
  if (typeof ch !== "object" || ch === null) return false;
  const c = ch as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.send === "function" && typeof c.sendDM === "function";
}

/**
 * Reconcile the runtime's outbound registry against the live channel set.
 * Registers every connected channel that satisfies {@link isOutboundNotifier}
 * and unregisters ids that are no longer running. Idempotent — safe to call on
 * connect and on every reload. `registered` is mutated in place so the caller
 * can carry the registered-id set across reloads.
 */
export function syncOutboundRegistry(
  runtime: Pick<AgentRuntime, "registerOutbound" | "unregisterOutbound">,
  channelManager: Pick<ChannelLifecycleManager, "list">,
  registered: Set<string>,
): void {
  const live = new Set<string>();
  for (const started of channelManager.list()) {
    const ch = started.channel;
    if (!isOutboundNotifier(ch)) continue;
    live.add(ch.id);
    if (!registered.has(ch.id)) {
      runtime.registerOutbound(ch);
      registered.add(ch.id);
      console.log(`[channel:${ch.id}] Registered as outbound sink`);
    }
  }
  for (const id of [...registered]) {
    if (live.has(id)) continue;
    runtime.unregisterOutbound(id);
    registered.delete(id);
    console.log(`[channel:${id}] Unregistered outbound sink`);
  }
}
